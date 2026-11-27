import { isIntegrationError } from '../errors.js';
import { type BackoffOptions, exponentialBackoff } from '../http/backoff.js';
import { type Clock, type Sleep, sleep as defaultSleep, systemClock } from '../internal/time.js';
import type { WebhookEvent, WebhookEventStore } from './event-store.js';

export type WebhookHandler = (
  event: WebhookEvent,
  context: { attempt: number; signal: AbortSignal },
) => Promise<void>;

export type WebhookWorkerEvent =
  | { type: 'processed'; event: WebhookEvent }
  | { type: 'retry_scheduled'; event: WebhookEvent; error: unknown; retryAt: number }
  | { type: 'dead_lettered'; event: WebhookEvent; error: unknown }
  | { type: 'lease_lost'; event: WebhookEvent }
  | { type: 'error'; error: unknown };

export interface WebhookWorkerOptions {
  store: WebhookEventStore;
  /** Handlers keyed by provider name. */
  handlers: Record<string, WebhookHandler>;
  /** Attempts before an event is dead-lettered. Default 5. */
  maxAttempts?: number;
  /** Retry delay policy. Default `{ baseMs: 1_000, maxMs: 5 * 60_000 }`. */
  backoff?: BackoffOptions;
  /** How long a claimed event is reserved for this worker. Default 60 s. */
  leaseMs?: number;
  batchSize?: number;
  /** Idle delay between polls when nothing is due. Default 1 s. */
  pollIntervalMs?: number;
  onEvent?: (event: WebhookWorkerEvent) => void;
  clock?: Clock;
  sleep?: Sleep;
  random?: () => number;
}

/**
 * Processes stored webhook events asynchronously with retries and a dead-letter state.
 *
 * Delivery to handlers is at-least-once: a crash after the handler's side effect but before
 * `complete()` means the event is processed again once its lease expires. Handlers should be
 * idempotent (e.g. upsert by the provider's object id).
 */
export class WebhookWorker {
  readonly #store: WebhookEventStore;
  readonly #handlers: Record<string, WebhookHandler>;
  readonly #maxAttempts: number;
  readonly #backoff: BackoffOptions;
  readonly #leaseMs: number;
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;
  readonly #onEvent: ((event: WebhookWorkerEvent) => void) | undefined;
  readonly #clock: Clock;
  readonly #sleep: Sleep;
  readonly #random: () => number;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(options: WebhookWorkerOptions) {
    this.#store = options.store;
    this.#handlers = options.handlers;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#backoff = options.backoff ?? { baseMs: 1_000, maxMs: 5 * 60_000 };
    this.#leaseMs = options.leaseMs ?? 60_000;
    this.#batchSize = options.batchSize ?? 10;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#onEvent = options.onEvent;
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  /** Claims and processes one batch of due events. Returns how many were claimed. */
  async processDue(signal: AbortSignal = new AbortController().signal): Promise<number> {
    const events = await this.#store.claim({
      limit: this.#batchSize,
      now: this.#clock.now(),
      leaseMs: this.#leaseMs,
    });
    await Promise.all(events.map((event) => this.#process(event, signal)));
    return events.length;
  }

  /** Starts polling in the background until `stop()` is called. */
  start(): void {
    if (this.#loop) return;
    const abort = new AbortController();
    this.#abort = abort;
    this.#loop = this.#run(abort.signal);
  }

  /** Stops polling and waits for the current batch to finish. */
  async stop(): Promise<void> {
    this.#abort?.abort();
    await this.#loop;
    this.#loop = undefined;
    this.#abort = undefined;
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let claimed = 0;
      try {
        claimed = await this.processDue(signal);
      } catch (error) {
        this.#emit({ type: 'error', error });
      }
      if (claimed === 0) {
        await this.#sleep(this.#pollIntervalMs, signal).catch(() => undefined);
      }
    }
  }

  async #process(event: WebhookEvent, signal: AbortSignal): Promise<void> {
    const handler = this.#handlers[event.provider];
    try {
      if (handler === undefined) {
        throw new Error(`No webhook handler registered for provider "${event.provider}"`);
      }
      await handler(event, { attempt: event.attempts, signal });
    } catch (error) {
      await this.#handleFailure(event, error, handler !== undefined);
      return;
    }
    const ok = await this.#store.complete(event.id, event.attempts, this.#clock.now());
    this.#emit(ok ? { type: 'processed', event } : { type: 'lease_lost', event });
  }

  async #handleFailure(event: WebhookEvent, error: unknown, hasHandler: boolean): Promise<void> {
    // Non-retryable integration errors (validation, not found, auth) will fail the same way
    // next time, so they go straight to the dead-letter state.
    const permanent = !hasHandler || (isIntegrationError(error) && !error.retryable);
    const exhausted = event.attempts >= this.#maxAttempts;
    const message = error instanceof Error ? error.message : String(error);

    if (permanent || exhausted) {
      const ok = await this.#store.fail(event.id, event.attempts, {
        error: message,
        retryAt: null,
      });
      this.#emit(ok ? { type: 'dead_lettered', event, error } : { type: 'lease_lost', event });
      return;
    }
    const retryAt =
      this.#clock.now() + exponentialBackoff(event.attempts, this.#backoff, this.#random);
    const ok = await this.#store.fail(event.id, event.attempts, { error: message, retryAt });
    this.#emit(
      ok ? { type: 'retry_scheduled', event, error, retryAt } : { type: 'lease_lost', event },
    );
  }

  #emit(event: WebhookWorkerEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // A throwing listener must not disrupt processing.
    }
  }
}
