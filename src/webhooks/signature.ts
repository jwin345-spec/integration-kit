import { WebhookVerificationError } from '../errors.js';
import { constantTimeEqual, hmacSha256Hex } from '../internal/crypto.js';

/**
 * Timestamped HMAC-SHA256 signatures, the scheme used (with small variations) by most providers:
 *
 *     Signature-Header: t=1700000000,v1=<hex hmac of "1700000000.<raw body>">
 *
 * Signing the timestamp together with the body means an attacker cannot replay an old delivery
 * with a fresh timestamp, and the tolerance window bounds how long a captured delivery stays
 * valid. Within the window, duplicate deliveries are caught by event-id deduplication.
 */

export function signWebhook(
  secret: string,
  rawBody: string | Buffer,
  timestampSeconds: number,
): string {
  return `t=${timestampSeconds},v1=${computeSignature(secret, rawBody, timestampSeconds)}`;
}

export interface VerifyWebhookSignatureOptions {
  /** The signature header value, e.g. `t=...,v1=...`. */
  header: string | undefined;
  /** The exact bytes received. Re-serialized JSON will not match. */
  rawBody: string | Buffer;
  /** One or more secrets; pass several while rotating. */
  secrets: string | readonly string[];
  /** Maximum age (and future skew) of the timestamp. Default 300 s. */
  toleranceSeconds?: number | undefined;
  /** Current time in epoch milliseconds. */
  now: number;
}

/** Throws `WebhookVerificationError` unless the signature is valid and fresh. */
export function verifyWebhookSignature(options: VerifyWebhookSignatureOptions): {
  timestamp: number;
} {
  const { header, rawBody, now } = options;
  if (header === undefined || header.trim() === '') {
    throw new WebhookVerificationError('missing_signature');
  }

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && value !== '') signatures.push(value);
  }
  if (timestamp === undefined || signatures.length === 0) {
    throw new WebhookVerificationError('malformed_signature');
  }

  const toleranceSeconds = options.toleranceSeconds ?? 300;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) {
    throw new WebhookVerificationError(
      'timestamp_out_of_tolerance',
      `Webhook timestamp is outside the ${toleranceSeconds}s tolerance window`,
    );
  }

  const secrets = typeof options.secrets === 'string' ? [options.secrets] : options.secrets;
  const ts = timestamp;
  // Compare against every candidate without short-circuiting on the first mismatch.
  let matched = false;
  for (const secret of secrets) {
    const expected = computeSignature(secret, rawBody, ts);
    for (const signature of signatures) {
      if (constantTimeEqual(expected, signature.toLowerCase())) matched = true;
    }
  }
  if (!matched) throw new WebhookVerificationError('signature_mismatch');
  return { timestamp };
}

function computeSignature(secret: string, rawBody: string | Buffer, timestamp: number): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return hmacSha256Hex(secret, Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]));
}
