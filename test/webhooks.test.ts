import { describe, expect, it, vi } from 'vitest';
import {
  MemoryWebhookEventStore,
  NotFoundError,
  ValidationError,
  type WebhookEventStore,
  type WebhookHandler,
  WebhookIntake,
  WebhookVerificationError,
  WebhookWorker,
  type WebhookWorkerEvent,
  hmacVerifier,
  signWebhook,
} from '../src/index.js';
import { FakeTime } from './helpers/time.js';

const SECRET = 'whsec_test';

function setup(handler: WebhookHandler = () => Promise.resolve()) {
  const time = new FakeTime();
  const store = new MemoryWebhookEventStore();
  const intake = new WebhookIntake({
    store,
    clock: time,
    providers: {
      acme: {
        verify: hmacVerifier({ signatureHeader: 'Acme-Signature', secrets: SECRET }),
        parse: (rawBody) => {
          const body = JSON.parse(rawBody) as { id: string; type: string };
          return { eventId: body.id, type: body.type };
        },
      },
    },
  });
  const seen: WebhookWorkerEvent[] = [];
  const spy = vi.fn(handler);
  const worker = new WebhookWorker({
    store,
    clock: time,
    sleep: time.sleep,
    random: () => 0.5,
    maxAttempts: 3,
    backoff: { baseMs: 1000, maxMs: 60_000 },
    leaseMs: 30_000,
    handlers: { acme: spy },
    onEvent: (e) => seen.push(e),
  });
  const deliver = (id: string, options: { at?: number; secret?: string } = {}) => {
    const rawBody = JSON.stringify({ id, type: 'contact.created', data: { n: 1 } });
    const ts = Math.floor((options.at ?? time.now()) / 1000);
    return intake.receive('acme', {
      headers: {
        'Acme-Signature': signWebhook(options.secret ?? SECRET, rawBody, ts),
        'content-type': 'application/json',
      },
      rawBody: Buffer.from(rawBody),
    });
  };
  return { time, store, intake, worker, handler: spy, seen, deliver };
}

