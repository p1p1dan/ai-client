import { describe, expect, it } from 'vitest';
import {
  AUTO_COMPACTION_MIN_HEADROOM_TOKENS,
  AUTO_COMPACTION_MIN_MESSAGE_BUDGET,
  AUTO_COMPACTION_MIN_OUTPUT_TOKENS,
  AUTO_COMPACTION_MIN_SPAN_TOKENS,
  type AutoCompactionPolicy,
  autoCompactionOverride,
  autoCompactionPolicy,
  DSH_COMPACTION_HEADROOM_TOKENS,
  DSH_COMPACTION_SUMMARY_MAX_TOKENS,
  dshCompactSpec,
} from '../dshAutoCompaction';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  plannedMaxTokens,
} from '../dshModelPlan/tables';

/**
 * dsh-rebase decision 177 — the per-model automatic compaction rules. The
 * same functions configure the DSH host's `compaction-basic` row
 * (src/dsh-host/lib/hostCompaction.ts, where they are also held against the
 * installed DSH code) and fill the settings' compaction notes.
 */

function policy(contextWindow: number, maxTokens: number): AutoCompactionPolicy {
  const result = autoCompactionPolicy({ contextWindow, maxTokens });
  if (!result) throw new Error(`no policy for ${contextWindow}/${maxTokens}`);
  return result;
}

/** A plan row as the plan sizes it: decision 146's cap, then the route's defaults. */
function planned(contextWindow: number | undefined, maxTokens: number | undefined) {
  return policy(
    contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    plannedMaxTokens(contextWindow, maxTokens) ?? DEFAULT_MAX_TOKENS
  );
}

describe("DSH's own arithmetic (resolveCompactSpec, restated)", () => {
  it('budgets window minus output, threshold under both 80% and budget minus headroom', () => {
    expect(dshCompactSpec(200_000, 8192)).toEqual({
      ok: true,
      messageBudgetTokens: 191_808,
      thresholdTokens: 126_272,
      retainTokens: 30_689,
    });
    // The 80% cap wins on a large window.
    expect(dshCompactSpec(1_048_576, 65_536)).toMatchObject({ ok: true, thresholdTokens: 838_860 });
  });

  it('fails the way DSH refuses: no budget, no pressure budget, tail not below the threshold', () => {
    expect(dshCompactSpec(128_000, 128_000)).toEqual({ ok: false, failure: 'no_message_budget' });
    expect(dshCompactSpec(65_536, 8192)).toEqual({ ok: false, failure: 'no_pressure_budget' });
    expect(dshCompactSpec(128_000, 50_000)).toEqual({
      ok: false,
      failure: 'retain_not_below_threshold',
    });
    expect(dshCompactSpec(0, 0)).toEqual({ ok: false, failure: 'invalid_size' });
    expect(dshCompactSpec(1000.5, 0)).toEqual({ ok: false, failure: 'invalid_size' });
    expect(dshCompactSpec(1000, -1)).toEqual({ ok: false, failure: 'invalid_size' });
  });

  it('turns a budget of 78,019 or less away with the default headroom', () => {
    const W = 1_000_000;
    expect(dshCompactSpec(W, W - 78_019).ok).toBe(false);
    expect(dshCompactSpec(W, W - 78_020)).toMatchObject({
      ok: true,
      thresholdTokens: 12_484,
      retainTokens: 12_483,
    });
  });
});

