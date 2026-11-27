/** Provider-agnostic view of an OAuth 2.0 token response. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string | undefined;
  /** Absolute expiry in epoch milliseconds. `undefined` if the provider did not say. */
  expiresAt?: number | undefined;
  tokenType: string;
  scope?: string | undefined;
}

/**
 * Persists tokens per connection (one connected account of one provider). Implementations must
 * be safe to call concurrently from a single process.
 */
export interface TokenStore {
  get(connectionId: string): Promise<TokenSet | undefined>;
  set(connectionId: string, tokens: TokenSet): Promise<void>;
  delete(connectionId: string): Promise<void>;
}
