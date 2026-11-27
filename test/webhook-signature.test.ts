import { describe, expect, it } from 'vitest';
import { WebhookVerificationError, signWebhook, verifyWebhookSignature } from '../src/index.js';

const SECRET = 'whsec_test';
const BODY = '{"id":"evt_1","type":"contact.created"}';
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const NOW_S = NOW / 1000;

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof WebhookVerificationError) return error.reason;
    throw error;
  }
  return undefined;
}

describe('webhook signatures', () => {
  it('accepts a correctly signed, fresh delivery', () => {
    const header = signWebhook(SECRET, BODY, NOW_S);
    expect(verifyWebhookSignature({ header, rawBody: BODY, secrets: SECRET, now: NOW })).toEqual({
      timestamp: NOW_S,
    });
    // Buffers (as received from the socket) verify the same way.
    expect(() =>
      verifyWebhookSignature({ header, rawBody: Buffer.from(BODY), secrets: SECRET, now: NOW }),
    ).not.toThrow();
  });

  it('rejects a tampered body', () => {
    const header = signWebhook(SECRET, BODY, NOW_S);
    const tampered = BODY.replace('created', 'deleted');
    expect(
      reason(() =>
        verifyWebhookSignature({ header, rawBody: tampered, secrets: SECRET, now: NOW }),
      ),
    ).toBe('signature_mismatch');
  });

  it('rejects the wrong secret', () => {
    const header = signWebhook('other-secret', BODY, NOW_S);
    expect(
      reason(() => verifyWebhookSignature({ header, rawBody: BODY, secrets: SECRET, now: NOW })),
    ).toBe('signature_mismatch');
  });

  it('rejects a replay of a captured delivery once it is outside the tolerance window', () => {
    const captured = signWebhook(SECRET, BODY, NOW_S);
    const later = NOW + 301_000;
    expect(
      reason(() =>
        verifyWebhookSignature({ header: captured, rawBody: BODY, secrets: SECRET, now: later }),
      ),
    ).toBe('timestamp_out_of_tolerance');
    // Inside the window it still verifies; event-id dedupe handles that case.
    expect(() =>
      verifyWebhookSignature({
        header: captured,
        rawBody: BODY,
        secrets: SECRET,
        now: NOW + 299_000,
      }),
    ).not.toThrow();
  });

  it('rejects a replay where the attacker swaps in a fresh timestamp', () => {
    const captured = signWebhook(SECRET, BODY, NOW_S - 3600);
    const signature = captured.split('v1=')[1]!;
    const forged = `t=${NOW_S},v1=${signature}`;
    expect(
      reason(() =>
        verifyWebhookSignature({ header: forged, rawBody: BODY, secrets: SECRET, now: NOW }),
      ),
    ).toBe('signature_mismatch');
  });

  it('rejects timestamps too far in the future', () => {
    const header = signWebhook(SECRET, BODY, NOW_S + 600);
    expect(
      reason(() => verifyWebhookSignature({ header, rawBody: BODY, secrets: SECRET, now: NOW })),
    ).toBe('timestamp_out_of_tolerance');
  });

  it('supports secret rotation and multiple v1 signatures', () => {
    const oldHeader = signWebhook('old-secret', BODY, NOW_S);
    expect(() =>
      verifyWebhookSignature({
        header: oldHeader,
        rawBody: BODY,
        secrets: [SECRET, 'old-secret'],
        now: NOW,
      }),
    ).not.toThrow();

    const newSig = signWebhook(SECRET, BODY, NOW_S).split('v1=')[1]!;
    const both = `t=${NOW_S},v1=${'0'.repeat(64)},v1=${newSig}`;
    expect(() =>
      verifyWebhookSignature({ header: both, rawBody: BODY, secrets: SECRET, now: NOW }),
    ).not.toThrow();
  });

  it.each([
    [undefined, 'missing_signature'],
    ['', 'missing_signature'],
    ['v1=abc', 'malformed_signature'],
    [`t=${NOW_S}`, 'malformed_signature'],
    [`t=yesterday,v1=abc`, 'malformed_signature'],
    [`t=${NOW_S},v1=short`, 'signature_mismatch'],
  ])('classifies header %j as %s', (header, expected) => {
    expect(
      reason(() => verifyWebhookSignature({ header, rawBody: BODY, secrets: SECRET, now: NOW })),
    ).toBe(expected);
  });
});
