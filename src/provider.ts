import {
  type ErrorNormalizer,
  HttpClient,
  type RetryEvent,
  type RetryOptions,
} from './http/client.js';
import { TokenBucket } from './http/rate-limiter.js';
import type { Clock, Sleep } from './internal/time.js';
import { OAuthClient, type OAuthClientOptions } from './oauth/client.js';
import { TokenManager } from './oauth/token-manager.js';
import type { TokenStore } from './oauth/types.js';
import type { WebhookVerifier } from './webhooks/intake.js';

/**
 * Everything that is specific to one provider's transport: endpoints, limits and error format.
 * Together with mapping payloads to internal models, this is all a new integration writes.
 */
export interface ProviderDefinition {
  name: string;
  oauth: Pick<
    OAuthClientOptions,
    'authorizeUrl' | 'tokenUrl' | 'scopes' | 'scopeSeparator' | 'clientAuth' | 'pkce'
  >;
  api: {
    baseUrl: string;
    headers?: Record<string, string>;
    /** Client-side limit, applied per connection. */
    rateLimit?: { capacity: number; refillPerSecond: number };
    retry?: RetryOptions;
    timeoutMs?: number;
    normalizeError?: ErrorNormalizer;
  };
  webhooks?: WebhookVerifier;
}

/** Identity function that gives provider definitions type checking at the definition site. */
export function defineProvider<const P extends ProviderDefinition>(definition: P): P {
  return definition;
}

export interface IntegrationOptions {
  clientId: string;
  clientSecret?: string | undefined;
  redirectUri: string;
  tokenStore: TokenStore;
  refreshMarginMs?: number | undefined;
  onRetry?: ((event: RetryEvent & { connectionId: string }) => void) | undefined;
  fetch?: typeof fetch | undefined;
  clock?: Clock | undefined;
  sleep?: Sleep | undefined;
}

export interface Integration {
  readonly provider: ProviderDefinition;
  readonly oauth: OAuthClient;
  readonly tokens: TokenManager;
  /** An authenticated, rate-limited client for one connected account. Cached per connection. */
  client(connectionId: string): HttpClient;
}

/** Wires a provider definition to the shared OAuth, token and HTTP infrastructure. */
export function createIntegration(
  provider: ProviderDefinition,
  options: IntegrationOptions,
): Integration {
  const { fetch, clock, sleep, onRetry } = options;
  const oauth = new OAuthClient({
    ...provider.oauth,
    provider: provider.name,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri: options.redirectUri,
    fetch,
    clock,
  });
  const tokens = new TokenManager({
    oauth,
    store: options.tokenStore,
    refreshMarginMs: options.refreshMarginMs,
    clock,
  });

  const clients = new Map<string, HttpClient>();
  const { api } = provider;

  return {
    provider,
    oauth,
    tokens,
    client(connectionId) {
      let client = clients.get(connectionId);
      if (client === undefined) {
        client = new HttpClient({
          baseUrl: api.baseUrl,
          provider: provider.name,
          auth: tokens.forConnection(connectionId),
          headers: api.headers,
          retry: api.retry,
          timeoutMs: api.timeoutMs,
          normalizeError: api.normalizeError,
          rateLimiter: api.rateLimit && new TokenBucket({ ...api.rateLimit, clock, sleep }),
          onRetry:
            onRetry &&
            ((event) => {
              onRetry({ ...event, connectionId });
            }),
          fetch,
          clock,
          sleep,
        });
        clients.set(connectionId, client);
      }
      return client;
    },
  };
}
