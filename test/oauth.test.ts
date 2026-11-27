import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  FileTokenStore,
  MemoryTokenStore,
  OAuthClient,
  ReauthorizationRequiredError,
  TokenManager,
  type TokenSet,
  UpstreamError,
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

const CONNECTION = 'conn-1';

async function setup(handler: MockHandler) {
  server = await startMockServer(handler);
  const time = new FakeTime();
  const oauth = new OAuthClient({
    provider: 'test',
    clientId: 'client id',
    clientSecret: 's3cret',
    authorizeUrl: `${server.url}/authorize`,
    tokenUrl: `${server.url}/token`,
    redirectUri: 'https://app.example/callback',
    scopes: ['read', 'write'],
    clock: time,
  });
  const store = new MemoryTokenStore();
  const onReauthorizationRequired = vi.fn();
  const manager = new TokenManager({
    oauth,
    store,
    clock: time,
    refreshMarginMs: 60_000,
    onReauthorizationRequired,
  });
  return { server, time, oauth, store, manager, onReauthorizationRequired };
}

/** A token endpoint that issues a new, rotated pair on every refresh. */
function rotatingTokenEndpoint(options: { delayMs?: number } = {}): MockHandler {
  let counter = 0;
  return async (request, response) => {
    const form = new URLSearchParams(request.body);
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    counter += 1;
    sendJson(response, 200, {
      access_token: `access-${counter}`,
      refresh_token: `refresh-${counter}`,
      expires_in: 3600,
      token_type: 'Bearer',
      grant: form.get('grant_type'),
    });
  };
}

function tokenSet(time: FakeTime, overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    expiresAt: time.now() + 3600_000,
    tokenType: 'Bearer',
    ...overrides,
  };
}

describe('OAuthClient', () => {
  it('builds an authorization URL with state and a PKCE S256 challenge', async () => {
    const { oauth } = await setup(rotatingTokenEndpoint());
    const request = oauth.createAuthorizationRequest();
    const url = new URL(request.url);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client id');
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const expected = createHash('sha256').update(request.codeVerifier!).digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expected);
    expect(oauth.createAuthorizationRequest().state).not.toBe(request.state);
  });

  it('exchanges a code using HTTP Basic client auth and the PKCE verifier', async () => {
    const { oauth, server, time } = await setup(rotatingTokenEndpoint());
    const tokens = await oauth.exchangeCode('the-code', 'the-verifier');
    expect(tokens).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: time.now() + 3600_000,
      tokenType: 'Bearer',
      scope: undefined,
    });
    const request = server.requests[0]!;
    expect(request.headers.authorization).toBe(
      `Basic ${Buffer.from('client%20id:s3cret').toString('base64')}`,
    );
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://app.example/callback',
      code_verifier: 'the-verifier',
    });
  });

  it('reports invalid_grant as an AuthError carrying the OAuth error code', async () => {
    const { oauth } = await setup((_request, response) => {
      sendJson(response, 400, { error: 'invalid_grant', error_description: 'Token revoked' });
    });
    const error = await oauth.refresh('r').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('invalid_grant');
    expect((error as AuthError).message).toContain('Token revoked');
  });
});

