import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { acmeProvider, listContacts } from '../examples/acme/adapter.js';
import { type MockAcme, createMockAcme } from '../examples/acme/mock-acme.js';
import { buildDemo } from '../examples/demo/app.js';
import {
  MemoryTokenStore,
  RateLimitedError,
  ReauthorizationRequiredError,
  createIntegration,
  signWebhook,
} from '../src/index.js';
import { FakeTime } from './helpers/time.js';

const credentials = { clientId: 'cid', clientSecret: 'csecret', webhookSecret: 'whsec' };

let acme: MockAcme | undefined;
afterEach(async () => {
  await acme?.app.close();
  acme = undefined;
});

async function startAcme(): Promise<string> {
  acme = createMockAcme({ ...credentials, contactCount: 230 });
  await acme.app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(acme.app.server.address() as AddressInfo).port}`;
}

describe('acme example adapter', () => {
  it('connects via OAuth and pages through contacts, absorbing rate limits', async () => {
    const baseUrl = await startAcme();
    const time = new FakeTime(Date.now());
    const retries: number[] = [];
    const integration = createIntegration(acmeProvider({ baseUrl, webhookSecret: 'whsec' }), {
      ...credentials,
      redirectUri: 'http://app.test/callback',
      tokenStore: new MemoryTokenStore(),
      sleep: time.sleep,
      onRetry: ({ delayMs, error }) => {
        expect(error).toBeInstanceOf(RateLimitedError);
        retries.push(delayMs);
      },
    });

    // Authorization: follow the provider's redirect manually and pick up the code.
    const { url, state, codeVerifier } = integration.oauth.createAuthorizationRequest();
    const redirect = await fetch(url, { redirect: 'manual' });
    const callback = new URL(redirect.headers.get('location')!);
    expect(callback.searchParams.get('state')).toBe(state);
    const tokens = await integration.oauth.exchangeCode(
      callback.searchParams.get('code')!,
      codeVerifier,
    );
    await integration.tokens.save('acct-1', tokens);

    const contacts = [];
    for await (const contact of listContacts(integration.client('acct-1'))) contacts.push(contact);

    expect(contacts).toHaveLength(230);
    expect(contacts[0]).toEqual({
      externalId: 'con_0001',
      name: 'Contact 1',
      email: undefined, // Acme's null email is mapped to undefined
      createdAt: new Date(1_700_000_000 * 1000),
    });
    // Pages 1 and 2 succeed, request 3 is rate limited with retry_after: 1 (in the body).
    expect(retries).toEqual([1000]);
  });

  it('surfaces a revoked refresh token as ReauthorizationRequiredError', async () => {
    const baseUrl = await startAcme();
    const integration = createIntegration(acmeProvider({ baseUrl, webhookSecret: 'whsec' }), {
      ...credentials,
      redirectUri: 'http://app.test/callback',
      tokenStore: new MemoryTokenStore(),
    });
    await integration.tokens.save('acct-1', {
      accessToken: 'expired',
      refreshToken: 'unknown-to-acme',
      expiresAt: 0,
      tokenType: 'Bearer',
    });
    const iterator = listContacts(integration.client('acct-1'));
    await expect(iterator.next()).rejects.toBeInstanceOf(ReauthorizationRequiredError);
  });
});

describe('demo server webhook route', () => {
  function demo() {
    return buildDemo({
      ...credentials,
      acmeBaseUrl: 'http://127.0.0.1:1',
      publicUrl: 'http://127.0.0.1:3000',
    });
  }

  function signed(id: string, timestamp = Math.floor(Date.now() / 1000)) {
    const payload = JSON.stringify({
      id,
      type: 'contact.created',
      data: {
        contact: { id: 'con_9', full_name: 'Ada', email_address: 'ada@example.com', created: 1 },
      },
    });
    return {
      method: 'POST' as const,
      url: '/webhooks/acme',
      payload,
      headers: {
        'content-type': 'application/json',
        'acme-signature': signWebhook('whsec', payload, timestamp),
      },
    };
  }

  it('acknowledges with 202, then 200 for a redelivery, and processes once', async () => {
    const { app, worker, contacts, events } = demo();
    try {
      const first = await app.inject(signed('evt_1'));
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({ status: 'accepted' });

      const again = await app.inject(signed('evt_1'));
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ status: 'duplicate' });

      await worker.processDue();
      expect(contacts.get('con_9')?.name).toBe('Ada');
      expect(await events.list({ status: 'processed' })).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('rejects bad signatures and stale replays with 401 without storing them', async () => {
    const { app, events } = demo();
    try {
      const tampered = signed('evt_2');
      tampered.payload = tampered.payload.replace('Ada', 'Eve');
      expect((await app.inject(tampered)).statusCode).toBe(401);

      const stale = await app.inject(signed('evt_3', Math.floor(Date.now() / 1000) - 3600));
      expect(stale.statusCode).toBe(401);
      expect(stale.json()).toEqual({ error: 'timestamp_out_of_tolerance' });

      expect(await events.list()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
