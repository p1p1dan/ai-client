import { describe, expect, it } from 'vitest';
import { buildPiUsagePayload, readPiUsagePayload } from '../piUsage';

/** A whole `Usage` as `@earendil-works/pi-ai` shapes it. */
const SDK_USAGE = {
  input: 12_000,
  output: 480,
  cacheRead: 9_000,
  cacheWrite: 1_200,
  cacheWrite1h: 400,
  reasoning: 300,
  totalTokens: 22_680,
  cost: { input: 0.036, output: 0.0072, cacheRead: 0.0027, cacheWrite: 0.0045, total: 0.0504 },
};

const SDK_CONTEXT = { tokens: 21_400, contextWindow: 200_000, percent: 10.7 };

describe('buildPiUsagePayload', () => {
  it('carries the turn totals and the context usage through unchanged', () => {
    expect(buildPiUsagePayload(SDK_USAGE, SDK_CONTEXT)).toEqual({
      input: 12_000,
      output: 480,
      cacheRead: 9_000,
      cacheWrite: 1_200,
      totalTokens: 22_680,
      costUsd: 0.0504,
      context: { tokens: 21_400, contextWindow: 200_000, percent: 10.7 },
    });
  });

  it('emits nothing at all when the turn reported no usage', () => {
    expect(buildPiUsagePayload(undefined, SDK_CONTEXT)).toBeNull();
    expect(buildPiUsagePayload(null)).toBeNull();
    // "No usage" must not become a row of zeroes: a turn that cost nothing and
    // a provider that reported nothing are different claims.
    expect(buildPiUsagePayload('12000')).toBeNull();
  });

  it('omits `context` rather than inventing a window', () => {
    // Pi returns `undefined` when the session has no model.
    expect(buildPiUsagePayload(SDK_USAGE, undefined)).not.toHaveProperty('context');
    // A zero/negative window is a broken config entry, not a 0%-used session.
    expect(
      buildPiUsagePayload(SDK_USAGE, { tokens: 100, contextWindow: 0, percent: null })
    ).not.toHaveProperty('context');
  });

  it("keeps Pi's post-compaction `tokens: null` as unknown, not as zero", () => {
    const payload = buildPiUsagePayload(SDK_USAGE, {
      tokens: null,
      contextWindow: 200_000,
      percent: null,
    });
    expect(payload?.context).toEqual({ tokens: null, contextWindow: 200_000, percent: null });
  });

  it('drops a percent that arrives without the tokens it describes', () => {
    const payload = buildPiUsagePayload(SDK_USAGE, {
      tokens: null,
      contextWindow: 200_000,
      percent: 42,
    });
    expect(payload?.context?.percent).toBeNull();
  });

  it('defaults only the fields a provider may legitimately omit', () => {
    const payload = buildPiUsagePayload({ input: 10, output: 5 });
    expect(payload).toEqual({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costUsd: 0,
    });
  });
});

describe('readPiUsagePayload', () => {
  it('round-trips what the worker built', () => {
    const built = buildPiUsagePayload(SDK_USAGE, SDK_CONTEXT);
    expect(readPiUsagePayload(built)).toEqual(built);
  });

  it('rejects the legacy interim tick the Claude host used to emit', () => {
    // D33 shape: an estimate under a different key set. Folding it as a settled
    // total would put a guess in the usage row.
    expect(readPiUsagePayload({ interim: true, turn_output_tokens_display: 850 })).toBeNull();
  });

  it('rejects payloads with no token counts at all', () => {
    expect(readPiUsagePayload(undefined)).toBeNull();
    expect(readPiUsagePayload({})).toBeNull();
    expect(readPiUsagePayload({ input: 10 })).toBeNull();
    expect(readPiUsagePayload({ input: 'many', output: 5 })).toBeNull();
  });

  it('reads a payload from an older build that carried no context', () => {
    expect(readPiUsagePayload({ input: 10, output: 5 })).toEqual({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costUsd: 0,
    });
  });
});
