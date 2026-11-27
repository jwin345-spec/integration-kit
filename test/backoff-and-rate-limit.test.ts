import { describe, expect, it } from 'vitest';
import { TokenBucket, exponentialBackoff, parseRetryAfter } from '../src/index.js';
import { FakeTime } from './helpers/time.js';

describe('parseRetryAfter', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it('parses delay-seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
  });

  it('parses an HTTP-date relative to now, clamping past dates to zero', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Thu, 01 Jan 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('ignores missing or invalid values', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
  });
});

describe('exponentialBackoff', () => {
  it('draws from a doubling window capped at maxMs', () => {
    const max = () => 0.999_999;
    expect(exponentialBackoff(1, { baseMs: 100 }, max)).toBe(99);
    expect(exponentialBackoff(3, { baseMs: 100 }, max)).toBe(399);
    expect(exponentialBackoff(20, { baseMs: 100, maxMs: 1000 }, max)).toBe(999);
    expect(exponentialBackoff(5, { baseMs: 100 }, () => 0)).toBe(0);
  });
});

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then paces at the refill rate', async () => {
    const time = new FakeTime();
    const bucket = new TokenBucket({
      capacity: 3,
      refillPerSecond: 2,
      clock: time,
      sleep: time.sleep,
    });
    for (let i = 0; i < 3; i++) await bucket.acquire();
    expect(time.sleeps).toEqual([]);
    await bucket.acquire();
    await bucket.acquire();
    expect(time.sleeps).toEqual([500, 500]);
  });

  it('serves concurrent callers in order without over-issuing tokens', async () => {
    const time = new FakeTime();
    const bucket = new TokenBucket({
      capacity: 1,
      refillPerSecond: 10,
      clock: time,
      sleep: time.sleep,
    });
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => bucket.acquire().then(() => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
    expect(time.sleeps).toEqual([100, 100]);
  });

  it('pause() holds every caller until the pause has elapsed', async () => {
    const time = new FakeTime();
    const bucket = new TokenBucket({
      capacity: 5,
      refillPerSecond: 5,
      clock: time,
      sleep: time.sleep,
    });
    bucket.pause(2000);
    await bucket.acquire();
    expect(time.sleeps).toEqual([2000]);
  });

  it('rejects a waiting caller when its signal aborts', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 0.001 });
    await bucket.acquire();
    const controller = new AbortController();
    const waiting = bucket.acquire(controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
  });
});
