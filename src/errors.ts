/**
 * Normalized error taxonomy. Every provider failure is mapped onto one of these kinds so that
 * business logic can branch on meaning ("reconnect the account", "try later") instead of on a
 * vendor's status codes and error bodies.
 */
export type IntegrationErrorKind =
  'auth' | 'rate_limited' | 'not_found' | 'validation' | 'upstream';

export interface IntegrationErrorOptions {
  provider?: string | undefined;
  status?: number | undefined;
  /** Provider-specific error code, if the provider returned one. */
  code?: string | undefined;
  /** Parsed (or raw) response body, kept for logging and debugging. */
  details?: unknown;
  cause?: unknown;
}

export abstract class IntegrationError extends Error {
  abstract readonly kind: IntegrationErrorKind;
  /** Whether repeating the same request later could reasonably succeed. */
  abstract readonly retryable: boolean;
  readonly provider: string | undefined;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(message: string, options: IntegrationErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.provider = options.provider;
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
  }
}

/** Credentials are missing, expired or rejected (HTTP 401/403). */
export class AuthError extends IntegrationError {
  readonly kind = 'auth';
  readonly retryable = false;
}

/**
 * The refresh token was revoked or is otherwise unusable (`invalid_grant`). Retrying cannot help:
 * the end user has to go through the authorization flow again.
 */
export class ReauthorizationRequiredError extends AuthError {
  readonly connectionId: string;

  constructor(connectionId: string, message: string, options: IntegrationErrorOptions = {}) {
    super(message, options);
    this.connectionId = connectionId;
  }
}

export class RateLimitedError extends IntegrationError {
  readonly kind = 'rate_limited';
  readonly retryable = true;
  /** Delay requested by the provider (from `Retry-After`), if any. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: IntegrationErrorOptions & { retryAfterMs?: number | undefined } = {},
  ) {
    super(message, options);
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class NotFoundError extends IntegrationError {
  readonly kind = 'not_found';
  readonly retryable = false;
}

/** The provider rejected the request as malformed (HTTP 400/409/422). */
export class ValidationError extends IntegrationError {
  readonly kind = 'validation';
  readonly retryable = false;
}

/** Network failures, timeouts and 5xx responses. */
export class UpstreamError extends IntegrationError {
  readonly kind = 'upstream';
  readonly retryable: boolean;

  constructor(
    message: string,
    options: IntegrationErrorOptions & { retryable?: boolean | undefined } = {},
  ) {
    super(message, options);
    this.retryable = options.retryable ?? true;
  }
}

export type WebhookVerificationFailure =
  'missing_signature' | 'malformed_signature' | 'timestamp_out_of_tolerance' | 'signature_mismatch';

/** Raised by webhook intake when a delivery cannot be proven authentic and fresh. */
export class WebhookVerificationError extends Error {
  readonly reason: WebhookVerificationFailure;

  constructor(reason: WebhookVerificationFailure, message?: string) {
    super(message ?? `Webhook verification failed: ${reason}`);
    this.name = 'WebhookVerificationError';
    this.reason = reason;
  }
}

export function isIntegrationError(error: unknown): error is IntegrationError {
  return error instanceof IntegrationError;
}

/**
 * Default status-code mapping, used when a provider adapter does not recognise an error body.
 * Adapters can refine this (for example, a provider that returns 400 for expired tokens).
 */
export function errorFromStatus(
  status: number,
  options: IntegrationErrorOptions & { retryAfterMs?: number | undefined } = {},
): IntegrationError {
  const base = { ...options, status };
  const label = options.provider ?? 'Provider';
  if (status === 401 || status === 403) return new AuthError(`${label} rejected credentials`, base);
  if (status === 404 || status === 410)
    return new NotFoundError(`${label} resource not found`, base);
  if (status === 429) return new RateLimitedError(`${label} rate limit exceeded`, base);
  if (status === 400 || status === 409 || status === 422) {
    return new ValidationError(`${label} rejected the request`, base);
  }
  if (status >= 500) return new UpstreamError(`${label} returned ${status}`, base);
  // Other 4xx codes: treat as non-retryable upstream errors rather than guessing.
  return new UpstreamError(`${label} returned ${status}`, { ...base, retryable: false });
}
