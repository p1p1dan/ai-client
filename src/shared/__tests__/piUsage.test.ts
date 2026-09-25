import { describe, expect, it } from 'vitest';
import {
  buildPiInterimUsagePayload,
  buildPiUsagePayload,
  deriveCacheHitRate,
  isPendingUsagePayload,
  isUnreportedTurnUsage,
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
      reasoning: 300,
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

describe('the reasoning/thinking token count (`Usage.reasoning`)', () => {
  it('carries it through when the provider reports it', () => {
    expect(buildPiUsagePayload(SDK_USAGE, SDK_CONTEXT)?.reasoning).toBe(300);
  });

  it('omits it rather than inventing zero when the provider never reported it', () => {
    expect(buildPiUsagePayload({ input: 10, output: 5 })).not.toHaveProperty('reasoning');
  });

  it('keeps a genuinely reported zero distinct from "not reported"', () => {
    // Faithful passthrough at this layer: whether the `0` came from a
    // provider that truly measured zero, or from one of pi-ai's OpenAI-style
    // adapters defaulting an absent breakdown to `0`, this module cannot tell
    // the two apart (see the field's doc comment on `PiTurnUsage`) — so it
    // must not silently drop a `0` it WAS handed. Deciding whether `0` is
    // worth printing is `formatReasoningTokensClause`'s job, not this one's.
    expect(buildPiUsagePayload({ input: 10, output: 5, reasoning: 0 })?.reasoning).toBe(0);
  });

  it('round-trips through readPiUsagePayload, including the absent case', () => {
    const built = buildPiUsagePayload(SDK_USAGE, SDK_CONTEXT);
    expect(readPiUsagePayload(built)?.reasoning).toBe(300);
    expect(readPiUsagePayload({ input: 10, output: 5 })).not.toHaveProperty('reasoning');
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

describe('decision 005 · the delegated slice rides the same payload', () => {
  const delegated: PiTurnUsage = {
    input: 400,
    output: 60,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 460,
    costUsd: 0.004,
  };

  it('carries `delegated` beside the turn totals, not inside them', () => {
    const payload = buildPiUsagePayload(SDK_USAGE, undefined, null, delegated);
    expect(payload?.delegated).toEqual(delegated);
    // The top-level fields still describe ONE turn, which is what the Run
    // surface labels them as.
    expect(payload?.totalTokens).toBe(SDK_USAGE.totalTokens);
  });

  it('omits the field entirely when no delegate has spent anything', () => {
    expect(buildPiUsagePayload(SDK_USAGE)).not.toHaveProperty('delegated');
    expect(buildPiUsagePayload(SDK_USAGE, undefined, null, null)).not.toHaveProperty('delegated');
  });

  it('reads it back, and refuses a row of zeroes', () => {
    const payload = buildPiUsagePayload(SDK_USAGE, undefined, null, delegated);
    expect(readPiUsagePayload(payload)?.delegated).toEqual(delegated);
    // "No delegate spent anything" and "we have no figures" stay tellable
    // apart, the same rule `readSessionUsage` follows.
    expect(
      readPiUsagePayload({ ...SDK_USAGE, costUsd: 0, delegated: { totalTokens: 0, costUsd: 0 } })
    ).not.toHaveProperty('delegated');
  });

  it('is absent from a payload an older build produced', () => {
    expect(readPiUsagePayload({ input: 1, output: 1 })).not.toHaveProperty('delegated');
  });
});

describe('2026-09-19 · the first-byte tick', () => {
  /**
   * What Anthropic actually puts on the wire at first byte, as pi-ai stores it
   * on the partial message: a real prompt side, and an `output` that is the
   * placeholder `1` for the whole stream.
   */
  const FIRST_BYTE_USAGE = {
    input: 431,
    output: 1,
    cacheRead: 0,
    cacheWrite: 10_656,
    totalTokens: 11_088,
    cost: { input: 0.0013, output: 0.000015, cacheRead: 0, cacheWrite: 0.04, total: 0.0413 },
  };

  it('blocks the `output_tokens: 1` placeholder instead of reporting it', () => {
    const payload = buildPiInterimUsagePayload(FIRST_BYTE_USAGE);
    // The one thing this must never do. A `1` here is a `↓ 1 tokens` that
    // would sit on screen for the length of every turn.
    expect(payload?.output).toBe(0);
    // Cost is derived from the completion side upstream, so it is unmeasured
    // for the same reason.
    expect(payload?.costUsd).toBe(0);
  });

  it('reports the prompt side verbatim, and re-derives the total from it alone', () => {
    const payload = buildPiInterimUsagePayload(FIRST_BYTE_USAGE);
    expect(payload).toMatchObject({ input: 431, cacheRead: 0, cacheWrite: 10_656 });
    // NOT pi-ai's own `totalTokens`, which already has the placeholder in it.
    expect(payload?.totalTokens).toBe(431 + 10_656);
  });

  it('marks itself pending so settled-bill surfaces can refuse it', () => {
    expect(isPendingUsagePayload(buildPiInterimUsagePayload(FIRST_BYTE_USAGE))).toBe(true);
    // A settled payload carries no mark at all, so a consumer that folds both
    // cannot be left holding a stale one.
    expect(buildPiUsagePayload(SDK_USAGE)).not.toHaveProperty('pending');
    expect(isPendingUsagePayload(buildPiUsagePayload(SDK_USAGE))).toBe(false);
    expect(isPendingUsagePayload(undefined)).toBe(false);
  });

  it('says nothing when the provider reported no prompt size', () => {
    // A provider that reports usage only at the end. An event here would claim
    // a measurement of zero, which is not what happened.
    expect(
      buildPiInterimUsagePayload({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    ).toBeNull();
    expect(buildPiInterimUsagePayload(undefined)).toBeNull();
  });

  it('survives the read path the turn head uses, with no `↓` half to report', () => {
    const read = readPiUsagePayload(buildPiInterimUsagePayload(FIRST_BYTE_USAGE));
    // `readPiUsagePayload` requires both halves to be numbers; the forced zero
    // is what keeps the prompt side readable at all.
    expect(read).toMatchObject({ input: 431, output: 0, cacheWrite: 10_656 });
  });
});

describe('T125 · a cut request whose cost the provider never reported', () => {
  /** pi-ai's starting usage, which an OpenAI-style catch leaves standing. */
  const ZERO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  /** Anthropic after `message_start`: a real prompt side, the `output: 1` placeholder. */
  const ANTHROPIC_FIRST_FRAME = {
    input: 431,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 432,
    cost: { input: 0.0013, output: 0.000015, cacheRead: 0, cacheWrite: 0, total: 0.0013 },
  };
  const text = (value: string) => ({ type: 'text', text: value });
  const message = (overrides: Record<string, unknown>) => ({
    role: 'assistant',
    content: [text('partial answer')],
    usage: ZERO_USAGE,
    stopReason: 'aborted',
    ...overrides,
  });

  it.each([
    ['Stop mid-text, zero usage', message({}), true],
    [
      'stream failure mid-thinking',
      message({ stopReason: 'error', content: [{ type: 'thinking', thinking: 'hmm' }] }),
      true,
    ],
    [
      'loop-guard cut: tool calls only',
      message({
        stopReason: 'error',
        content: [{ type: 'toolCall', id: 't', name: 'Task', arguments: {} }],
      }),
      true,
    ],
    [
      'redacted thinking only',
      message({ content: [{ type: 'thinking', thinking: '', redacted: true }] }),
      true,
    ],
    [
      'cut while reasoning invisibly: no content, first frame seen',
      message({ content: [], responseId: 'chatcmpl-1' }),
      true,
    ],
    ["Anthropic's placeholder output", message({ usage: ANTHROPIC_FIRST_FRAME }), true],
    ['usage block without an output field', message({ usage: { input: 0 } }), true],
    [
      'failed before the first frame: no content, no id',
      message({ stopReason: 'error', content: [] }),
      false,
    ],
    ['only an empty text block, no id', message({ content: [text('')] }), false],
    [
      'output was reported before the cut',
      message({ usage: { ...ZERO_USAGE, output: 57, totalTokens: 57 } }),
      false,
    ],
    ['a finished reply with zero usage', message({ stopReason: 'stop' }), false],
    ['a tool-use reply', message({ stopReason: 'toolUse' }), false],
    ['a length-capped reply', message({ stopReason: 'length' }), false],
    ['not a message', 'aborted', false],
  ])('%s → %s', (_label, input, expected) => {
    expect(isUnreportedTurnUsage(input)).toBe(expected);
  });

  it('marks the payload without touching the numbers pi left on the message', () => {
    const payload = buildPiUsagePayload(ANTHROPIC_FIRST_FRAME, undefined, null, null, {
      unreported: true,
    });
    expect(payload).toMatchObject({ input: 431, output: 1, costUsd: 0.0013, unreported: true });
  });

  it('omits the key entirely on a reported bill, so a merge cannot leave it behind', () => {
    expect(buildPiUsagePayload(SDK_USAGE)).not.toHaveProperty('unreported');
    expect(
      buildPiUsagePayload(SDK_USAGE, undefined, null, null, { unreported: false })
    ).not.toHaveProperty('unreported');
  });

  it('round-trips through readPiUsagePayload, and reads only a literal `true`', () => {
    const built = buildPiUsagePayload(ZERO_USAGE, SDK_CONTEXT, null, null, { unreported: true });
    expect(readPiUsagePayload(built)).toMatchObject({ output: 0, unreported: true });
    expect(readPiUsagePayload({ input: 0, output: 0, unreported: 'yes' })).not.toHaveProperty(
      'unreported'
    );
    // Not a pending tick: settled-bill surfaces must still fold it.
    expect(isPendingUsagePayload(built)).toBe(false);
  });
});
