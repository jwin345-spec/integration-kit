# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- `OAuthClient`: authorization-code flow with `state` and PKCE (S256), code exchange and refresh,
  HTTP Basic or form-body client authentication.
- `TokenManager`: proactive refresh before expiry, refresh after a 401, single-flight refresh per
  connection, and `ReauthorizationRequiredError` when a refresh token is revoked.
- `TokenStore` contract with `MemoryTokenStore` and `FileTokenStore` (atomic rename writes).
- `HttpClient`: retries with full-jitter exponential backoff, `Retry-After` (seconds and
  HTTP-date), per-attempt timeouts, idempotency-aware retry policy, same-origin guard for
  credentials, and errors normalized into `AuthError`, `RateLimitedError`, `NotFoundError`,
  `ValidationError` and `UpstreamError`.
- `TokenBucket` client-side rate limiter that pauses all callers on `Retry-After`.
- Lazy async-iterator pagination with `cursorPagination()` and `linkHeaderPagination()`.
- Webhook intake: timestamped HMAC-SHA256 verification with tolerance window, constant-time
  comparison and secret rotation; persist-before-acknowledge; deduplication by provider event id.
- `WebhookWorker`: leased, retried, at-least-once processing with a dead-letter state and
  `requeue()`.
- `defineProvider()` / `createIntegration()`, an example "Acme" adapter, a mock Acme API, and a
  Fastify demo server.
