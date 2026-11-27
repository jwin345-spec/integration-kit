import Fastify, { type FastifyInstance } from 'fastify';
import {
  type Integration,
  MemoryTokenStore,
  MemoryWebhookEventStore,
  ReauthorizationRequiredError,
  ValidationError,
  WebhookIntake,
  WebhookVerificationError,
  WebhookWorker,
  createIntegration,
  isIntegrationError,
} from '../../src/index.js';
import { type Contact, acmeProvider, listContacts, toContactEvent } from '../acme/adapter.js';

export interface DemoOptions {
  acmeBaseUrl: string;
  /** Where this app is reachable; used to build the OAuth redirect URI. */
  publicUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  logger?: boolean;
}

export interface Demo {
  app: FastifyInstance;
  integration: Integration;
  events: MemoryWebhookEventStore;
  worker: WebhookWorker;
  /** Local projection of Acme contacts, maintained from webhooks. */
  contacts: Map<string, Contact>;
}

/** Single connected account, to keep the demo small. */
const CONNECTION_ID = 'acme:demo-account';

export function buildDemo(options: DemoOptions): Demo {
  const app = Fastify({ logger: options.logger ?? false });
  const provider = acmeProvider({
    baseUrl: options.acmeBaseUrl,
    webhookSecret: options.webhookSecret,
  });
  const integration = createIntegration(provider, {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri: `${options.publicUrl}/oauth/callback`,
    tokenStore: new MemoryTokenStore(),
    onRetry: ({ attempt, delayMs, error }) => {
      app.log.warn({ attempt, delayMs, kind: error.kind }, `retrying: ${error.message}`);
    },
  });

  const events = new MemoryWebhookEventStore();
  const intake = new WebhookIntake({
    store: events,
    providers: provider.webhooks ? { acme: provider.webhooks } : {},
  });

  const contacts = new Map<string, Contact>();
  const worker = new WebhookWorker({
    store: events,
    pollIntervalMs: 250,
    handlers: {
      acme: (event) => {
        const domainEvent = toContactEvent(event);
        // Idempotent effects: upserts and deletes by external id are safe to repeat.
        if (domainEvent.kind === 'contact.upserted') {
          contacts.set(domainEvent.contact.externalId, domainEvent.contact);
        } else if (domainEvent.kind === 'contact.deleted') {
          contacts.delete(domainEvent.externalId);
        }
        return Promise.resolve();
      },
    },
    onEvent: (e) => {
      if (e.type !== 'error') app.log.info({ eventId: e.event.eventId }, `webhook ${e.type}`);
      else app.log.error(e.error, 'webhook worker error');
    },
  });

  const pendingAuthorizations = new Map<string, string | undefined>(); // state -> PKCE verifier

  app.get('/', () => ({
    steps: [
      'GET  /connect             start the OAuth flow (open in a browser or follow redirects)',
      'GET  /contacts            list contacts through the paginated, rate-limited client',
      'POST /webhooks/acme       signed webhook intake',
      'GET  /webhooks/events     inspect stored events and their status',
      'GET  /local-contacts      contacts projected from processed webhooks',
    ],
  }));

  app.get('/connect', async (_request, reply) => {
    const { url, state, codeVerifier } = integration.oauth.createAuthorizationRequest();
    pendingAuthorizations.set(state, codeVerifier);
    return reply.redirect(url);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/oauth/callback',
    async (request, reply) => {
      const { code, state } = request.query;
      // The Map lookup is the state check: unknown or reused states are rejected.
      if (code === undefined || state === undefined || !pendingAuthorizations.has(state)) {
        return reply.code(400).send({ error: 'invalid_state' });
      }
      const verifier = pendingAuthorizations.get(state);
      pendingAuthorizations.delete(state);
      const tokens = await integration.oauth.exchangeCode(code, verifier);
      await integration.tokens.save(CONNECTION_ID, tokens);
      return { connected: CONNECTION_ID, expiresAt: tokens.expiresAt, scope: tokens.scope };
    },
  );

  app.get('/contacts', async (_request, reply) => {
    try {
      const all: Contact[] = [];
      for await (const contact of listContacts(integration.client(CONNECTION_ID))) {
        all.push(contact);
      }
      return { count: all.length, first: all.slice(0, 3) };
    } catch (error) {
      if (error instanceof ReauthorizationRequiredError) {
        return reply.code(409).send({ error: 'reauthorization_required', connect: '/connect' });
      }
      if (isIntegrationError(error)) {
        return reply.code(502).send({ error: error.kind, message: error.message });
      }
      throw error;
    }
  });

  void app.register((scope, _opts, done) => {
    // Signatures are computed over the exact bytes, so keep the body as a Buffer.
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, next) => {
      next(null, body);
    });
    scope.post<{ Params: { provider: string }; Body: Buffer }>(
      '/webhooks/:provider',
      async (request, reply) => {
        try {
          const result = await intake.receive(request.params.provider, {
            headers: request.headers,
            rawBody: request.body,
          });
          // Persisted: now it is safe to acknowledge.
          return await reply
            .code(result.status === 'accepted' ? 202 : 200)
            .send({ status: result.status, id: result.event.id });
        } catch (error) {
          if (error instanceof WebhookVerificationError) {
            return reply.code(401).send({ error: error.reason });
          }
          if (error instanceof ValidationError) {
            return reply.code(400).send({ error: 'invalid_payload' });
          }
          throw error;
        }
      },
    );
    done();
  });

  app.get('/webhooks/events', async () => {
    const all = await events.list();
    return all.map(({ rawBody: _rawBody, headers: _headers, ...summary }) => summary);
  });

  app.get('/local-contacts', () => [...contacts.values()]);

  app.addHook('onClose', async () => {
    await worker.stop();
  });

  return { app, integration, events, worker, contacts };
}
