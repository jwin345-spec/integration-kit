import type { Clock, Sleep } from '../../src/index.js';

/** Manually advanced clock plus a `sleep` that advances it instantly and records each delay. */
export class FakeTime implements Clock {
  readonly sleeps: number[] = [];
  #now: number;

  constructor(start = Date.UTC(2026, 0, 1)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  readonly sleep: Sleep = (ms) => {
    this.sleeps.push(ms);
    this.advance(ms);
    return Promise.resolve();
  };
}