describe('autoCompactionPolicy (decision 177)', () => {
  it('works out its smallest budget from the two floors', () => {
    const B = AUTO_COMPACTION_MIN_MESSAGE_BUDGET;
    expect(B).toBe(39_009);
    const headroom = (budget: number) =>
      budget - Math.floor(budget * 0.16) - AUTO_COMPACTION_MIN_SPAN_TOKENS;
    expect(headroom(B)).toBeGreaterThanOrEqual(AUTO_COMPACTION_MIN_HEADROOM_TOKENS);
    expect(headroom(B - 1)).toBeLessThan(AUTO_COMPACTION_MIN_HEADROOM_TOKENS);
  });

  it("keeps DSH's defaults on the shipped catalog's large windows: no override at all", () => {
    for (const [W, O] of [
      [1_000_000, 128_000],
      [1_050_000, 128_000],
      [1_000_000, 384_000],
      [1_000_000, 131_072],
    ] as const) {
      const p = policy(W, O);
      expect(p).toMatchObject({ auto: true, headroomLowered: false, summaryMaxTokens: 65_536 });
      expect(autoCompactionOverride(p)).toBeUndefined();
    }
    expect(policy(1_000_000, 128_000)).toMatchObject({
      thresholdTokens: 800_000,
      retainTokens: 139_520,
    });
  });

  it('serves Grok 500k with its output planned down to 125k (decision 146) on the defaults', () => {
    const p = planned(500_000, 500_000);
    expect(p).toEqual({
      auto: true,
      contextWindow: 500_000,
      maxTokens: 125_000,
      thresholdTokens: 309_464,
      retainTokens: 60_000,
      headroomTokens: 65_536,
      headroomLowered: false,
      summaryMaxTokens: 65_536,
    });
    expect(autoCompactionOverride(p)).toBeUndefined();
  });

  it('caps the summary at the output limit, leaving the threshold to DSH, when the defaults work', () => {
    // No window, no output limit: the route's 128000 / 8192.
    const unsized = planned(undefined, undefined);
    expect(unsized).toMatchObject({
      auto: true,
      thresholdTokens: 54_272,
      retainTokens: 19_169,
      headroomLowered: false,
      summaryMaxTokens: 8192,
    });
    expect(autoCompactionOverride(unsized)).toEqual({ maxTokens: 8192 });
    const claude = policy(200_000, 32_000);
    expect(claude).toMatchObject({ thresholdTokens: 102_464, summaryMaxTokens: 32_000 });
    expect(autoCompactionOverride(claude)).toEqual({ maxTokens: 32_000 });
  });

  it('turns a 64k window back on with a lowered headroom', () => {
    const p = policy(65_536, 8192);
    expect(dshCompactSpec(65_536, 8192).ok).toBe(false);
    expect(p).toEqual({
      auto: true,
      contextWindow: 65_536,
      maxTokens: 8192,
      thresholdTokens: 33_751,
      retainTokens: 9175,
      headroomTokens: 23_593,
      headroomLowered: true,
      summaryMaxTokens: 8192,
    });
    expect(autoCompactionOverride(p)).toEqual({ headroomTokens: 23_593, maxTokens: 8192 });
  });

  it('turns 128k / 64k back on, the summary inside the lowered headroom', () => {
    const p = policy(128_000, 64_000);
    expect(p).toMatchObject({
      auto: true,
      thresholdTokens: 34_816,
      retainTokens: 10_240,
      headroomTokens: 29_184,
      summaryMaxTokens: 29_184,
    });
    expect(autoCompactionOverride(p)).toEqual({ headroomTokens: 29_184, maxTokens: 29_184 });
  });

  it('raises a threshold DSH accepts but leaves almost on its tail (131072 / 32768)', () => {
    const dsh = dshCompactSpec(131_072, 32_768);
    expect(dsh).toMatchObject({ ok: true, thresholdTokens: 32_768, retainTokens: 15_728 });
    const p = policy(131_072, 32_768);
    expect(p).toMatchObject({
      auto: true,
      thresholdTokens: 40_304,
      retainTokens: 15_728,
      headroomTokens: 58_000,
      headroomLowered: true,
      summaryMaxTokens: 32_768,
    });
  });

  it('says a 32k window is too small, and caps its summary all the same', () => {
    const p = policy(32_768, 4096);
    expect(p).toEqual({
      auto: false,
      contextWindow: 32_768,
      maxTokens: 4096,
      reason: 'window_too_small',
      summaryMaxTokens: 4096,
    });
    expect(autoCompactionOverride(p)).toEqual({ maxTokens: 4096 });
  });

  it('says an output limit eats the window, and how far to lower it', () => {
    const p = policy(65_536, 32_768);
    expect(p).toEqual({
      auto: false,
      contextWindow: 65_536,
      maxTokens: 32_768,
      reason: 'output_too_large',
      maxOutputForAuto: 26_527,
      summaryMaxTokens: 32_768,
    });
    expect(policy(65_536, 26_527).auto).toBe(true);
    expect(policy(65_536, 26_528).auto).toBe(false);
    // The default window with a large undeclared-window output limit.
    const unsizedWindow = planned(undefined, 100_000);
    expect(unsizedWindow).toMatchObject({
      auto: false,
      reason: 'output_too_large',
      maxOutputForAuto: 88_991,
      summaryMaxTokens: 65_536,
    });
    expect(autoCompactionOverride(unsizedWindow)).toBeUndefined();
    expect(policy(128_000, 128_000)).toMatchObject({ auto: false, reason: 'output_too_large' });
  });

  it('calls the window too small when lowering the output would leave less than 4096', () => {
    const W = AUTO_COMPACTION_MIN_MESSAGE_BUDGET + AUTO_COMPACTION_MIN_OUTPUT_TOKENS;
    expect(policy(W, 8192)).toMatchObject({ reason: 'output_too_large', maxOutputForAuto: 4096 });
    expect(policy(W - 1, 8192)).toMatchObject({ reason: 'window_too_small' });
  });

  it('leaves sizes that are not whole numbers to DSH', () => {
    expect(autoCompactionPolicy({ contextWindow: 0, maxTokens: 0 })).toBeUndefined();
    expect(autoCompactionPolicy({ contextWindow: 1.5, maxTokens: 0 })).toBeUndefined();
    expect(autoCompactionPolicy({ contextWindow: 1000, maxTokens: -1 })).toBeUndefined();
    // No reservation: the summary keeps DSH's own cap.
    expect(policy(200_000, 0)).toMatchObject({ auto: true, summaryMaxTokens: 65_536 });
  });

  it('moves the threshold continuously where the lowered headroom takes over', () => {
    const W = 2_000_000;
    // The first budget DSH's defaults leave the minimum span in.
    let boundary = 0;
    for (let budget = 100_000; budget < 120_000; budget += 1) {
      const spec = dshCompactSpec(W, W - budget);
      if (spec.ok && spec.thresholdTokens - spec.retainTokens >= AUTO_COMPACTION_MIN_SPAN_TOKENS) {
        boundary = budget;
        break;
      }
    }
    expect(boundary).toBe(107_276);
    const below = policy(W, W - (boundary - 1));
    const at = policy(W, W - boundary);
    if (!below.auto || !at.auto) throw new Error('both sides compact');
    expect(below.headroomLowered).toBe(true);
    expect(at.headroomLowered).toBe(false);
    expect(Math.abs(at.thresholdTokens - below.thresholdTokens)).toBeLessThanOrEqual(1);
  });

  it('holds its invariants over a grid of windows and output limits', () => {
    const windows = [
      4096, 8192, 16_384, 32_768, 40_960, 43_105, 43_106, 49_152, 64_000, 65_536, 98_304, 128_000,
      131_072, 200_000, 204_800, 262_144, 272_000, 400_000, 500_000, 1_000_000, 1_048_576,
      10_000_000,
    ];
    const outputs = [
      0, 1, 1024, 2048, 4096, 8192, 16_384, 24_000, 32_000, 32_768, 40_000, 50_000, 64_000, 65_536,
      100_000, 128_000, 131_072, 200_000, 384_000,
    ];
    let previousThreshold = new Map<number, number>();
    for (const O of outputs) {
      const thresholds = new Map<number, number>();
      for (const W of windows) {
        const p = policy(W, O);
        const cap = O > 0 ? Math.min(DSH_COMPACTION_SUMMARY_MAX_TOKENS, O) : 65_536;
        expect(p.summaryMaxTokens).toBeLessThanOrEqual(cap);
        if (p.auto) {
          expect(p.thresholdTokens - p.retainTokens).toBeGreaterThanOrEqual(
            AUTO_COMPACTION_MIN_SPAN_TOKENS
          );
          expect(p.headroomTokens).toBeGreaterThanOrEqual(AUTO_COMPACTION_MIN_HEADROOM_TOKENS);
          expect(p.headroomTokens).toBeLessThanOrEqual(DSH_COMPACTION_HEADROOM_TOKENS);
          expect(p.summaryMaxTokens).toBeLessThanOrEqual(p.headroomTokens);
          expect(dshCompactSpec(W, O, p.headroomTokens)).toMatchObject({
            ok: true,
            thresholdTokens: p.thresholdTokens,
            retainTokens: p.retainTokens,
          });
          thresholds.set(W, p.thresholdTokens);
        } else {
          expect(W - O).toBeLessThan(AUTO_COMPACTION_MIN_MESSAGE_BUDGET);
          if (p.maxOutputForAuto !== undefined) {
            expect(policy(W, p.maxOutputForAuto).auto).toBe(true);
          }
        }
      }
      // A larger output limit never moves a model's threshold up.
      for (const [W, threshold] of thresholds) {
        const before = previousThreshold.get(W);
        if (before !== undefined) expect(threshold).toBeLessThanOrEqual(before);
      }
      previousThreshold = thresholds;
    }
  });
});

describe('autoCompactionOverride', () => {
  it("says nothing when DSH's defaults are the policy", () => {
    expect(autoCompactionOverride(policy(1_000_000, 128_000))).toBeUndefined();
  });

  it('always pairs a lowered headroom with its summary cap', () => {
    const p = policy(98_304, 8192);
    expect(p).toMatchObject({ auto: true, headroomLowered: true });
    expect(autoCompactionOverride(p)).toEqual({
      headroomTokens: (p as { headroomTokens: number }).headroomTokens,
      maxTokens: 8192,
    });
  });
});
