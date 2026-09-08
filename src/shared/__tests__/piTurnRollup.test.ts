import { describe, expect, it } from 'vitest';
import {
  applyTurnUsage,
  initTurnRollup,
  type PiTurnRollup,
  readSessionUsage,
  viewTurnRollup,
} from '../piTurnRollup';
import type { PiTurnUsage } from '../piUsage';

const SESSION = 's1';

function usage(overrides: Partial<PiTurnUsage> = {}): PiTurnUsage {
  return {
    input: 1_000,
    output: 100,
    cacheRead: 500,
    cacheWrite: 50,
    totalTokens: 1_650,
    costUsd: 0.01,
    ...overrides,
  };
}

function fold(state: PiTurnRollup, ...usages: Array<Partial<PiTurnUsage>>): PiTurnRollup {
  return usages.reduce<PiTurnRollup>(
    (acc, next) => applyTurnUsage(acc, { sessionId: SESSION, usage: next, source: 'turn' }),
    state
  );
}

describe('applyTurnUsage', () => {
  it('adds turn after turn into one total', () => {
    const state = fold(initTurnRollup(SESSION), usage(), usage({ output: 300, costUsd: 0.02 }));
    expect(viewTurnRollup(state)).toEqual({
      turns: 2,
      toolResults: 0,
      input: 2_000,
      output: 400,
      cacheRead: 1_000,
      cacheWrite: 100,
      totalTokens: 3_300,
      costUsd: 0.03,
    });
  });

  it('returns the SAME state when an event changes nothing', () => {
    const state = fold(initTurnRollup(SESSION), usage());

    // Referential identity, not just equality: this state rides an event
    // payload to the renderer, and a fresh object per no-op would re-render
    // every consumer for an event that said nothing.
    expect(applyTurnUsage(state, { sessionId: SESSION, usage: null })).toBe(state);
    expect(applyTurnUsage(state, { sessionId: SESSION, usage: undefined })).toBe(state);
    // Another session's bill. Folding it in would be irreversible — there is no
    // way to subtract it back out once it is in the sum.
    expect(applyTurnUsage(state, { sessionId: 'other', usage: usage() })).toBe(state);
    // Measurable in no column at all.
    expect(
      applyTurnUsage(state, {
        sessionId: SESSION,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
      })
    ).toBe(state);
  });

  it('lets a partial usage contribute what it has and nothing else', () => {
    // A missing `cacheRead` must not turn every column into NaN: one absent
    // field would otherwise destroy the whole panel's figures.
    const state = applyTurnUsage(initTurnRollup(SESSION), {
      sessionId: SESSION,
      usage: { input: 900, costUsd: 0.004 },
      source: 'turn',
    });
    expect(viewTurnRollup(state)).toEqual({
      turns: 1,
      toolResults: 0,
      input: 900,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costUsd: 0.004,
    });

    // Nonsense of every shape contributes zero rather than propagating.
    const noisy = applyTurnUsage(state, {
      sessionId: SESSION,
      usage: { input: Number.NaN, output: -5, cacheRead: 10 } as Partial<PiTurnUsage>,
      source: 'turn',
    });
    expect(viewTurnRollup(noisy)).toMatchObject({ turns: 2, input: 900, output: 0, cacheRead: 10 });
  });

  it('counts delegated spend into the totals but not into the turn count', () => {
    // `ToolResultMessage.usage` is documented as "not part of main LLM context
    // accounting", so it is an increment by construction. Kept on its own
    // counter so a reader can see how much of a conversation was delegated.
    const state = applyTurnUsage(fold(initTurnRollup(SESSION), usage()), {
      sessionId: SESSION,
      usage: usage({ input: 4_000, output: 800, costUsd: 0.05 }),
      source: 'tool',
    });
    expect(viewTurnRollup(state)).toMatchObject({
      turns: 1,
      toolResults: 1,
      input: 5_000,
      output: 900,
      costUsd: 0.060000000000000005,
    });
  });

  it('never writes back into the usage it was handed', () => {
    // Rule 1 of the plan: a single message's usage is what the provider
    // reported and is never rewritten. The rollup is a parallel sum.
    const single = usage();
    const before = { ...single };
    const state = fold(initTurnRollup(SESSION), single, single, single);
    expect(single).toEqual(before);
    for (const key of Object.keys(before) as Array<keyof PiTurnUsage>) {
      expect(single[key]).toBe(before[key]);
    }
    // And the total really is three times one turn, so nothing was consumed.
    expect(viewTurnRollup(state)?.input).toBe(3_000);
  });

  it('starts from zero for a new session and cannot inherit another one', () => {
    const first = fold(initTurnRollup(SESSION), usage(), usage());
    const second = initTurnRollup('s2');
    expect(viewTurnRollup(second)).toBeNull();
    // The id lives in the state, so an event for the old session cannot land in
    // the new rollup even if a caller kept a stale reference to it.
    expect(applyTurnUsage(second, { sessionId: SESSION, usage: usage() })).toBe(second);
    expect(viewTurnRollup(first)?.turns).toBe(2);
  });
});

describe('viewTurnRollup', () => {
  it('reports nothing at all before the first turn settles', () => {
    // Not a row of zeroes: "cost nothing" and "we have no figures" are
    // different claims, and only the second is true here.
    expect(viewTurnRollup(initTurnRollup(SESSION))).toBeNull();
  });
});

describe('readSessionUsage', () => {
  it('round-trips a view through the event payload', () => {
    const view = viewTurnRollup(fold(initTurnRollup(SESSION), usage()));
    expect(readSessionUsage(view)).toEqual(view);
  });

  it('rejects anything that is not a settled rollup', () => {
    expect(readSessionUsage(undefined)).toBeNull();
    expect(readSessionUsage({})).toBeNull();
    expect(readSessionUsage([])).toBeNull();
    // A payload from an older build carried no session block at all.
    expect(readSessionUsage({ turns: 0, toolResults: 0, input: 500 })).toBeNull();
  });
});
