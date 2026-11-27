import {
  type IntegrationError,
  RateLimitedError,
  UpstreamError,
  errorFromStatus,
  isIntegrationError,
} from '../errors.js';
import { type Clock, type Sleep, sleep as defaultSleep, systemClock } from '../internal/time.js';
import { type BackoffOptions, exponentialBackoff, parseRetryAfter } from './backoff.js';
import type { PaginationStrategy } from './pagination.js';
import type { TokenBucket } from './rate-limiter.js';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export type QueryValue = string | number | boolean | undefined;

export interface HttpRequest {
  method?: HttpMethod;
  /** Path relative to `baseUrl`, or an absolute URL on the same origin (e.g. a `Link` header). */
  path: string;
  query?: Record<string, QueryValue>;
  /** Serialized as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Retries are only automatic for idempotent methods. Set `true` to opt a POST/PATCH in, which
   * is only safe if the provider supports idempotency keys and you send one.
   */
  retry?: boolean;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  url: string;
}

/** Supplies bearer tokens. `TokenManager.forConnection()` returns one. */
export interface AccessTokenSource {
  getAccessToken(): Promise<string>;
  /**
   * Called once after a 401 with the token that was rejected, so the next attempt uses a fresh
   * one. Implementations should skip the refresh if that token has already been replaced.
   */
  refreshAccessToken?(rejectedAccessToken: string): Promise<string>;
}

export interface ErrorContext {
  provider: string | undefined;
  status: number;
  headers: Headers;
  body: unknown;
  retryAfterMs: number | undefined;
}

/**
 * Maps a provider's error response to a typed error. Return `undefined` to fall back to the
 * default status-code mapping.
 */
export type ErrorNormalizer = (context: ErrorContext) => IntegrationError | undefined;

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  error: IntegrationError;
  request: HttpRequest;
}

export interface RetryOptions extends BackoffOptions {
  /** Total attempts including the first. Default 4. */
  maxAttempts?: number | undefined;
  /**
   * If the provider asks us to wait longer than this, fail fast with `RateLimitedError` instead
   * of holding the caller. Default 60 s.
   */
  maxRetryAfterMs?: number | undefined;
}

export interface HttpClientOptions {
  baseUrl: string;
  /** Used in error messages and passed to the error normalizer. */
  provider?: string | undefined;
  auth?: AccessTokenSource | undefined;
  rateLimiter?: TokenBucket | undefined;
  retry?: RetryOptions | undefined;
  /** Per-attempt timeout. Default 30 s. */
  timeoutMs?: number | undefined;
  headers?: Record<string, string> | undefined;
  normalizeError?: ErrorNormalizer | undefined;
  onRetry?: ((event: RetryEvent) => void) | undefined;
  fetch?: typeof fetch | undefined;
  clock?: Clock | undefined;
  sleep?: Sleep | undefined;
  random?: (() => number) | undefined;
}

