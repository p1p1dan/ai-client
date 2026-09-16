/**
 * T042 (ah-lib-02) — the provider-error exit and the stderr exit share one
 * rule set.
 *
 * T011 fixed "provider error bodies reach the trace unredacted" by writing a
 * fresh redactor next to the agent loop instead of reusing the one the repo
 * already had. The new one matched `authorization: bearer ...` and a handful
 * of `name = value` assignments, and nothing else — so a gateway that answers
 * `Incorrect API key provided: sk-proj-...` (prose, not an assignment; a bare
 * key, no field name to hook) wrote the key straight into `runs.jsonl`, into
 * `RuntimeRunResult.error.message` and — via ah-lib-01 — into the session
 * file, while the very same string was destroyed on its way to the stderr
 * panel.
 *
 * These cases pin the merge: both exits run the same table over the same
 * samples, so a future private copy on either side fails here.
 */

import { describe, expect, it } from 'vitest';
import { CREDENTIAL_SAMPLES } from '../../agent-host/__tests__/fixtures/credentialSamples.ts';
import { redactStderrLine } from '../../agent-host/stderrRedaction.ts';
import {
  MAX_ERROR_MESSAGE_CHARS,
  redactSensitiveErrorText,
  sanitizeProviderErrorText,
} from '../plugins/agent-loop/providerErrors.ts';

describe('provider error redaction', () => {
  it.each(CREDENTIAL_SAMPLES)('destroys the secret in: $why', ({ text, secret }) => {
    const out = redactSensitiveErrorText(text);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('masks exactly what the stderr exit masks — one rule set, two placeholders', () => {
    for (const { text } of CREDENTIAL_SAMPLES) {
      const viaProvider = redactSensitiveErrorText(text).replaceAll('[REDACTED]', '<mask>');
      const viaStderr = redactStderrLine(text).replaceAll('[redacted]', '<mask>');
      expect(viaProvider).toBe(viaStderr);
    }
  });

  it('still strips the control characters a raw provider body can carry', () => {
    // The trace is JSONL and so is the session file: a raw BEL or ESC pasted
    // out of a provider body is the reason this rule exists, and merging the
    // two tables must not drop it.
    expect(redactSensitiveErrorText('502 body \u0007 with \u001b[31mcolour\u001b[0m')).toBe(
      '502 body  with [31mcolour[0m'
    );
  });

  it('keeps the trace-row cap after redaction, not before', () => {
    const long = `502: ${'x'.repeat(5000)}`;
    const capped = sanitizeProviderErrorText(long);
    expect(capped).toHaveLength(MAX_ERROR_MESSAGE_CHARS + 1);
    expect(capped.endsWith('…')).toBe(true);
    // A credential past the cap is gone because a rule matched it, not because
    // the cap happened to cut it off.
    const tail = `${'y'.repeat(MAX_ERROR_MESSAGE_CHARS - 10)} sk-ant-api03-${'x'.repeat(40)}`;
    expect(redactSensitiveErrorText(tail)).not.toContain('sk-ant-api03');
  });

  it('leaves an ordinary provider diagnostic intact', () => {
    const line = '429 rate_limit_error: retry after 30s (request id req_0123456789)';
    expect(redactSensitiveErrorText(line)).toBe(line);
  });
});
