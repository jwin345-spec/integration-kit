/**
 * A tiny local stand-in for the fictional Acme API, used by the demo server so it runs without
 * any network access. It deliberately misbehaves: access tokens are short-lived, refresh tokens
 * rotate, and every third contacts request is rate limited.
 */
import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { signWebhook } from '../../src/index.js';

export interface MockAcmeOptions {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  accessTokenTtlSeconds?: number;
  contactCount?: number;
}

export interface MockAcme {
  app: FastifyInstance;
  /** Sends a signed webhook to `targetUrl`. Pass the same `eventId` twice to simulate redelivery. */
  emitWebhook(targetUrl: string, event: { id: string; type: string }): Promise<number>;
}

const token = (): string => randomBytes(16).toString('hex');

export function createMockAcme(options: MockAcmeOptions): MockAcme {
  const app = Fastify({ logger: false });
  const ttl = options.accessTokenTtlSeconds ?? 120;
  const codes = new Map<string, { challenge: string | undefined; redirectUri: string }>();
  const accessTokens = new Map<string, number>(); // token -> expires at (ms)
  const refreshTokens = new Set<string>();
  let contactsRequests = 0;

  const contacts = Array.from({ length: options.contactCount ?? 250 }, (_, i) => ({
    id: `con_${String(i + 1).padStart(4, '0')}`,
    full_name: `Contact ${i + 1}`,
    email_address: i % 7 === 0 ? null : `contact${i + 1}@example.com`,
    created: 1_700_000_000 + i * 60,
  }));

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  app.get<{ Querystring: Record<string, string> }>('/oauth/authorize', async (request, reply) => {
    const { redirect_uri: redirectUri, state, code_challenge: challenge } = request.query;
    if (redirectUri === undefined || state === undefined) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const code = token();
    codes.set(code, { challenge, redirectUri });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
    return reply.redirect(target.toString());
  });

  app.post<{ Body: Record<string, string> }>('/oauth/token', async (request, reply) => {
    const expected = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`;
    if (request.headers.authorization !== expected) {
      return reply.code(401).send({ error: 'invalid_client' });
    }
    const body = request.body;
    if (body.grant_type === 'authorization_code') {
      const entry = codes.get(body.code ?? '');
      codes.delete(body.code ?? '');
      const verifier = body.code_verifier ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!entry || entry.redirectUri !== body.redirect_uri || entry.challenge !== challenge) {
        return reply.code(400).send({ error: 'invalid_grant' });
      }
    } else if (body.grant_type === 'refresh_token') {
      // Rotation: each refresh token is single-use.
      if (!refreshTokens.delete(body.refresh_token ?? '')) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'revoked' });
      }
    } else {
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }
    const access = token();
    const refresh = token();
    accessTokens.set(access, Date.now() + ttl * 1000);
    refreshTokens.add(refresh);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: ttl,
      scope: 'contacts:read',
    };
  });

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/v1/contacts',
    async (request, reply) => {
      const auth = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const expiresAt = accessTokens.get(auth);
      if (expiresAt === undefined || expiresAt < Date.now()) {
        return reply.code(401).send({ error: { type: 'unauthorized', message: 'Invalid token' } });
      }
      contactsRequests += 1;
      if (contactsRequests % 3 === 0) {
        return reply
          .code(429)
          .send({ error: { type: 'rate_limited', message: 'Slow down', retry_after: 1 } });
      }
      const start = Number(request.query.cursor ?? 0);
      const limit = Math.min(Number(request.query.limit ?? 50), 100);
      const page = contacts.slice(start, start + limit);
      const next = start + limit < contacts.length ? String(start + limit) : null;
      return { data: page, next_cursor: next };
    },
  );

  return {
    app,
    async emitWebhook(targetUrl, event) {
      const contact = contacts[0];
      const rawBody = JSON.stringify({ id: event.id, type: event.type, data: { contact } });
      const signature = signWebhook(options.webhookSecret, rawBody, Math.floor(Date.now() / 1000));
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'acme-signature': signature },
        body: rawBody,
      });
      return response.status;
    },
  };
}