describe('TokenManager', () => {
  it('returns the stored token without refreshing while it is fresh', async () => {
    const { manager, store, server, time } = await setup(rotatingTokenEndpoint());
    await store.set(CONNECTION, tokenSet(time));
    expect(await manager.getAccessToken(CONNECTION)).toBe('access-0');
    expect(server.requests).toHaveLength(0);
  });

  it('refreshes proactively once the token is inside the refresh margin', async () => {
    const { manager, store, server, time } = await setup(rotatingTokenEndpoint());
    await store.set(CONNECTION, tokenSet(time, { expiresAt: time.now() + 30_000 }));
    expect(await manager.getAccessToken(CONNECTION)).toBe('access-1');
    expect(new URLSearchParams(server.requests[0]!.body).get('refresh_token')).toBe('refresh-0');
    expect(await store.get(CONNECTION)).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });
  });

  it('single-flight: concurrent callers share one refresh request', async () => {
    const { manager, store, server, time } = await setup(rotatingTokenEndpoint({ delayMs: 50 }));
    await store.set(CONNECTION, tokenSet(time, { expiresAt: time.now() - 1 }));

    const tokens = await Promise.all(
      Array.from({ length: 25 }, () => manager.getAccessToken(CONNECTION)),
    );

    expect(server.requests).toHaveLength(1);
    expect(new Set(tokens)).toEqual(new Set(['access-1']));
    // Once the refresh settles, the next expiry triggers a new (single) refresh.
    time.advance(3600_000);
    await Promise.all([manager.getAccessToken(CONNECTION), manager.getAccessToken(CONNECTION)]);
    expect(server.requests).toHaveLength(2);
  });

  it('single-flight is per connection', async () => {
    const { manager, store, server, time } = await setup(rotatingTokenEndpoint({ delayMs: 20 }));
    await store.set('a', tokenSet(time, { expiresAt: 0 }));
    await store.set('b', tokenSet(time, { expiresAt: 0 }));
    await Promise.all([
      manager.getAccessToken('a'),
      manager.getAccessToken('a'),
      manager.getAccessToken('b'),
    ]);
    expect(server.requests).toHaveLength(2);
  });

  it('keeps the previous refresh token when the provider does not rotate it', async () => {
    const { manager, store, time } = await setup((_request, response) => {
      sendJson(response, 200, { access_token: 'new-access', expires_in: 60 * 60 });
    });
    await store.set(CONNECTION, tokenSet(time, { expiresAt: 0, scope: 'read' }));
    await manager.refresh(CONNECTION);
    expect(await store.get(CONNECTION)).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'refresh-0',
      scope: 'read',
    });
  });

  it('skips a 401-triggered refresh if another caller already replaced the token', async () => {
    const { manager, store, server, time } = await setup(rotatingTokenEndpoint());
    await store.set(CONNECTION, tokenSet(time, { accessToken: 'already-new' }));
    const auth = manager.forConnection(CONNECTION);
    expect(await auth.refreshAccessToken!('old-rejected')).toBe('already-new');
    expect(server.requests).toHaveLength(0);
    expect(await auth.refreshAccessToken!('already-new')).toBe('access-1');
    expect(server.requests).toHaveLength(1);
  });

  it('on invalid_grant: removes the tokens and requires reauthorization', async () => {
    const { manager, store, server, time, onReauthorizationRequired } = await setup(
      (_request, response) => {
        sendJson(response, 400, { error: 'invalid_grant' });
      },
    );
    await store.set(CONNECTION, tokenSet(time, { expiresAt: 0 }));

    const results = await Promise.allSettled([
      manager.getAccessToken(CONNECTION),
      manager.getAccessToken(CONNECTION),
    ]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      const reason = (result as PromiseRejectedResult).reason as ReauthorizationRequiredError;
      expect(reason).toBeInstanceOf(ReauthorizationRequiredError);
      expect(reason.connectionId).toBe(CONNECTION);
      expect(reason.kind).toBe('auth');
    }
    expect(server.requests).toHaveLength(1);
    expect(onReauthorizationRequired).toHaveBeenCalledTimes(1);
    expect(await store.get(CONNECTION)).toBeUndefined();

    // Subsequent calls fail locally without contacting the provider.
    await expect(manager.getAccessToken(CONNECTION)).rejects.toBeInstanceOf(
      ReauthorizationRequiredError,
    );
    expect(server.requests).toHaveLength(1);
  });

  it('keeps tokens when the token endpoint fails transiently', async () => {
    const { manager, store, time, onReauthorizationRequired } = await setup(
      (_request, response) => {
        sendJson(response, 503, { error: 'temporarily_unavailable' });
      },
    );
    const tokens = tokenSet(time, { expiresAt: 0 });
    await store.set(CONNECTION, tokens);
    const error = await manager.getAccessToken(CONNECTION).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).retryable).toBe(true);
    expect(await store.get(CONNECTION)).toEqual(tokens);
    expect(onReauthorizationRequired).not.toHaveBeenCalled();
  });

  it('keeps tokens on invalid_client (a configuration problem, not a revocation)', async () => {
    const { manager, store, time } = await setup((_request, response) => {
      sendJson(response, 401, { error: 'invalid_client' });
    });
    await store.set(CONNECTION, tokenSet(time, { expiresAt: 0 }));
    const error = await manager.getAccessToken(CONNECTION).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect(error).not.toBeInstanceOf(ReauthorizationRequiredError);
    expect(await store.get(CONNECTION)).toBeDefined();
  });

  it('requires reauthorization when an expired token has no refresh token', async () => {
    const { manager, store, server, time } = await setup(rotatingTokenEndpoint());
    await store.set(CONNECTION, tokenSet(time, { expiresAt: 0, refreshToken: undefined }));
    await expect(manager.getAccessToken(CONNECTION)).rejects.toBeInstanceOf(
      ReauthorizationRequiredError,
    );
    expect(server.requests).toHaveLength(0);
  });
});

describe('FileTokenStore', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('persists tokens across instances and serializes concurrent writes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'integration-kit-'));
    const path = join(dir, 'nested', 'tokens.json');
    const store = new FileTokenStore(path);
    const time = new FakeTime();

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.set(`conn-${i}`, tokenSet(time, { accessToken: `a${i}` })),
      ),
    );
    await store.delete('conn-3');

    const reopened = new FileTokenStore(path);
    expect((await reopened.get('conn-9'))?.accessToken).toBe('a9');
    expect(await reopened.get('conn-3')).toBeUndefined();
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk)).toHaveLength(9);
  });

  it('returns undefined when the file does not exist yet', async () => {
    dir = await mkdtemp(join(tmpdir(), 'integration-kit-'));
    expect(await new FileTokenStore(join(dir, 'missing.json')).get('x')).toBeUndefined();
  });
});
