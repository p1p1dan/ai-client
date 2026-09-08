import { describe, expect, it } from 'vitest';
import {
  buildPiUsagePayload,
  deriveCacheHitRate,
  type PiTurnUsage,
  readPiUsagePayload,
} from '../piUsage';

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

/** A settled turn's totals, as `runPanelModel` hands them over. */
function turn(overrides: Partial<PiTurnUsage> = {}): PiTurnUsage {
  return {
    input: 12_000,
    output: 480,
    cacheRead: 9_000,
    cacheWrite: 1_200,
    totalTokens: 22_680,
    costUsd: 0.0504,
    ...overrides,
  };
}

describe('the session rollup rides beside the turn totals (A2)', () => {
  const SESSION_USAGE = {
    turns: 3,
    toolResults: 1,
    input: 40_000,
    output: 1_500,
    cacheRead: 27_000,
    cacheWrite: 3_600,
    totalTokens: 72_100,
    costUsd: 0.19,
  };

  it('carries the running total without touching what the provider billed', () => {
    const payload = buildPiUsagePayload(SDK_USAGE, SDK_CONTEXT, SESSION_USAGE);
    // Rule 1: the top-level figures are this turn's own and are not rewritten
    // by the existence of a session total.
    expect(payload).toMatchObject({ input: 12_000, output: 480, costUsd: 0.0504 });
    expect(payload?.session).toEqual(SESSION_USAGE);
  });

  it('omits the block entirely when there is no total yet', () => {
    // An older build's payload has no `session` either; both must read as
    // "nothing to show", never as a row of zeroes.
    expect(buildPiUsagePayload(SDK_USAGE, SDK_CONTEXT)).not.toHaveProperty('session');
    expect(buildPiUsagePayload(SDK_USAGE, SDK_CONTEXT, null)).not.toHaveProperty('session');
    expect(readPiUsagePayload({ input: 10, output: 5 })).not.toHaveProperty('session');
  });

  it('reads back only a settled rollup', () => {
    const wire = buildPiUsagePayload(SDK_USAGE, SDK_CONTEXT, SESSION_USAGE);
    expect(readPiUsagePayload(wire)?.session).toEqual(SESSION_USAGE);
    // A zero rollup is not a rollup.
    expect(
      readPiUsagePayload({ input: 10, output: 5, session: { turns: 0, toolResults: 0 } })
    ).not.toHaveProperty('session');
  });
});

describe('deriveCacheHitRate', () => {
  it('divides cache reads by the prompt, leaving cache writes out of the base', () => {
    // 9_000 / (12_000 + 9_000) = 42.857…%. A denominator that also counted the
    // 1_200 written would report 40% and make a cache-warming turn look worse
    // than it was.
    expect(deriveCacheHitRate(turn())).toBe(43);
    expect(deriveCacheHitRate(turn({ cacheWrite: 500_000 }))).toBe(43);
  });

  it('rounds once, the way the composer chip rounds occupancy', () => {
    // 1 / 3 = 33.33…% and 2 / 3 = 66.66…%: half-up on the fractional part, so
    // a second `Math.round` in a view is a no-op rather than a disagreement.
    expect(deriveCacheHitRate(turn({ input: 2, cacheRead: 1 }))).toBe(33);
    expect(deriveCacheHitRate(turn({ input: 1, cacheRead: 2 }))).toBe(67);
    expect(deriveCacheHitRate(turn({ input: 0, cacheRead: 7 }))).toBe(100);
  });

  it('reports 0 when the prompt was billed and none of it was cached', () => {
    // A real miss, not an unknown: the turn even paid to warm the cache. This
    // is the sentinel case the row exists for.
    expect(deriveCacheHitRate(turn({ input: 12_000, cacheRead: 0, cacheWrite: 1_200 }))).toBe(0);
    // Also 0 with no caching in play at all — a provider that silently stopped
    // caching must read as 0%, not vanish.
    expect(deriveCacheHitRate(turn({ input: 12_000, cacheRead: 0, cacheWrite: 0 }))).toBe(0);
  });

  it('returns null when there are no prompt tokens to divide', () => {
    // The view must print nothing here. `0%` would assert a cache miss on a
    // turn that never billed a prompt.
    expect(deriveCacheHitRate(turn({ input: 0, cacheRead: 0 }))).toBeNull();
    // An empty prompt still outranks a cache write: nothing was read AND
    // nothing was billed uncached, so there is no ratio, warmed cache or not.
    expect(deriveCacheHitRate(turn({ input: 0, cacheRead: 0, cacheWrite: 1_200 }))).toBeNull();
  });

  it('treats an unreported or nonsensical count as unknown, not as zero', () => {
    // These cross the `Record<string, unknown>` boundary, so the type is not a
    // guarantee — a missing key, a NaN or a negative is "no measurement".
    expect(
      deriveCacheHitRate({ ...turn(), cacheRead: undefined } as unknown as PiTurnUsage)
    ).toBeNull();
    expect(deriveCacheHitRate({ ...turn(), input: '12000' } as unknown as PiTurnUsage)).toBeNull();
    expect(deriveCacheHitRate(turn({ cacheRead: Number.NaN }))).toBeNull();
    expect(deriveCacheHitRate(turn({ cacheRead: -1 }))).toBeNull();
    expect(deriveCacheHitRate(turn({ input: -1 }))).toBeNull();
    expect(deriveCacheHitRate(null)).toBeNull();
    expect(deriveCacheHitRate(undefined)).toBeNull();
  });

  it('never touches the usage it was handed', () => {
    const usage = turn();
    const before = { ...usage };
    deriveCacheHitRate(usage);
    expect(usage).toEqual(before);
  });
});
