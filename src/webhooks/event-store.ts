import { randomUUID } from 'node:crypto';

export type WebhookEventStatus = 'pending' | 'processing' | 'processed' | 'dead';

export interface NewWebhookEvent {
  provider: string;
  /** The provider's own event id; the deduplication key together with `provider`. */
  eventId: string;
  type: string;
  /** Exact body as received, so the event can be re-parsed or re-verified later. */
  rawBody: string;
  headers: Record<string, string>;
  receivedAt: number;
}

export interface WebhookEvent extends NewWebhookEvent {
  id: string;
  status: WebhookEventStatus;
  /** Number of processing attempts started so far. */
  attempts: number;
  /** Earliest time the next attempt may start (epoch ms). */
  nextAttemptAt: number;
  /** While `processing`: when the lease expires and another worker may reclaim the event. */
  lockedUntil: number | undefined;
  lastError: string | undefined;
  processedAt: number | undefined;
}

export interface ClaimOptions {
  limit: number;
  now: number;
  leaseMs: number;
}

/**
 * Durable record of received webhooks. A SQL implementation would use a unique index on
 * `(provider, event_id)` for `insert` and `FOR UPDATE SKIP LOCKED` (or a conditional update)
 * for `claim`.
 */
export interface WebhookEventStore {
  /** Inserts the event unless `(provider, eventId)` already exists. Must be atomic. */
  insert(event: NewWebhookEvent): Promise<{ inserted: boolean; event: WebhookEvent }>;
  /**
   * Atomically leases up to `limit` events that are due: `pending` with `nextAttemptAt <= now`,
   * or `processing` with an expired lease (a worker crashed). Increments `attempts`.
   */
  claim(options: ClaimOptions): Promise<WebhookEvent[]>;
  /**
   * Marks a leased event processed. `attempt` fences out a worker whose lease expired and was
   * taken over; returns `false` in that case.
   */
  complete(id: string, attempt: number, now: number): Promise<boolean>;
  /** Schedules a retry at `retryAt`, or dead-letters the event when `retryAt` is `null`. */
  fail(
    id: string,
    attempt: number,
    failure: { error: string; retryAt: number | null },
  ): Promise<boolean>;
  /** Moves a dead-lettered event back to `pending` (after fixing the cause). */
  requeue(id: string, now: number): Promise<boolean>;
  get(id: string): Promise<WebhookEvent | undefined>;
  list(filter?: { status?: WebhookEventStatus; provider?: string }): Promise<WebhookEvent[]>;
}

export class MemoryWebhookEventStore implements WebhookEventStore {
  readonly #byId = new Map<string, WebhookEvent>();
  readonly #byKey = new Map<string, string>();

  insert(input: NewWebhookEvent): Promise<{ inserted: boolean; event: WebhookEvent }> {
    const key = `${input.provider}\u0000${input.eventId}`;
    const existingId = this.#byKey.get(key);
    const existing = existingId === undefined ? undefined : this.#byId.get(existingId);
    if (existing) return Promise.resolve({ inserted: false, event: { ...existing } });

    const event: WebhookEvent = {
      ...input,
      headers: { ...input.headers },
      id: randomUUID(),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: input.receivedAt,
      lockedUntil: undefined,
      lastError: undefined,
      processedAt: undefined,
    };
    this.#byId.set(event.id, event);
    this.#byKey.set(key, event.id);
    return Promise.resolve({ inserted: true, event: { ...event } });
  }

  claim({ limit, now, leaseMs }: ClaimOptions): Promise<WebhookEvent[]> {
    const due = [...this.#byId.values()]
      .filter(
        (e) =>
          (e.status === 'pending' && e.nextAttemptAt <= now) ||
          (e.status === 'processing' && (e.lockedUntil ?? 0) <= now),
      )
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.receivedAt - b.receivedAt)
      .slice(0, limit);
    for (const event of due) {
      event.status = 'processing';
      event.attempts += 1;
      event.lockedUntil = now + leaseMs;
    }
    return Promise.resolve(due.map((e) => ({ ...e })));
  }

  complete(id: string, attempt: number, now: number): Promise<boolean> {
    const event = this.#leased(id, attempt);
    if (!event) return Promise.resolve(false);
    event.status = 'processed';
    event.processedAt = now;
    event.lockedUntil = undefined;
    event.lastError = undefined;
    return Promise.resolve(true);
  }

  fail(
    id: string,
    attempt: number,
    failure: { error: string; retryAt: number | null },
  ): Promise<boolean> {
    const event = this.#leased(id, attempt);
    if (!event) return Promise.resolve(false);
    event.lastError = failure.error;
    event.lockedUntil = undefined;
    if (failure.retryAt === null) {
      event.status = 'dead';
    } else {
      event.status = 'pending';
      event.nextAttemptAt = failure.retryAt;
    }
    return Promise.resolve(true);
  }

  requeue(id: string, now: number): Promise<boolean> {
    const event = this.#byId.get(id);
    if (event?.status !== 'dead') return Promise.resolve(false);
    event.status = 'pending';
    event.attempts = 0;
    event.nextAttemptAt = now;
    return Promise.resolve(true);
  }

  get(id: string): Promise<WebhookEvent | undefined> {
    const event = this.#byId.get(id);
    return Promise.resolve(event === undefined ? undefined : { ...event });
  }

  list(filter: { status?: WebhookEventStatus; provider?: string } = {}): Promise<WebhookEvent[]> {
    return Promise.resolve(
      [...this.#byId.values()]
        .filter((e) => filter.status === undefined || e.status === filter.status)
        .filter((e) => filter.provider === undefined || e.provider === filter.provider)
        .map((e) => ({ ...e })),
    );
  }

  #leased(id: string, attempt: number): WebhookEvent | undefined {
    const event = this.#byId.get(id);
    if (event?.status !== 'processing' || event.attempts !== attempt) return undefined;
    return event;
  }
}
