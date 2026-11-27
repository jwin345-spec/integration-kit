import { ReauthorizationRequiredError, isIntegrationError } from '../errors.js';
import type { AccessTokenSource } from '../http/client.js';
import { type Clock, systemClock } from '../internal/time.js';
import type { OAuthClient } from './client.js';
import type { TokenSet, TokenStore } from './types.js';

export interface TokenManagerOptions {
  oauth: OAuthClient;
  store: TokenStore;
  /**
   * Refresh this long before the access token expires, so a request never leaves with a token
   * that expires in flight. Default 60 s.
   */
  refreshMarginMs?: number | undefined;
  clock?: Clock | undefined;
  /** Called after tokens for a connection were revoked and removed from the store. */
  onReauthorizationRequired?:
    ((connectionId: string, error: ReauthorizationRequiredError) => void) | undefined;
}

/**
 * Owns the token lifecycle for every connection of one provider: proactive refresh, refresh
 * after a 401, single-flight deduplication of concurrent refreshes, and handling of revoked
 * refresh tokens.
 */
export class TokenManager {
  readonly #oauth: OAuthClient;
  readonly #store: TokenStore;
  readonly #marginMs: number;
  readonly #clock: Clock;
  readonly #onReauth: TokenManagerOptions['onReauthorizationRequired'];
  readonly #inFlight = new Map<string, Promise<TokenSet>>();

  constructor(options: TokenManagerOptions) {
    this.#oauth = options.oauth;
    this.#store = options.store;
    this.#marginMs = options.refreshMarginMs ?? 60_000;
    this.#clock = options.clock ?? systemClock;
    this.#onReauth = options.onReauthorizationRequired;
  }

  /** Stores tokens obtained from `OAuthClient.exchangeCode()`. */
  save(connectionId: string, tokens: TokenSet): Promise<void> {
    return this.#store.set(connectionId, tokens);
  }

  disconnect(connectionId: string): Promise<void> {
    return this.#store.delete(connectionId);
  }

  /** Returns a usable access token, refreshing first if it is expired or about to expire. */
  async getAccessToken(connectionId: string): Promise<string> {
    // Join an in-flight refresh instead of reading a token that is about to be replaced.
    const pending = this.#inFlight.get(connectionId);
    if (pending) return (await pending).accessToken;

    const tokens = await this.#load(connectionId);
    if (!this.#isExpiring(tokens)) return tokens.accessToken;
    return (await this.refresh(connectionId)).accessToken;
  }

  /**
   * Refreshes the connection's tokens. Concurrent calls for the same connection share a single
   * request to the token endpoint, which matters for providers that rotate refresh tokens: two
   * parallel refreshes with the same refresh token would otherwise invalidate each other.
   *
   * Pass `rejectedAccessToken` (the token that just got a 401) to skip the refresh when another
   * caller has already replaced that token.
   */
  refresh(connectionId: string, rejectedAccessToken?: string): Promise<TokenSet> {
    const pending = this.#inFlight.get(connectionId);
    if (pending) return pending;
    const promise = this.#doRefresh(connectionId, rejectedAccessToken).finally(() => {
      this.#inFlight.delete(connectionId);
    });
    this.#inFlight.set(connectionId, promise);
    return promise;
  }

  /** Adapts this manager to the `HttpClient` auth interface for one connection. */
  forConnection(connectionId: string): AccessTokenSource {
    return {
      getAccessToken: () => this.getAccessToken(connectionId),
      refreshAccessToken: async (rejected?: string) =>
        (await this.refresh(connectionId, rejected)).accessToken,
    };
  }

  async #doRefresh(connectionId: string, rejectedAccessToken?: string): Promise<TokenSet> {
    const current = await this.#load(connectionId);
    if (rejectedAccessToken !== undefined && current.accessToken !== rejectedAccessToken) {
      return current;
    }
    if (current.refreshToken === undefined) {
      throw await this.#revoke(connectionId, 'Access token expired and no refresh token stored');
    }

    let refreshed: TokenSet;
    try {
      refreshed = await this.#oauth.refresh(current.refreshToken);
    } catch (error) {
      // Only a definitive rejection revokes the connection. Network errors and 5xx responses
      // must not log the user out; they surface as retryable upstream errors.
      // `invalid_client` and friends are configuration problems and keep the stored tokens.
      if (isIntegrationError(error) && error.code === 'invalid_grant') {
        throw await this.#revoke(connectionId, `Refresh token rejected: ${error.message}`, error);
      }
      throw error;
    }

    const next: TokenSet = {
      ...refreshed,
      // Providers that do not rotate refresh tokens omit them from refresh responses.
      refreshToken: refreshed.refreshToken ?? current.refreshToken,
      scope: refreshed.scope ?? current.scope,
    };
    await this.#store.set(connectionId, next);
    return next;
  }

  async #load(connectionId: string): Promise<TokenSet> {
    const tokens = await this.#store.get(connectionId);
    if (tokens === undefined) {
      throw new ReauthorizationRequiredError(connectionId, `No tokens stored for ${connectionId}`, {
        provider: this.#oauth.provider,
      });
    }
    return tokens;
  }

  #isExpiring(tokens: TokenSet): boolean {
    if (tokens.expiresAt === undefined) return false; // unknown lifetime: rely on 401 handling
    return tokens.expiresAt - this.#marginMs <= this.#clock.now();
  }

  async #revoke(
    connectionId: string,
    message: string,
    cause?: unknown,
  ): Promise<ReauthorizationRequiredError> {
    await this.#store.delete(connectionId);
    const error = new ReauthorizationRequiredError(connectionId, message, {
      provider: this.#oauth.provider,
      code: 'invalid_grant',
      cause,
    });
    this.#onReauth?.(connectionId, error);
    return error;
  }
}
