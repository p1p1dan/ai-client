import { translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import {
  formatReasoningTokensClause,
  formatThinkingClause,
  formatTurnTokenClauses,
  joinTurnProgressLine,
  sumTurnThinkingMs,
  sumTurnTokens,
  turnProgressClauses,
} from '../turnProgress';

/**
 * The turn progress head's live numbers (2026-09-18 user decision).
 *
 * Every case here is a variant of one rule: a figure nobody measured is
 * OMITTED, never printed as zero. The head sits above the reply and is the only
 * evidence a 50-second turn is alive, so a fabricated number there is read as
 * fact for the whole length of the wait.
 */

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

/** A settled Pi usage payload, in the exact shape real session files carry. */
function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, reasoning?: number) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    costUsd: 0,
    // Omitted rather than defaulted to `0`: an un-passed `reasoning` here must
    // read as "this call did not report a breakdown", the same distinction
    // `piUsage.ts` keeps at the payload layer.
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

describe('sumTurnTokens', () => {
  /**
   * The real payload pair off `session-live-1789758067568-79rg6d4.jsonl` — a
   * turn that called one tool, so Pi billed it twice. `up` is everything that
   * is not `output`, which is exactly `totalTokens - output` for both rows.
   */
  it('[TP-1] sums every model call in the turn, prompt side and completion side', () => {
    const totals = sumTurnTokens([
      usage(2, 1_242, 10_656, 1_351),
      undefined,
      usage(2, 3, 12_007, 1_253),
    ]);
    expect(totals).toEqual({ up: 2 + 10_656 + 1_351 + 2 + 12_007 + 1_253, down: 1_242 + 3 });
  });

  /**
   * Measured against real data: assistant entries sometimes carry `usage: {}`.
   * `readPiUsagePayload` rejects it (no `input`/`output`), so it contributes
   * nothing instead of folding a row of zeroes into the total.
   */
  it('[TP-2] skips the empty payloads real sessions contain, and keeps the rest', () => {
    expect(sumTurnTokens([{}, usage(10, 20), null])).toEqual({ up: 10, down: 20 });
  });

  /**
   * The distinction the whole module is built around: "nothing has settled yet"
   * is not "this turn cost nothing". A restored history turn carries no
   * metadata at all and must print no token clause, not `↑ 0 tokens`.
   */
  it('[TP-3] reports null — not a zero row — when no payload is usable', () => {
    expect(sumTurnTokens([])).toBeNull();
    expect(sumTurnTokens([undefined, null, {}])).toBeNull();
    // The retired Claude-era interim tick carries an estimate under a different
    // key set; folding it in as if it were billed is the drift `piUsage.ts`
    // rejects it for.
    expect(sumTurnTokens([{ interim: true, input: 99, output: 99 }])).toBeNull();
  });

  /**
   * The reasoning slice folds the same way `up`/`down` do: a tool-calling turn
   * bills several model calls, and a turn's reasoning total is every one of
   * them added together, not just the last.
   */
  it('[TP-17] sums the reasoning/thinking token count across every model call', () => {
    expect(sumTurnTokens([usage(2, 700, 0, 0, 480), usage(2, 3, 0, 0, 127)])).toEqual({
      up: 4,
      down: 703,
      reasoning: 607,
    });
  });

  /**
   * `undefined` — not folded in as `0` — whenever NO call in the turn reported
   * a breakdown, so a model that never reasons prints no clause at all rather
   * than 「思考 0 tokens」. A call that DID report it still counts even if a
   * sibling call in the same turn did not (mixed availability is real: pi-ai's
   * Anthropic adapter only sets the field `if (thinkingTokens != null)`).
   */
  it('[TP-18] reports no reasoning total when nothing in the turn measured it, but keeps a partial one', () => {
    expect(sumTurnTokens([usage(2, 700), usage(2, 3)])).toEqual({ up: 4, down: 703 });
    expect(sumTurnTokens([usage(2, 700), usage(2, 3)])).not.toHaveProperty('reasoning');
    expect(sumTurnTokens([usage(2, 700, 0, 0, 480), usage(2, 3)])).toEqual({
      up: 4,
      down: 703,
      reasoning: 480,
    });
  });
});

