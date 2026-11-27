/**
 * Adapter for "Acme", a fictional CRM. This file is the entire integration: endpoints, error
 * mapping, pagination style, webhook envelope, and mapping into internal models. OAuth, token
 * refresh, retries, rate limiting, signature checks and deduplication come from integration-kit.
 */
import {
  AuthError,
  type HttpClient,
  type ProviderDefinition,
  NotFoundError,
  RateLimitedError,
  UpstreamError,
  ValidationError,
  type WebhookEvent,
  cursorPagination,
  defineProvider,
  hmacVerifier,
} from '../../src/index.js';

// ---- Acme wire formats (never leak past this file) -------------------------------------------

interface AcmeContact {
  id: string;
  full_name: string;
  email_address: string | null;
  created: number; // unix seconds
}

interface AcmeErrorBody {
  error?: { type?: string; message?: string; retry_after?: number; field?: string };
}

interface AcmeEventBody {
  id: string;
  type: string;
  data: { contact: AcmeContact };
}

// ---- Internal model --------------------------------------------------------------------------

export interface Contact {
  externalId: string;
  name: string;
  email: string | undefined;
  createdAt: Date;
}

export function toContact(raw: AcmeContact): Contact {
  return {
    externalId: raw.id,
    name: raw.full_name,
    email: raw.email_address ?? undefined,
    createdAt: new Date(raw.created * 1000),
  };
}

// ---- Provider definition ---------------------------------------------------------------------

export interface AcmeConfig {
  /** e.g. https://api.acme.example (the demo points this at a local mock). */
  baseUrl: string;
  webhookSecret: string;
}

export function acmeProvider(config: AcmeConfig): ProviderDefinition {
  return defineProvider({
    name: 'acme',
    oauth: {
      authorizeUrl: `${config.baseUrl}/oauth/authorize`,
      tokenUrl: `${config.baseUrl}/oauth/token`,
      scopes: ['contacts:read'],
    },
    api: {
      baseUrl: `${config.baseUrl}/v1`,
      rateLimit: { capacity: 10, refillPerSecond: 5 }, // Acme documents 5 req/s per account
      normalizeError: ({ status, body }) => {
        const error = (body as AcmeErrorBody | undefined)?.error;
        const options = { provider: 'acme', status, code: error?.type, details: body };
        const message = `Acme: ${error?.message ?? `HTTP ${status}`}`;
        switch (error?.type) {
          case 'unauthorized':
            return new AuthError(message, options);
          case 'not_found':
            return new NotFoundError(message, options);
          case 'invalid_request':
            return new ValidationError(message, options);
          case 'rate_limited':
            // Acme puts the delay in the body, not in Retry-After.
            return new RateLimitedError(message, {
              ...options,
              retryAfterMs: error.retry_after === undefined ? undefined : error.retry_after * 1000,
            });
          case 'server_error':
            return new UpstreamError(message, options);
          default:
            return undefined; // fall back to status-code mapping
        }
      },
    },
    webhooks: {
      verify: hmacVerifier({ signatureHeader: 'acme-signature', secrets: config.webhookSecret }),
      parse: (rawBody) => {
        const body = JSON.parse(rawBody) as Partial<AcmeEventBody>;
        if (typeof body.id !== 'string' || typeof body.type !== 'string') {
          throw new Error('Acme event is missing id or type');
        }
        return { eventId: body.id, type: body.type };
      },
    },
  });
}

// ---- Operations used by business logic --------------------------------------------------------

export function listContacts(client: HttpClient): AsyncGenerator<Contact, void, undefined> {
  return client.paginate(
    { path: '/contacts' },
    cursorPagination({
      pageSize: 100,
      items: (body) => (body as { data: AcmeContact[] }).data.map(toContact),
      nextCursor: (body) => (body as { next_cursor: string | null }).next_cursor,
    }),
  );
}

export type ContactEvent =
  | { kind: 'contact.upserted'; contact: Contact }
  | { kind: 'contact.deleted'; externalId: string }
  | { kind: 'ignored'; type: string };

/** Turns a stored Acme webhook into an internal domain event. */
export function toContactEvent(event: WebhookEvent): ContactEvent {
  const body = JSON.parse(event.rawBody) as AcmeEventBody;
  switch (body.type) {
    case 'contact.created':
    case 'contact.updated':
      return { kind: 'contact.upserted', contact: toContact(body.data.contact) };
    case 'contact.deleted':
      return { kind: 'contact.deleted', externalId: body.data.contact.id };
    default:
      return { kind: 'ignored', type: body.type };
  }
}
