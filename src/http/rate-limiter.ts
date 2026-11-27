import { type Clock, type Sleep, sleep as defaultSleep, systemClock } from '../internal/time.js';

export interface TokenBucketOptions {
  /** Maximum burst size. */
  capacity: number;
  /** Sustained rate, in tokens added per second. */
  refillPerSecond: number;
  clock?: Clock | undefined;
  sleep?: Sleep | undefined;
}

/**
 * Client-side token bucket. Keeps a single process under a provider's published rate limit so
 * that 429s are the exception rather than the steady state. Callers are served in FIFO order.
 *
 * `pause()` lets the HTTP client stop *all* callers when the provider says "slow down" via
 * `Retry-After`, instead of each in-flight request discovering the limit separately.
 */
export class TokenBucket {
  readonly #capacity: number;
  readonly #ratePerMs: number;
  readonly #clock: Clock;
  readonly #sleep: Sleep;
  #tokens: number;
  #updatedAt: number;
  #pausedUntil = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: TokenBucketOptions) {
    if (!(options.capacity >= 1)) throw new RangeError('capacity must be >= 1');
    if (!(options.refillPerSecond > 0)) throw new RangeError('refillPerSecond must be > 0');
    this.#capacity = options.capacity;
    this.#ratePerMs = options.refillPerSecond / 1000;
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#tokens = options.capacity;
    this.#updatedAt = this.#clock.now();
  }

  /** Resolves once a token has been taken. Rejects if `signal` aborts while waiting. */
  acquire(signal?: AbortSignal): Promise<void> {
    const turn = this.#queue.then(() => this.#take(signal));
    // Keep the chain alive even if this caller aborts.
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  /** Blocks every caller until at least `ms` from now. */
  pause(ms: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, this.#clock.now() + ms);
  }

  /** Tokens currently available (after refill). Mainly useful for tests and metrics. */
  available(): number {
    this.#refill();
    return this.#tokens;
  }

  async #take(signal: AbortSignal | undefined): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      this.#refill();
      const now = this.#clock.now();
      const pauseMs = this.#pausedUntil - now;
      if (pauseMs <= 0 && this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const refillMs = this.#tokens >= 1 ? 0 : Math.ceil((1 - this.#tokens) / this.#ratePerMs);
      await this.#sleep(Math.max(pauseMs, refillMs, 1), signal);
    }
  }

  #refill(): void {
    const now = this.#clock.now();
    const elapsed = Math.max(0, now - this.#updatedAt);
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#ratePerMs);
    this.#updatedAt = now;
  }
}
