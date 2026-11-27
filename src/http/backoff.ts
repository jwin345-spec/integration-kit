export interface BackoffOptions {
  /** Delay ceiling for the first retry. Default 250 ms. */
  baseMs?: number | undefined;
  /** Upper bound for any single delay. Default 30 s. */
  maxMs?: number | undefined;
}

/**
 * Full-jitter exponential backoff: a uniform draw from `[0, min(maxMs, baseMs * 2^(attempt-1)))`.
 * `attempt` is 1 for the first retry. Jitter spreads out clients that failed at the same moment
 * so they do not hammer the provider in lockstep when it recovers.
 */
export function exponentialBackoff(
  attempt: number,
  options: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const baseMs = options.baseMs ?? 250;
  const maxMs = options.maxMs ?? 30_000;
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}

/**
 * Parses a `Retry-After` header (RFC 9110 §10.2.3): either delay-seconds or an HTTP-date.
 * Returns the delay in milliseconds, or `undefined` if the header is absent or unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // An HTTP-date always contains a month/day name. Without this check, `Date.parse` happily
  // reads values like "-5" or "2" as years.
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
