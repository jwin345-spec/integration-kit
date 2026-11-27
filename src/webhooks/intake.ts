import { ValidationError } from '../errors.js';
import { type Clock, systemClock } from '../internal/time.js';
import type { WebhookEvent, WebhookEventStore } from './event-store.js';
import { verifyWebhookSignature } from './signature.js';

export type IncomingHeaders = Record<string, string | readonly string[] | undefined>;

export interface WebhookDelivery {
  headers: IncomingHeaders;
  rawBody: string | Buffer;
}

export interface ParsedEnvelope {
  eventId: string;
  type: string;
}

/** The provider-specific half of webhook intake. */
export interface WebhookVerifier {
  /** Throws `WebhookVerificationError` if the delivery is not authentic or not fresh. */
  verify(
    delivery: { headers: Record<string, string>; rawBody: string | Buffer },
    now: number,
  ): void;
  /** Extracts the provider's event id and type. Throw if the body is not a valid envelope. */
  parse(rawBody: string, headers: Record<string, string>): ParsedEnvelope;
}

export interface WebhookIntakeOptions {
  store: WebhookEventStore;
  /** Verifiers keyed by provider name. */
  providers: Record<string, WebhookVerifier>;
  clock?: Clock;
}

export interface IntakeResult {
  /** `duplicate` means the provider redelivered an event that is already stored. */
  status: 'accepted' | 'duplicate';
  event: WebhookEvent;
}

/**
 * The synchronous part of webhook handling, designed to finish in milliseconds:
 * verify → parse envelope → persist (deduplicated) → return. All real work happens later in
 * `WebhookWorker`, so a slow handler never causes provider timeouts and redeliveries.
 *
 * Respond 2xx only after `receive()` resolves: the event is then durable, and acknowledging
 * earlier could lose it if the process dies.
 */
export class WebhookIntake {
  readonly #store: WebhookEventStore;
  readonly #providers: Record<string, WebhookVerifier>;
  readonly #clock: Clock;

  constructor(options: WebhookIntakeOptions) {
    this.#store = options.store;
    this.#providers = options.providers;
    this.#clock = options.clock ?? systemClock;
  }

  async receive(provider: string, delivery: WebhookDelivery): Promise<IntakeResult> {
    const verifier = this.#providers[provider];
    if (verifier === undefined) {
      throw new ValidationError(`Unknown webhook provider: ${provider}`, { provider });
    }
    const headers = normalizeHeaders(delivery.headers);
    const now = this.#clock.now();

    // Verify against the raw bytes before parsing anything an attacker controls.
    verifier.verify({ headers, rawBody: delivery.rawBody }, now);

    const rawBody =
      typeof delivery.rawBody === 'string' ? delivery.rawBody : delivery.rawBody.toString('utf8');
    let envelope: ParsedEnvelope;
    try {
      envelope = verifier.parse(rawBody, headers);
    } catch (error) {
      throw new ValidationError(`Malformed ${provider} webhook payload`, {
        provider,
        cause: error,
      });
    }

    const { inserted, event } = await this.#store.insert({
      provider,
      eventId: envelope.eventId,
      type: envelope.type,
      rawBody,
      headers,
      receivedAt: now,
    });
    return { status: inserted ? 'accepted' : 'duplicate', event };
  }
}

export interface HmacVerifierOptions {
  /** Header that carries `t=...,v1=...`. Case-insensitive. */
  signatureHeader: string;
  secrets: string | readonly string[];
  toleranceSeconds?: number | undefined;
}

/** `WebhookVerifier.verify` for the common timestamped HMAC-SHA256 scheme. */
export function hmacVerifier(options: HmacVerifierOptions): WebhookVerifier['verify'] {
  const header = options.signatureHeader.toLowerCase();
  return ({ headers, rawBody }, now) => {
    verifyWebhookSignature({
      header: headers[header],
      rawBody,
      secrets: options.secrets,
      now,
      toleranceSeconds: options.toleranceSeconds,
    });
  };
}

function normalizeHeaders(headers: IncomingHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[name.toLowerCase()] = typeof value === 'string' ? value : value.join(', ');
  }
  return result;
}
