import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  HttpClient,
  type HttpClientOptions,
  NotFoundError,
  RateLimitedError,
  TokenBucket,
  UpstreamError,
  ValidationError,
} from '../src/index.js';
import {
  type MockHandler,
  type MockServer,
  sendJson,
  startMockServer,
} from './helpers/mock-server.js';
import { FakeTime } from './helpers/time.js';

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(
  handler: MockHandler,
  options: Partial<HttpClientOptions> = {},
): Promise<{ client: HttpClient; time: FakeTime; server: MockServer }> {
  server = await startMockServer(handler);
  const time = new FakeTime();
  const client = new HttpClient({
    baseUrl: `${server.url}/api`,
    provider: 'test',
    clock: time,
    sleep: time.sleep,
    random: () => 0.5,
    ...options,
  });
  return { client, time, server };
}

/** Responds with each entry in turn, repeating the last one. */
function sequence(...responses: [number, unknown, Record<string, string>?][]): MockHandler {
  let index = 0;
  return (_request, response) => {
    const [status, body, headers] = responses[Math.min(index++, responses.length - 1)]!;
    sendJson(response, status, body, headers);
  };
}

describe('HttpClient retries', () => {
  it('retries 5xx responses with jittered exponential backoff', async () => {
    const { client, time, server } = await setup(
      sequence([503, { error: 'down' }], [502, {}], [200, { ok: true }]),
      { retry: { baseMs: 100 } },
    );
    const response = await client.get<{ ok: boolean }>('/things');
    expect(response.data).toEqual({ ok: true });
    expect(server.requests).toHaveLength(3);
    // random() = 0.5 → half of 100 * 2^(n-1)
    expect(time.sleeps).toEqual([50, 100]);
  });

  it('honors Retry-After in seconds on 429', async () => {
    const { client, time } = await setup(
      sequence([429, { error: 'slow down' }, { 'retry-after': '2' }], [200, { ok: true }]),
    );
    await client.get('/things');
    expect(time.sleeps).toEqual([2000]);
  });

  it('honors Retry-After as an HTTP date', async () => {
    let retryAt = '';
    let calls = 0;
    const { client, time } = await setup((_request, response) => {
      if (calls++ === 0) sendJson(response, 429, {}, { 'retry-after': retryAt });
      else sendJson(response, 200, {});
    });
    retryAt = new Date(time.now() + 5000).toUTCString();
    await client.get('/things');
    expect(time.sleeps).toEqual([5000]);
  });

  it('pauses the shared rate limiter so other callers also wait out Retry-After', async () => {
    const time = new FakeTime();
    const limiter = new TokenBucket({
      capacity: 5,
      refillPerSecond: 5,
      clock: time,
      sleep: time.sleep,
    });
    const pause = vi.spyOn(limiter, 'pause');
    const { client } = await setup(sequence([429, {}, { 'retry-after': '3' }], [200, {}]), {
      rateLimiter: limiter,
      clock: time,
      sleep: time.sleep,
    });
    await client.get('/things');
    expect(pause).toHaveBeenCalledWith(3000);
  });

  it('fails fast when Retry-After exceeds maxRetryAfterMs', async () => {
    const { client, server } = await setup(sequence([429, {}, { 'retry-after': '3600' }]), {
      retry: { maxRetryAfterMs: 60_000 },
    });
    const error = await client.get('/things').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterMs).toBe(3_600_000);
    expect(server.requests).toHaveLength(1);
  });

  it('gives up after maxAttempts and throws the last error', async () => {
    const { client, server } = await setup(sequence([500, { message: 'boom' }]), {
      retry: { maxAttempts: 3 },
    });
    const error = await client.get('/things').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).status).toBe(500);
    expect(server.requests).toHaveLength(3);
  });

  it('does not retry non-idempotent requests unless asked to', async () => {
    const { client, server } = await setup(sequence([503, {}], [201, { id: 1 }]));
    await expect(client.post('/things', { body: { a: 1 } })).rejects.toBeInstanceOf(UpstreamError);
    expect(server.requests).toHaveLength(1);

    const created = await client.post('/things', {
      body: { a: 1 },
      headers: { 'idempotency-key': 'k1' },
      retry: true,
    });
    expect(created.status).toBe(201);
    expect(server.requests[1]!.body).toBe('{"a":1}');
    expect(server.requests[1]!.headers['content-type']).toBe('application/json');
  });

  it('wraps network failures in a retryable UpstreamError', async () => {
    const { client, server } = await setup(sequence([200, {}]), { retry: { maxAttempts: 2 } });
    await server.close();
    const error = await client.get('/things').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).retryable).toBe(true);
  });
});

describe('HttpClient error normalization', () => {
  it.each([
    [401, AuthError, 'auth'],
    [403, AuthError, 'auth'],
    [404, NotFoundError, 'not_found'],
    [422, ValidationError, 'validation'],
    [400, ValidationError, 'validation'],
  ] as const)('maps %i to %s', async (status, type, kind) => {
    const { client, server } = await setup(sequence([status, { message: 'nope' }]));
    const error = await client.get('/things').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect((error as AuthError).kind).toBe(kind);
    expect((error as AuthError).details).toEqual({ message: 'nope' });
    expect(server.requests).toHaveLength(1); // none of these are retried
  });

  it('lets an adapter map provider-specific error bodies', async () => {
    const { client } = await setup(sequence([400, { code: 'TOKEN_EXPIRED' }]), {
      normalizeError: ({ body, status }) =>
        (body as { code?: string }).code === 'TOKEN_EXPIRED'
          ? new AuthError('expired', { status, code: 'TOKEN_EXPIRED' })
          : undefined,
    });
    const error = await client.get('/things').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('TOKEN_EXPIRED');
  });
});

describe('HttpClient auth', () => {
  it('sends the bearer token and refreshes once after a 401', async () => {
    let current = 'stale';
    const refreshAccessToken = vi.fn((rejected: string) => {
      expect(rejected).toBe('stale');
      current = 'fresh';
      return Promise.resolve(current);
    });
    const { client, server } = await setup(
      (request, response) => {
        if (request.headers.authorization === 'Bearer fresh') sendJson(response, 200, { ok: 1 });
        else sendJson(response, 401, { error: 'expired' });
      },
      { auth: { getAccessToken: () => Promise.resolve(current), refreshAccessToken } },
    );
    await client.get('/me');
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(server.requests.map((r) => r.headers.authorization)).toEqual([
      'Bearer stale',
      'Bearer fresh',
    ]);
  });

  it('does not loop when the refreshed token is also rejected', async () => {
    const refreshAccessToken = vi.fn(() => Promise.resolve('also-bad'));
    const { client, server } = await setup(sequence([401, {}]), {
      auth: { getAccessToken: () => Promise.resolve('bad'), refreshAccessToken },
    });
    await expect(client.get('/me')).rejects.toBeInstanceOf(AuthError);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(2);
  });

  it('refuses to send credentials to another origin', async () => {
    const { client, server } = await setup(sequence([200, {}]), {
      auth: { getAccessToken: () => Promise.resolve('secret') },
    });
    await expect(client.get('https://evil.example/steal')).rejects.toThrow(
      /not the configured origin/,
    );
    expect(server.requests).toHaveLength(0);
  });

  it('resolves relative paths against the base path and encodes query params', async () => {
    const { client, server } = await setup(sequence([200, []]));
    await client.get('/items', { query: { q: 'a b', page: 2, skip: undefined } });
    expect(server.requests[0]!.url.pathname).toBe('/api/items');
    expect(server.requests[0]!.url.search).toBe('?q=a+b&page=2');
  });
});