describe('WebhookIntake', () => {
  it('persists a verified event before resolving, with the raw body and headers', async () => {
    const { deliver, store } = setup();
    const result = await deliver('evt_1');
    expect(result.status).toBe('accepted');
    const stored = await store.get(result.event.id);
    expect(stored).toMatchObject({
      provider: 'acme',
      eventId: 'evt_1',
      type: 'contact.created',
      status: 'pending',
      attempts: 0,
    });
    expect(JSON.parse(stored!.rawBody)).toEqual({
      id: 'evt_1',
      type: 'contact.created',
      data: { n: 1 },
    });
    expect(stored!.headers['acme-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('deduplicates redeliveries of the same provider event id', async () => {
    const { deliver, store } = setup();
    const first = await deliver('evt_1');
    const second = await deliver('evt_1');
    expect(second.status).toBe('duplicate');
    expect(second.event.id).toBe(first.event.id);
    expect(await store.list()).toHaveLength(1);
  });

  it('deduplicates concurrent duplicate deliveries', async () => {
    const { deliver, store } = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver('evt_1')));
    expect(results.filter((r) => r.status === 'accepted')).toHaveLength(1);
    expect(await store.list()).toHaveLength(1);
  });

  it('stores nothing when verification fails', async () => {
    const { deliver, store, time } = setup();
    await expect(deliver('evt_bad', { secret: 'wrong' })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
    await expect(deliver('evt_old', { at: time.now() - 10 * 60_000 })).rejects.toMatchObject({
      reason: 'timestamp_out_of_tolerance',
    });
    expect(await store.list()).toHaveLength(0);
  });

  it('rejects malformed envelopes and unknown providers as validation errors', async () => {
    const { intake, time } = setup();
    const rawBody = 'not json';
    const header = signWebhook(SECRET, rawBody, Math.floor(time.now() / 1000));
    await expect(
      intake.receive('acme', { headers: { 'acme-signature': header }, rawBody }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(intake.receive('nope', { headers: {}, rawBody: '{}' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('WebhookWorker', () => {
  it('processes each event once even if it was delivered several times', async () => {
    const { deliver, worker, handler, store } = setup();
    await deliver('evt_1');
    await deliver('evt_1');
    await deliver('evt_2');
    expect(await worker.processDue()).toBe(2);
    expect(await worker.processDue()).toBe(0);
    expect(handler).toHaveBeenCalledTimes(2);
    expect((await store.list({ status: 'processed' })).map((e) => e.eventId).sort()).toEqual([
      'evt_1',
      'evt_2',
    ]);
  });

  it('retries failures with backoff, then succeeds', async () => {
    let calls = 0;
    const { deliver, worker, store, time, seen } = setup(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(new Error(`flaky ${calls}`)) : Promise.resolve();
    });
    const { event } = await deliver('evt_1');

    await worker.processDue();
    let stored = await store.get(event.id);
    expect(stored).toMatchObject({ status: 'pending', attempts: 1, lastError: 'flaky 1' });
    expect(stored!.nextAttemptAt).toBe(time.now() + 500); // 0.5 * 1000 * 2^0

    // Not due yet: nothing is claimed.
    expect(await worker.processDue()).toBe(0);

    time.advance(500);
    await worker.processDue();
    stored = await store.get(event.id);
    expect(stored).toMatchObject({ status: 'pending', attempts: 2 });
    expect(stored!.nextAttemptAt).toBe(time.now() + 1000);

    time.advance(1000);
    await worker.processDue();
    expect(await store.get(event.id)).toMatchObject({ status: 'processed', attempts: 3 });
    expect(seen.map((e) => e.type)).toEqual(['retry_scheduled', 'retry_scheduled', 'processed']);
  });

  it('dead-letters an event after maxAttempts and can requeue it', async () => {
    let healthy = false;
    const { deliver, worker, store, time, seen } = setup(() =>
      healthy ? Promise.resolve() : Promise.reject(new Error('still broken')),
    );
    const { event } = await deliver('evt_1');
    for (let i = 0; i < 3; i++) {
      await worker.processDue();
      time.advance(60_000);
    }
    expect(await store.get(event.id)).toMatchObject({
      status: 'dead',
      attempts: 3,
      lastError: 'still broken',
    });
    expect(seen.at(-1)?.type).toBe('dead_lettered');
    expect(await worker.processDue()).toBe(0);

    healthy = true;
    expect(await store.requeue(event.id, time.now())).toBe(true);
    await worker.processDue();
    expect(await store.get(event.id)).toMatchObject({ status: 'processed' });
  });

  it('dead-letters non-retryable integration errors immediately', async () => {
    const { deliver, worker, store } = setup(() =>
      Promise.reject(new NotFoundError('contact no longer exists')),
    );
    const { event } = await deliver('evt_1');
    await worker.processDue();
    expect(await store.get(event.id)).toMatchObject({ status: 'dead', attempts: 1 });
  });

  it('reclaims events whose lease expired (worker crash) and fences out the stale worker', async () => {
    const { deliver, store, time, worker } = setup();
    const { event } = await deliver('evt_1');

    // A worker claims the event and then "crashes" (never completes it).
    const [claimed] = await store.claim({ limit: 10, now: time.now(), leaseMs: 30_000 });
    expect(claimed!.attempts).toBe(1);
    expect(await worker.processDue()).toBe(0); // still leased

    time.advance(30_000);
    expect(await worker.processDue()).toBe(1);
    expect(await store.get(event.id)).toMatchObject({ status: 'processed', attempts: 2 });

    // The stale worker wakes up and tries to record its outcome: rejected.
    expect(await store.complete(event.id, claimed!.attempts, time.now())).toBe(false);
    expect(await store.fail(event.id, claimed!.attempts, { error: 'x', retryAt: null })).toBe(
      false,
    );
  });

  it('dead-letters events for providers without a handler', async () => {
    const time = new FakeTime();
    const store: WebhookEventStore = new MemoryWebhookEventStore();
    await store.insert({
      provider: 'unknown',
      eventId: 'e',
      type: 't',
      rawBody: '{}',
      headers: {},
      receivedAt: time.now(),
    });
    const worker = new WebhookWorker({ store, handlers: {}, clock: time });
    await worker.processDue();
    const [event] = await store.list();
    expect(event!.status).toBe('dead');
    expect(event!.lastError).toMatch(/No webhook handler/);
  });

  it('start()/stop() polls in the background and stops cleanly', async () => {
    const store = new MemoryWebhookEventStore();
    const processed: string[] = [];
    const worker = new WebhookWorker({
      store,
      pollIntervalMs: 5,
      handlers: {
        acme: (event) => {
          processed.push(event.eventId);
          return Promise.resolve();
        },
      },
    });
    worker.start();
    await store.insert({
      provider: 'acme',
      eventId: 'evt_bg',
      type: 't',
      rawBody: '{}',
      headers: {},
      receivedAt: Date.now(),
    });
    await vi.waitFor(() => {
      expect(processed).toEqual(['evt_bg']);
    });
    await worker.stop();
  });
});
