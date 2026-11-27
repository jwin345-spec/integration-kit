import { AuthError, UpstreamError, ValidationError } from '../errors.js';
import { randomToken, sha256Base64Url } from '../internal/crypto.js';
import { type Clock, systemClock } from '../internal/time.js';
import type { TokenSet } from './types.js';

export interface OAuthClientOptions {
  provider?: string | undefined;
  clientId: string;
  clientSecret?: string | undefined;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes?: string[] | undefined;
  /** Separator used when joining scopes. Default `' '` (RFC 6749); some providers use `','`. */
  scopeSeparator?: string | undefined;
  /**
   * How the client authenticates at the token endpoint. `basic` (default) uses HTTP Basic auth
   * (RFC 6749 §2.3.1); `body` sends `client_id`/`client_secret` as form fields.
   */
  clientAuth?: 'basic' | 'body' | undefined;
  /** Use PKCE (RFC 7636, S256). Default `true`. */
  pkce?: boolean | undefined;
  fetch?: typeof fetch | undefined;
  clock?: Clock | undefined;
}

export interface AuthorizationRequest {
  url: string;
  /** Opaque CSRF token. Store it (e.g. in the session) and compare on callback. */
  state: string;
  /** PKCE verifier to keep server-side until the code is exchanged. */
  codeVerifier: string | undefined;
}

/**
 * OAuth 2.0 authorization-code flow. Stateless: the caller keeps `state` and `codeVerifier`
 * between the redirect and the callback.
 */
export class OAuthClient {
  readonly #options: OAuthClientOptions;
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;

  constructor(options: OAuthClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? systemClock;
  }

  get provider(): string | undefined {
    return this.#options.provider;
  }

  createAuthorizationRequest(
    options: { scopes?: string[]; extraParams?: Record<string, string> } = {},
  ): AuthorizationRequest {
    const state = randomToken();
    const usePkce = this.#options.pkce ?? true;
    const codeVerifier = usePkce ? randomToken(48) : undefined;
    const url = new URL(this.#options.authorizeUrl);
    const scopes = options.scopes ?? this.#options.scopes ?? [];
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.#options.clientId);
    url.searchParams.set('redirect_uri', this.#options.redirectUri);
    url.searchParams.set('state', state);
    if (scopes.length > 0) {
      url.searchParams.set('scope', scopes.join(this.#options.scopeSeparator ?? ' '));
    }
    if (codeVerifier !== undefined) {
      url.searchParams.set('code_challenge', sha256Base64Url(codeVerifier));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    for (const [key, value] of Object.entries(options.extraParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return { url: url.toString(), state, codeVerifier };
  }

  exchangeCode(code: string, codeVerifier?: string): Promise<TokenSet> {
    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.#options.redirectUri,
    };
    if (codeVerifier !== undefined) params.code_verifier = codeVerifier;
    return this.#tokenRequest(params);
  }

  /**
   * Exchanges a refresh token. Throws `AuthError` with `code: 'invalid_grant'` when the token was
   * revoked or expired; `TokenManager` turns that into `ReauthorizationRequiredError`.
   */
  refresh(refreshToken: string): Promise<TokenSet> {
    return this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async #tokenRequest(params: Record<string, string>): Promise<TokenSet> {
    const { clientId, clientSecret, provider } = this.#options;
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    const form = new URLSearchParams(params);
    if ((this.#options.clientAuth ?? 'basic') === 'basic' && clientSecret !== undefined) {
      const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
    } else {
      form.set('client_id', clientId);
      if (clientSecret !== undefined) form.set('client_secret', clientSecret);
    }

    let response: Response;
    try {
      response = await this.#fetch(this.#options.tokenUrl, {
        method: 'POST',
        headers,
        body: form.toString(),
      });
    } catch (error) {
      throw new UpstreamError('Token endpoint unreachable', { provider, cause: error });
    }

    const body = (await response.json().catch(() => undefined)) as
      Record<string, unknown> | undefined;

    if (!response.ok) {
      const code = typeof body?.error === 'string' ? body.error : undefined;
      const description =
        typeof body?.error_description === 'string' ? `: ${body.error_description}` : '';
      const options = { provider, status: response.status, code, details: body };
      if (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client') {
        throw new AuthError(`Token request rejected (${code})${description}`, options);
      }
      if (response.status >= 500 || response.status === 429) {
        throw new UpstreamError(`Token endpoint returned ${response.status}`, options);
      }
      throw new ValidationError(`Token request failed (${code ?? response.status})${description}`, {
        ...options,
      });
    }

    if (typeof body?.access_token !== 'string') {
      throw new UpstreamError('Token response did not include an access_token', {
        provider,
        details: body,
        retryable: false,
      });
    }
    // Some providers send expires_in as a string; absent or null means "unknown".
    const expiresIn =
      typeof body.expires_in === 'number' || typeof body.expires_in === 'string'
        ? Number(body.expires_in)
        : Number.NaN;
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      expiresAt: Number.isFinite(expiresIn) ? this.#clock.now() + expiresIn * 1000 : undefined,
      tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
      scope: typeof body.scope === 'string' ? body.scope : undefined,
    };
  }
}