const IDEMPOTENT = new Set<HttpMethod>(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

/**
 * Outbound HTTP client with one consistent reliability policy: rate limiting, timeouts,
 * retries with jittered backoff, `Retry-After`, one token refresh on 401, and normalized errors.
 */
export class HttpClient {
  readonly #baseUrl: URL;
  readonly #provider: string | undefined;
  readonly #auth: AccessTokenSource | undefined;
  readonly #limiter: TokenBucket | undefined;
  readonly #maxAttempts: number;
  readonly #maxRetryAfterMs: number;
  readonly #backoff: BackoffOptions;
  readonly #timeoutMs: number;
  readonly #headers: Record<string, string>;
  readonly #normalizeError: ErrorNormalizer | undefined;
  readonly #onRetry: ((event: RetryEvent) => void) | undefined;
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #sleep: Sleep;
  readonly #random: () => number;

  constructor(options: HttpClientOptions) {
    this.#baseUrl = new URL(
      options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`,
    );
    this.#provider = options.provider;
    this.#auth = options.auth;
    this.#limiter = options.rateLimiter;
    this.#maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 4);
    this.#maxRetryAfterMs = options.retry?.maxRetryAfterMs ?? 60_000;
    this.#backoff = { baseMs: options.retry?.baseMs, maxMs: options.retry?.maxMs };
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#headers = options.headers ?? {};
    this.#normalizeError = options.normalizeError;
    this.#onRetry = options.onRetry;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  get<T = unknown>(
    path: string,
    request: Omit<HttpRequest, 'path' | 'method'> = {},
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ ...request, path, method: 'GET' });
  }

  post<T = unknown>(
    path: string,
    request: Omit<HttpRequest, 'path' | 'method'> = {},
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ ...request, path, method: 'POST' });
  }

  async request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    const method = request.method ?? 'GET';
    const retryable = request.retry ?? IDEMPOTENT.has(method);
    const url = this.#resolveUrl(request);
    let refreshedAfter401 = false;

    for (let attempt = 1; ; attempt++) {
      let error: IntegrationError;
      let retryAfterMs: number | undefined;
      try {
        await this.#limiter?.acquire(request.signal);
        const token = this.#auth ? await this.#auth.getAccessToken() : undefined;
        const response = await this.#send(method, url, request, token);
        const body = await readBody(response);
        if (response.ok) {
          return { status: response.status, headers: response.headers, data: body as T, url };
        }
        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.#clock.now());
        error = this.#toError(response, body, retryAfterMs);

        // An expired-but-not-yet-refreshed token: refresh once, then repeat immediately.
        if (
          response.status === 401 &&
          token !== undefined &&
          this.#auth?.refreshAccessToken &&
          !refreshedAfter401
        ) {
          refreshedAfter401 = true;
          await this.#auth.refreshAccessToken(token);
          attempt--;
          continue;
        }
      } catch (caught) {
        if (request.signal?.aborted) throw caught;
        if (isIntegrationError(caught) && caught.kind === 'auth') throw caught;
        error = isIntegrationError(caught)
          ? caught
          : new UpstreamError(
              `${this.#provider ?? 'Provider'} request failed: ${describe(caught)}`,
              {
                provider: this.#provider,
                cause: caught,
              },
            );
      }

      const hinted = error instanceof RateLimitedError ? error.retryAfterMs : undefined;
      const requestedDelay = hinted ?? retryAfterMs;
      if (requestedDelay !== undefined) this.#limiter?.pause(requestedDelay);

      const canRetry =
        retryable &&
        error.retryable &&
        attempt < this.#maxAttempts &&
        (requestedDelay === undefined || requestedDelay <= this.#maxRetryAfterMs);
      if (!canRetry) throw error;

      const delayMs = requestedDelay ?? exponentialBackoff(attempt, this.#backoff, this.#random);
      this.#onRetry?.({ attempt, delayMs, error, request });
      await this.#sleep(delayMs, request.signal);
    }
  }

  /**
   * Iterates over every item across all pages. Pages are fetched lazily, so breaking out of the
   * loop stops further requests.
   */
  async *paginate<T>(
    request: HttpRequest,
    strategy: PaginationStrategy<T>,
    options: { maxPages?: number } = {},
  ): AsyncGenerator<T, void, undefined> {
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    let next: HttpRequest | undefined = strategy.first?.(request) ?? request;
    for (let page = 0; next !== undefined && page < maxPages; page++) {
      const response: HttpResponse = await this.request(next);
      yield* strategy.items(response);
      next = strategy.next(response, next);
    }
  }

  async #send(
    method: HttpMethod,
    url: string,
    request: HttpRequest,
    token: string | undefined,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.#headers,
      ...request.headers,
    };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      headers['content-type'] ??= 'application/json';
    }

    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new Error(`timed out after ${this.#timeoutMs} ms`));
    }, this.#timeoutMs);
    const onAbort = (): void => {
      timeout.abort(request.signal?.reason);
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.#fetch(url, {
        method,
        headers,
        signal: timeout.signal,
        ...(body === undefined ? {} : { body }),
      });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  #resolveUrl(request: HttpRequest): string {
    const url = new URL(request.path.replace(/^\//, ''), this.#baseUrl);
    // Never send credentials to a host the integration was not configured for, even if a
    // provider response (e.g. a pagination link) points there.
    if (url.origin !== this.#baseUrl.origin) {
      throw new UpstreamError(`Refusing to call ${url.origin}: not the configured origin`, {
        provider: this.#provider,
        retryable: false,
      });
    }
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  #toError(response: Response, body: unknown, retryAfterMs: number | undefined): IntegrationError {
    const context: ErrorContext = {
      provider: this.#provider,
      status: response.status,
      headers: response.headers,
      body,
      retryAfterMs,
    };
    return (
      this.#normalizeError?.(context) ??
      errorFromStatus(response.status, {
        provider: this.#provider,
        details: body,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      })
    );
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}
