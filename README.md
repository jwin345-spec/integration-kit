# integration-kit

[![CI](https://github.com/jwin345-spec/integration-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/jwin345-spec/integration-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Shared infrastructure for third-party API integrations in TypeScript: OAuth 2.0 token lifecycle,
a resilient outbound HTTP client, and verified, idempotent webhook intake. Each integration
supplies only what is specific to its provider: endpoints, error format, pagination style and
the mapping into internal models.

No runtime dependencies. Node.js 20+, ESM and CommonJS builds.

## Why

Every integration with a SaaS API ends up needing the same reliability code: exchange and refresh
OAuth tokens, back off on 429s, retry the right failures and not the wrong ones, page through
collections, verify webhook signatures, and survive providers that deliver the same event twice.
When each integration writes this itself, it gets written several times with small differences,
and the bugs are the subtle kind: two concurrent refreshes that invalidate each other's rotated
refresh token, a retry loop that ignores `Retry-After`, a webhook handler that does real work
before acknowledging and gets redelivered on timeout, a signature check that is not constant-time.

integration-kit puts that code in one place with one tested policy. An adapter for a new provider
is then mostly declarative; the [Acme example](./examples/acme/adapter.ts) is about 140 lines
including its internal model and webhook mapping.

## How it works

```
             ┌──────────────── your app ────────────────┐
             │  business logic: Contact, Invoice, ...   │
             └───────▲───────────────────────▲──────────┘
                     │ internal models       │ domain events
             ┌───────┴────────┐       ┌──────┴────────────┐
             │ provider       │       │ WebhookWorker     │  retries, backoff,
             │ adapter (Acme) │       │ (async)           │  dead letter
             └───────┬────────┘       └──────▲────────────┘
                     │                       │ claim (leased)
  ┌──────────────────┴───────────┐    ┌──────┴────────────┐
  │ HttpClient                   │    │ WebhookEventStore │  unique (provider, eventId)
  │  TokenBucket · retries ·     │    └──────▲────────────┘
  │  Retry-After · pagination ·  │           │ insert raw event, then 2xx
  │  error normalization         │    ┌──────┴────────────┐
  └──────┬────────────────▲──────┘    │ WebhookIntake     │  HMAC + timestamp check
         │ bearer token   │ 401       └──────▲────────────┘
  ┌──────┴────────────────┴──────┐           │
  │ TokenManager (single-flight) │      provider webhooks
  │ OAuthClient · TokenStore     │
  └──────────────────────────────┘
```

**OAuth and tokens.** `OAuthClient` implements the authorization-code flow with `state` and
PKCE. `TokenManager` owns tokens per connection (one connected account): it refreshes
proactively when a token is within `refreshMarginMs` of expiry, refreshes once after a 401,
and collapses concurrent refreshes for the same connection into one request. A refresh that
fails with `invalid_grant` deletes the stored tokens and throws `ReauthorizationRequiredError`,
so the app can ask the user to reconnect. Network errors and 5xx responses from the token
endpoint do not: a provider outage should not log users out.

**Outbound calls.** `HttpClient` acquires a token from a per-connection `TokenBucket`, sends the
request with a per-attempt timeout, and maps failures into five error kinds (`auth`,
`rate_limited`, `not_found`, `validation`, `upstream`). Retryable errors on idempotent requests
are retried with full-jitter backoff, or after exactly the delay the provider asked for in
`Retry-After` (or in its error body, if the adapter extracts it). A `Retry-After` also pauses
the bucket, so concurrent callers wait instead of each discovering the limit. `paginate()`
returns an async iterator that fetches pages lazily.

**Webhooks.** `WebhookIntake.receive()` verifies the signature over the raw bytes, extracts the
provider's event id, and inserts the raw event into a `WebhookEventStore`, deduplicating on
`(provider, eventId)`. Only then does the HTTP handler respond 2xx. `WebhookWorker` claims due
events with a lease, runs the handler, and on failure reschedules with backoff, moving the event
to `dead` after `maxAttempts` or immediately for non-retryable errors.

## Quick start

```sh
npm install integration-kit
```

Define the provider once:

```ts
import { NotFoundError, cursorPagination, defineProvider, hmacVerifier } from 'integration-kit';

export const acme = defineProvider({
  name: 'acme',
  oauth: {
    authorizeUrl: 'https://acme.example/oauth/authorize',
    tokenUrl: 'https://acme.example/oauth/token',
    scopes: ['contacts:read'],
  },
  api: {
    baseUrl: 'https://api.acme.example/v1',
    rateLimit: { capacity: 10, refillPerSecond: 5 },
    // Optional: map the provider's error bodies; fall back to status codes otherwise.
    normalizeError: ({ status, body }) =>
      (body as { error?: { type?: string } }).error?.type === 'not_found'
        ? new NotFoundError('Acme: not found', { status })
        : undefined,
  },
  webhooks: {
    verify: hmacVerifier({ signatureHeader: 'Acme-Signature', secrets: process.env.ACME_WHSEC! }),
    parse: (raw) => {
      const { id, type } = JSON.parse(raw) as { id: string; type: string };
      return { eventId: id, type };
    },
  },
});
```

Connect an account and call the API:

```ts
import { FileTokenStore, createIntegration } from 'integration-kit';

const integration = createIntegration(acme, {
  clientId: process.env.ACME_CLIENT_ID!,
  clientSecret: process.env.ACME_CLIENT_SECRET!,
  redirectUri: 'https://app.example/oauth/acme/callback',
  tokenStore: new FileTokenStore('./data/tokens.json'), // or your own TokenStore
});

// 1. Redirect the user. Keep `state` and `codeVerifier` in the session.
const { url, state, codeVerifier } = integration.oauth.createAuthorizationRequest();

// 2. In the callback, after checking `state`:
const tokens = await integration.oauth.exchangeCode(code, codeVerifier);
await integration.tokens.save(connectionId, tokens);

// 3. Anywhere afterwards. Tokens are refreshed as needed; 429s are absorbed.
const client = integration.client(connectionId);
const pages = client.paginate(
  { path: '/contacts' },
  cursorPagination({
    items: (body) => (body as { data: AcmeContact[] }).data.map(toContact),
    nextCursor: (body) => (body as { next_cursor: string | null }).next_cursor,
  }),
);
for await (const contact of pages) {
  // ...
}
```

Receive webhooks (Fastify shown; any framework that exposes the raw body works):

```ts
import {
  MemoryWebhookEventStore,
  WebhookIntake,
  WebhookVerificationError,
  WebhookWorker,
} from 'integration-kit';

const store = new MemoryWebhookEventStore(); // use a durable store in production
const intake = new WebhookIntake({ store, providers: { acme: acme.webhooks } });

app.post('/webhooks/acme', async (request, reply) => {
  try {
    const result = await intake.receive('acme', {
      headers: request.headers,
      rawBody: request.body,
    });
    return reply.code(result.status === 'accepted' ? 202 : 200).send(); // persisted first
  } catch (error) {
    if (error instanceof WebhookVerificationError) return reply.code(401).send();
    throw error;
  }
});

const worker = new WebhookWorker({
  store,
  handlers: { acme: async (event) => applyContactEvent(toContactEvent(event)) },
});
worker.start();
```

### Demo

`npm run demo` starts a mock Acme API and a Fastify app on localhost, then walks through the
OAuth redirect, a paginated read that hits a 429 and recovers, and a webhook delivered twice
(202, then 200 as a duplicate). Source: [`examples/`](./examples). Nothing contacts a real
provider.

## API overview

| Export                                     | Purpose                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineProvider`, `createIntegration`      | Declare a provider; wire it to `OAuthClient`, `TokenManager` and per-connection `HttpClient`s.                                                    |
| `OAuthClient`                              | `createAuthorizationRequest()`, `exchangeCode(code, verifier)`, `refresh(refreshToken)`.                                                          |
| `TokenManager`                             | `save`, `getAccessToken`, `refresh(id, rejectedToken?)`, `disconnect`, `forConnection(id)`.                                                       |
| `TokenStore`                               | Interface (`get`/`set`/`delete`); `MemoryTokenStore`, `FileTokenStore`.                                                                           |
| `HttpClient`                               | `request`, `get`, `post`, `paginate(request, strategy, { maxPages })`.                                                                            |
| `cursorPagination`, `linkHeaderPagination` | Pagination strategies; implement `PaginationStrategy` for anything else.                                                                          |
| `TokenBucket`                              | `acquire(signal?)`, `pause(ms)`.                                                                                                                  |
| `exponentialBackoff`, `parseRetryAfter`    | The retry primitives, exported for reuse.                                                                                                         |
| `WebhookIntake`, `hmacVerifier`            | Verify, parse and persist deliveries. `WebhookVerifier` is the per-provider interface.                                                            |
| `signWebhook`, `verifyWebhookSignature`    | Timestamped HMAC-SHA256 (`t=...,v1=...`) with tolerance window and secret rotation.                                                               |
| `WebhookEventStore`                        | Interface; `MemoryWebhookEventStore` reference implementation (`insert`, `claim`, `complete`, `fail`, `requeue`).                                 |
| `WebhookWorker`                            | `processDue()`, `start()`, `stop()`; emits `processed`, `retry_scheduled`, `dead_lettered`, `lease_lost`.                                         |
| Errors                                     | `AuthError`, `ReauthorizationRequiredError`, `RateLimitedError`, `NotFoundError`, `ValidationError`, `UpstreamError`, `WebhookVerificationError`. |

Every `IntegrationError` carries `kind`, `retryable`, `provider`, `status`, `code` and `details`
(the provider's response body). `RateLimitedError` adds `retryAfterMs`.

**HttpClient options**: `retry` (`maxAttempts` 4, `baseMs` 250, `maxMs` 30 s,
`maxRetryAfterMs` 60 s), `timeoutMs` (30 s), `rateLimiter`, `auth`, `normalizeError`, `onRetry`,
and injectable `fetch`, `clock`, `sleep` and `random` for tests.

**WebhookWorker options**: `maxAttempts` (5), `backoff` (`baseMs` 1 s, `maxMs` 5 min), `leaseMs`
(60 s), `batchSize` (10), `pollIntervalMs` (1 s), `onEvent`.

## Design decisions

- **Single-flight refresh, per connection.** Providers that rotate refresh tokens treat reuse of
  an old one as a possible theft and may revoke the whole grant. Concurrent requests that all
  see an expired token must therefore share one refresh. After a 401, the client passes the
  rejected token to `refresh()`, which skips the call if another request already replaced it.
- **Only `invalid_grant` revokes.** Tokens are deleted only on a definitive answer from the
  token endpoint. `invalid_client` is a configuration problem and transient failures are
  retryable; neither should disconnect users.
- **Retry only what is safe.** Idempotent methods are retried automatically; `POST`/`PATCH` only
  with `retry: true`, which you should pair with an idempotency key. Auth, validation and
  not-found errors are never retried.
- **Respect the provider's clock.** `Retry-After` (seconds or HTTP-date) wins over computed
  backoff. If it asks for longer than `maxRetryAfterMs`, the client fails fast with
  `RateLimitedError.retryAfterMs` so a job queue can reschedule instead of holding a request open.
- **Credentials stay on the configured origin.** Absolute URLs (such as pagination links) are
  allowed only when they match `baseUrl`'s origin.
- **Persist, then acknowledge.** Intake does no business work. The response goes out only after
  the raw event is stored, so it is fast enough to avoid provider timeouts and nothing is lost
  if the process dies after acknowledging.
- **Two layers of replay protection.** The signature covers `timestamp.body`, and timestamps
  outside the tolerance window (default 5 minutes, either direction) are rejected. Inside the
  window, a replay or a legitimate redelivery is caught by the `(provider, eventId)` unique key.
  Signatures are compared in constant time over fixed-length digests.
- **Raw bodies are kept.** Events are stored as received, so they can be re-parsed after a
  mapping bug is fixed and dead-lettered events can be requeued.
- **Leases and fencing in the worker.** A claimed event is leased; if a worker crashes, the
  lease expires and the event is claimed again. The attempt number acts as a fencing token, so
  a stale worker cannot overwrite the outcome recorded by its successor.
- **Everything time-related is injectable.** Clock, sleep, randomness and `fetch` can be
  replaced, which is how the tests check backoff delays and `Retry-After` exactly without
  waiting.

## Testing

`npm test` runs the Vitest suite. HTTP tests use a local `node:http` server on an ephemeral
port, and the example adapter is exercised end to end against the mock Acme server; no test
uses the network beyond `127.0.0.1`. Covered among others: single-flight refresh under 25
concurrent callers, `invalid_grant` vs. transient token endpoint failures, `Retry-After` in both
formats and the rate-limiter pause, retry policy per method, cursor and `Link` pagination
(including early `break`), signature tampering, stale and forged-timestamp replays, concurrent
duplicate deliveries, retry/dead-letter/requeue, and lease expiry with fencing.

## Limitations

- **Reference stores only.** `MemoryWebhookEventStore` is process-local and not durable, so it
  does not satisfy "persist before acknowledge" on its own; implement `WebhookEventStore` on
  your database (unique index on `(provider, event_id)`, conditional updates or
  `FOR UPDATE SKIP LOCKED` for `claim`). `FileTokenStore` is for single-process use and stores
  tokens unencrypted; production tokens belong in an encrypted store.
- **Single-flight is per process.** Several processes sharing one token store can still refresh
  concurrently. Avoiding that needs a distributed lock or a compare-and-set on the stored token.
- **A lost refresh response is not recovered.** If the provider rotates the refresh token but
  the response never arrives, the stored refresh token is already invalid. The connection then
  surfaces as `ReauthorizationRequiredError`.
- **No ordering guarantees for webhooks.** Events are processed roughly in arrival order, but
  retries and concurrency can reorder them. Handlers should compare timestamps or versions where
  order matters.
- **One signature scheme built in.** `hmacVerifier` covers the common `t=...,v1=...` HMAC-SHA256
  format. Providers with other schemes (different header layout, asymmetric signatures) need a
  custom `verify` function; the `constantTimeEqual` helper is exported for that.
- **JSON only.** Request bodies are serialized as JSON and responses parsed as JSON or text.
  Multipart uploads and streaming downloads are out of scope.
- **Rate limits are client-side estimates.** The token bucket is per connection and per process;
  it reduces 429s but does not coordinate across instances.

## License

[MIT](./LICENSE)