// ---------------------------------------------------------------------------
// Thinking time
// ---------------------------------------------------------------------------

describe('sumTurnThinkingMs', () => {
  it('[TP-4] adds up every settled thought in the turn', () => {
    expect(
      sumTurnThinkingMs([{ durationMs: 12_000 }, { durationMs: 8_000 }], {
        nowMs: 0,
        live: false,
      })
    ).toBe(20_000);
  });

  it('[TP-5] falls back to the timestamps when no duration was folded', () => {
    expect(
      sumTurnThinkingMs([{ startedAt: 1_000, completedAt: 6_000 }], { nowMs: 0, live: false })
    ).toBe(5_000);
  });

  /**
   * The live half — this is what makes 「思考 20 秒」 count up on screen rather
   * than appearing fully formed once the thought ends.
   */
  it('[TP-6] counts an unfinished thought against the clock while the turn runs', () => {
    expect(
      sumTurnThinkingMs([{ durationMs: 4_000 }, { startedAt: 10_000, completedAt: null }], {
        nowMs: 16_000,
        live: true,
      })
    ).toBe(10_000);
  });

  /**
   * ⚠️ The guard that keeps a stopped turn from ticking forever.
   *
   * Press Stop mid-thought and `thinking.completed` never arrives, so the span
   * stays open for as long as the session is loaded. Without `live` the head
   * would report a thinking time that grew all afternoon on a turn that ended
   * at lunch.
   */
  it('[TP-7] ignores an unfinished thought once the turn has stopped', () => {
    expect(
      sumTurnThinkingMs([{ startedAt: 10_000, completedAt: null }], { nowMs: 999_000, live: false })
    ).toBeNull();
  });

  /**
   * `projector.ts` opens a thought on the first thinking DELTA, so a provider
   * that returns no reasoning body (the claude channel returns a signature and
   * nothing else) emits no `thinking.started` and no span reaches here. `null`
   * drops the clause; `0` would claim the model did not think.
   */
  it('[TP-8] reports null when the provider reported no thinking at all', () => {
    expect(sumTurnThinkingMs([], { nowMs: 1, live: true })).toBeNull();
    expect(sumTurnThinkingMs([undefined, {}], { nowMs: 1, live: true })).toBeNull();
  });

  it('[TP-9] treats a backwards clock as unknown time, not negative time', () => {
    expect(sumTurnThinkingMs([{ durationMs: -5_000 }], { nowMs: 0, live: false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

describe('the head line', () => {
  it('[TP-10] writes both arrows with the k-notation the rest of the app uses', () => {
    expect(formatTurnTokenClauses({ up: 12_040, down: 1_312 }, zh)).toEqual([
      '↑ 12.0k tokens',
      '↓ 1.3k tokens',
    ]);
  });

  /**
   * Before the first payload settles the reply has produced no tokens yet.
   * `↓ 0 tokens` would read as "the model wrote nothing", which is the opposite
   * of what is happening.
   */
  it('[TP-11] drops a column that is still zero, and says nothing at all with no payload', () => {
    expect(formatTurnTokenClauses({ up: 900, down: 0 }, zh)).toEqual(['↑ 900 tokens']);
    expect(formatTurnTokenClauses(null, zh)).toEqual([]);
  });

  it('[TP-12] writes the thinking clause in the units the Chinese catalog uses', () => {
    expect(formatThinkingClause(20_000, zh)).toBe('思考 20 秒');
    expect(formatThinkingClause(66_000, zh)).toBe('思考 1 分 6 秒');
    expect(formatThinkingClause(120_000, zh)).toBe('思考 2 分');
    expect(formatThinkingClause(null, zh)).toBeNull();
  });

  /**
   * The reasoning-token-count fallback for the same idea, measured against the
   * real pair from the task report: `output_tokens: 700, thinking_tokens: 607`.
   */
  it('[TP-12b] writes the reasoning-token clause with the same k-notation as ↑↓', () => {
    expect(formatReasoningTokensClause(607, zh)).toBe('思考 607 tokens');
    expect(formatReasoningTokensClause(12_400, zh)).toBe('思考 12.4k tokens');
  });

  /**
   * `0` is dropped, not printed — and deliberately for a DIFFERENT reason than
   * `formatTurnTokenClauses`' "still zero" case (TP-11): pi-ai's OpenAI-style
   * adapters default a MISSING breakdown to a literal `0` for every plain,
   * non-reasoning model, so a defined `0` reaching this function usually means
   * "this figure does not apply", not "the model measured zero reasoning".
   */
  it('[TP-12c] drops a zero or missing reasoning count instead of printing it', () => {
    expect(formatReasoningTokensClause(0, zh)).toBeNull();
    expect(formatReasoningTokensClause(null, zh)).toBeNull();
    expect(formatReasoningTokensClause(undefined, zh)).toBeNull();
  });

  /**
   * The assembled shape the user asked for, spelled out once so a change to any
   * piece of it is visible in the diff:
   * 「工作中 47 秒 · ↑ 12.0k tokens · ↓ 1.3k tokens · 思考 20 秒」.
   */
  it('[TP-13] joins the verb and whatever was measured, and only that', () => {
    expect(
      joinTurnProgressLine(zh('Working {{seconds}}s', { seconds: 47 }), [
        ...formatTurnTokenClauses({ up: 12_040, down: 1_312 }, zh),
        formatThinkingClause(20_000, zh),
      ])
    ).toBe('工作中 47 秒 · ↑ 12.0k tokens · ↓ 1.3k tokens · 思考 20 秒');
    // The claude-channel shape: tokens have not settled and no reasoning was
    // reported, so the head is the clock and nothing else — no empty separators.
    expect(
      joinTurnProgressLine(zh('Working {{seconds}}s', { seconds: 47 }), [
        ...formatTurnTokenClauses(null, zh),
        formatThinkingClause(null, zh),
      ])
    ).toBe('工作中 47 秒');
  });
});

// ---------------------------------------------------------------------------
// The two-stage rule
// ---------------------------------------------------------------------------

/**
 * User decision, 2026-09-18: 「确实在没收到回复的时候，只显示状态词+运行时间，
 * 收到内容后，再持续更新↑↓ token，思考量」.
 *
 * Measured basis (bare fetch against the gateway, five prompts, 2026-09-18):
 * first byte at 11.4s / 12.8s / 16.9s / 18.5s / 29.9s, with total minus first
 * byte pinned at ~2s every time. The wait is upstream silence end to end, so
 * during it the clock is not the best signal available — it is the only one.
 */
describe('turnProgressClauses — the two stages', () => {
  const totals = { up: 4_300, down: 700 };

  /**
   * Stage 1. Note the input: real token totals EXIST here. They can, on any
   * turn past its first tool call — the first model call settles and bills
   * while the second is still waiting in the same silence. Gating on
   * "are there tokens yet" instead of "has anything come back yet" would print
   * a count during that wait, which is what this stage forbids.
   */
  it('[TP-14] prints no clause at all before any content has arrived', () => {
    expect(
      turnProgressClauses({ hasReplyContent: false, tokens: totals, thinkingMs: 20_000 }, zh)
    ).toEqual([]);
  });

  it('[TP-15] starts reporting the moment content arrives', () => {
    expect(
      turnProgressClauses({ hasReplyContent: true, tokens: totals, thinkingMs: 20_000 }, zh)
    ).toEqual(['↑ 4.3k tokens', '↓ 700 tokens', '思考 20 秒']);
  });

  /**
   * Content has arrived but nothing has been billed yet — the normal shape of a
   * single-call turn, whose `usage` only lands with the model call itself.
   * Stage 2 is reached and still prints nothing, because there is nothing
   * measured to print. Both halves have to hold: the stage gate does not
   * fabricate, and the absence of data is not mistaken for stage 1.
   */
  it('[TP-16] stage 2 with nothing measured still prints nothing', () => {
    expect(
      turnProgressClauses({ hasReplyContent: true, tokens: null, thinkingMs: null }, zh)
    ).toEqual([]);
  });
});
