import { describe, expect, it } from 'vitest';
import { redactLogArgs } from '../redact';

/** D47 S1 spec §3 test group 4 — positive/negative controls for `redactLogArgs`. */

describe('redactLogArgs — positive controls', () => {
  it('redacts a JSON-quoted key regardless of case', () => {
    expect(redactLogArgs(['{"ANTHROPIC_API_KEY":"plain-secret"}'])).toEqual([
      '{"ANTHROPIC_API_KEY":"[REDACTED]"}',
    ]);
    expect(redactLogArgs(['{"apiKey":"plain-secret"}'])).toEqual(['{"apiKey":"[REDACTED]"}']);
  });

  it('redacts both ":" and "=" separators', () => {
    expect(redactLogArgs(['authToken: super-secret'])).toEqual(['authToken: [REDACTED]']);
    expect(redactLogArgs(['authToken=super-secret'])).toEqual(['authToken=[REDACTED]']);
  });

  it('redacts an Error message and stack, keeping the Error shape', () => {
    const error = new Error('leaked token=super-secret-value here');
    error.stack = 'Error: leaked token=super-secret-value here\n    at file.js:1:1';

    const [redacted] = redactLogArgs([error]) as [Error];
    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.message).toBe('leaked token=[REDACTED] here');
    expect(redacted.stack).toContain('token=[REDACTED]');
  });

  it('redacts every sensitive argument across a multi-argument call', () => {
    const result = redactLogArgs(['prefix', 'apiKey=xyz', { authToken: 'zzz' }]);
    expect(result).toEqual(['prefix', 'apiKey=[REDACTED]', { authToken: '[REDACTED]' }]);
  });

  it('redacts the sk-ant- named provider prefix', () => {
    expect(redactLogArgs(['leaked sk-ant-api03-AbC_dEf-123 in log'])).toEqual([
      'leaked [REDACTED] in log',
    ]);
  });

  it('keeps the generic long-sk- shape fallback (no named prefix, no field name to hook)', () => {
    // Deliberately NOT sk-ant-/sk-proj- — this is the generic \bsk-...{16,}
    // fallback rule (S1 spec §2.5 "sk- 长串形状兜底保留"), a distinct rule
    // from the named-prefix ones above.
    expect(redactLogArgs(['leaked sk-abcdefghij1234567890 in log'])).toEqual([
      'leaked [REDACTED] in log',
    ]);
  });

  it('redacts the cookie/set-cookie/authorization names added beyond stderrRedaction', () => {
    expect(redactLogArgs(['cookie: session=abc'])).toEqual(['cookie: [REDACTED]']);
    expect(redactLogArgs(['set-cookie: session=abc'])).toEqual(['set-cookie: [REDACTED]']);
    expect(redactLogArgs(['authorization: Bearer opaque-token'])).toEqual([
      'authorization: Bearer [REDACTED]',
    ]);
  });

  it('recursively redacts nested objects/arrays, cycle-safe', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    const input = {
      config: { claude: { authToken: 'secret-1' }, codex: { apiKey: 'secret-2' } },
      list: [{ password: 'secret-3' }],
      cyclic,
    };
    const [result] = redactLogArgs([input]) as [typeof input];
    expect(result.config.claude.authToken).toBe('[REDACTED]');
    expect(result.config.codex.apiKey).toBe('[REDACTED]');
    expect(result.list[0].password).toBe('[REDACTED]');
    expect(result.cyclic.name).toBe('x');
  });
});

describe('redactLogArgs — negative controls (bare "key" dropped)', () => {
  it('does not touch ordinary key= vocabulary', () => {
    for (const line of ['key=cache', 'key=ArrowUp', 'public key=ed25519', 'monkey=value']) {
      expect(redactLogArgs([line])).toEqual([line]);
    }
  });

  it('does not touch ordinary token vocabulary with no field-name hook', () => {
    for (const line of ['input_tokens: 4096 output_tokens: 512', 'max_tokens: 32000']) {
      expect(redactLogArgs([line])).toEqual([line]);
    }
  });
});

describe('redactLogArgs — sentinel token first-6-characters guarantee', () => {
  it('a full token embedded in a log line never survives, not even its first 6 characters', () => {
    const token = 'sk-ant-SENTINEL0123456789';
    const [result] = redactLogArgs([`writeClaudeConfig intent: token=${token}`]) as [string];
    expect(result).not.toContain(token.slice(0, 6));
    expect(result).toBe('writeClaudeConfig intent: token=[REDACTED]');
  });
});
