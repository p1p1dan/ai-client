/**
 * A2 — the running total for ONE conversation, alongside the per-turn bills.
 *
 * ## Why a second number instead of a better first one
 *
 * `usage.updated` reports the turn that just settled, and `RunSurfaceView`
 * labels every figure "last turn" for a good reason: a Pi run that calls tools
 * settles several turns, and adding those up on the fly would print a total
 * nobody was charged. That judgement stands. What it cost us is that there was
 * no total at all — "what has this conversation spent" had no answer.
 *
 * This module is that answer, kept strictly beside the first one:
 *
 *  1. **A single message's usage is never rewritten.** The rollup is a parallel
 *     sum, not a correction. Nothing here mutates or replaces what a provider
 *     reported for one turn.
 *  2. **"Last turn" and "this conversation" are two numbers, labelled
 *     separately.** They must never be merged into one "Total", because a
 *     reader who took the session figure for a turn figure would misread every
 *     one of them.
 *  3. **Addition only.** No unit prices, no re-derivation: the cost is the sum
 *     of the `costUsd` Pi already computed per turn.
 *
 * ## Sub-agent spend
 *
 * Verified against the installed SDK rather than assumed from PI-Desktop's
 * shape. `turn_end` is `{ type, message, toolResults }`
 * (`@earendil-works/pi-agent-core/dist/types.d.ts`), and `message.usage` is the
 * PARENT's own provider call — a sub-agent runs its own agent loop (today in
 * `src/runtime/plugins/subagent/`, originally in the `@gotgenes/pi-subagents`
 * extension T025 stopped shipping), so its tokens are never in there.
 *
 * The channel that does exist is `ToolResultMessage.usage`, whose SDK comment
 * is decisive: *"Usage from the tool execution itself, if available. Not part of
 * main LLM context accounting."* So it is an increment by construction —
 * already excluded from the parent's number, and therefore safe to add here and
 * unsafe to add anywhere near a single message. It is counted separately from
 * turn spend so a reader can tell delegated cost from the parent's own.
 *
 * ## Why a pure module
 *
 * vitest runs `environment: 'node'` over `*.test.ts` only, so a rule that lives
 * inside the worker class or a `.tsx` has no automated coverage at all. Every
 * decision worth asserting is here.
 */
import type { PiTurnUsage } from './piUsage';

/**
 * The accumulator. Immutable by contract: `applyTurnUsage` returns a new object
 * or the identical one, never a mutated one.
 *
 * `sessionId` is part of the state rather than a parameter of the reader
 * because that is what makes a mixed-up event impossible to fold in silently.
 * One `PiWorkerSession` owns one logical session for its whole life today, so
 * this is belt and braces — but "the invariant holds because of how the caller
 * happens to be built" is exactly the kind of claim that stops being true.
 */
export interface PiTurnRollup {
  readonly sessionId: string;
  /** Settled turns folded in. Zero means there is nothing to report yet. */
  readonly turns: number;
  /** Tool results that reported their own spend (delegated work). */
  readonly toolResults: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

/** What the renderer prints under "this conversation". */
export interface PiSessionUsage {
  turns: number;
  toolResults: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
}

export function initTurnRollup(sessionId: string): PiTurnRollup {
  return {
    sessionId,
    turns: 0,
    toolResults: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

function addend(value: unknown): number {
  // Anything that is not a finite, non-negative number contributes nothing. A
  // partial usage (input reported, `cacheRead` absent) must leave the other
  // columns intact rather than turning the whole total into `NaN` — one missing
  // field would otherwise destroy every figure in the panel.
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Which side of the bill an increment came from.
 *
 * `'turn'` — the parent agent's own provider call, off `turn_end.message.usage`.
 * `'tool'` — a tool that reported its own spend (`ToolResultMessage.usage`),
 * which is how a delegated sub-agent's tokens reach us. Both add to the same
 * totals; only the counters differ, so the UI can say how much of a
 * conversation was delegated.
 */
export type PiRollupSource = 'turn' | 'tool';

/**
 * Fold one usage into the rollup.
 *
 * Returns the SAME object when there is nothing to fold — a foreign session, an
 * absent usage, or one whose every column is zero or unreadable. That identity
 * is load-bearing, not a micro-optimisation: the state is handed to the
 * renderer through an event payload, and a fresh object per no-op event would
 * re-render every consumer of it for events that changed nothing.
 */
export function applyTurnUsage(
  state: PiTurnRollup,
  input: {
    sessionId: string;
    usage: Partial<PiTurnUsage> | null | undefined;
    source?: PiRollupSource;
    /**
     * How many settled units this one fold stands for.
     *
     * subagent-data-03 — a reopened session folds in what its EARLIER runs'
     * delegates spent as a single sum, and counting that as one delegation
     * would make "3 delegated" mean "3 folds" instead of "3 delegates". Only
     * the counter reads it; the money is the sum either way.
     */
    count?: number;
  }
): PiTurnRollup {
  // Another session's bill is not this session's, and folding one in would be
  // invisible afterwards — there is no way to subtract it back out later.
  if (input.sessionId !== state.sessionId) return state;
  const usage = input.usage;
  if (!usage || typeof usage !== 'object') return state;

  const input_ = addend(usage.input);
  const output = addend(usage.output);
  const cacheRead = addend(usage.cacheRead);
  const cacheWrite = addend(usage.cacheWrite);
  const totalTokens = addend(usage.totalTokens);
  const costUsd = addend(usage.costUsd);
  if (
    input_ === 0 &&
    output === 0 &&
    cacheRead === 0 &&
    cacheWrite === 0 &&
    totalTokens === 0 &&
    costUsd === 0
  ) {
    // Nothing measurable. Counting the turn anyway would make "12 turns" mean
    // something different from "12 turns we have figures for".
    return state;
  }

  const fromTool = input.source === 'tool';
  const count =
    typeof input.count === 'number' && Number.isFinite(input.count) && input.count > 0
      ? Math.floor(input.count)
      : 1;
  return {
    sessionId: state.sessionId,
    turns: state.turns + (fromTool ? 0 : count),
    toolResults: state.toolResults + (fromTool ? count : 0),
    input: state.input + input_,
    output: state.output + output,
    cacheRead: state.cacheRead + cacheRead,
    cacheWrite: state.cacheWrite + cacheWrite,
    totalTokens: state.totalTokens + totalTokens,
    costUsd: state.costUsd + costUsd,
  };
}

/**
 * The rollup as a payload, or `null` when nothing has been folded in.
 *
 * `null` rather than a row of zeroes, for the same reason `buildPiUsagePayload`
 * refuses to emit one: "this conversation has cost nothing" and "we have no
 * figures for this conversation" are different claims, and only the second one
 * is true before the first turn settles.
 */
export function viewTurnRollup(state: PiTurnRollup): PiSessionUsage | null {
  if (state.turns === 0 && state.toolResults === 0) return null;
  return {
    turns: state.turns,
    toolResults: state.toolResults,
    input: state.input,
    output: state.output,
    cacheRead: state.cacheRead,
    cacheWrite: state.cacheWrite,
    totalTokens: state.totalTokens,
    costUsd: state.costUsd,
  };
}

/** Narrow a `PiSessionUsage` back off an event payload. */
export function readSessionUsage(value: unknown): PiSessionUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const number = (key: string): number => addend(source[key]);
  const turns = number('turns');
  const toolResults = number('toolResults');
  if (turns === 0 && toolResults === 0) return null;
  return {
    turns,
    toolResults,
    input: number('input'),
    output: number('output'),
    cacheRead: number('cacheRead'),
    cacheWrite: number('cacheWrite'),
    totalTokens: number('totalTokens'),
    costUsd: number('costUsd'),
  };
}

/**
 * decision 005 — how much of this conversation was done by delegates.
 *
 * The session totals already INCLUDE delegated spend (that is the contract's
 * "会话/轮级总成本含子调用"), and `delegated` is the part of them a subagent
 * ran up. The share is therefore a ratio of two numbers the payload already
 * carries, derived in one place so the panel and any other surface cannot
 * round it two different ways.
 *
 * `null` rather than `0%` when there is no denominator: "no delegate spent
 * anything" and "we have no figures yet" are different claims, and a 0% badge
 * on a conversation that has not settled a turn asserts the first.
 */
export function deriveDelegatedShare(
  session: PiSessionUsage | null | undefined,
  delegated: Partial<PiTurnUsage> | null | undefined
): { delegations: number; tokensPercent: number; costPercent: number } | null {
  if (!session || !delegated) return null;
  const tokens = addend(delegated.totalTokens);
  const cost = addend(delegated.costUsd);
  if (tokens === 0 && cost === 0) return null;
  const percent = (part: number, whole: number): number =>
    whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0;
  return {
    delegations: session.toolResults,
    tokensPercent: percent(tokens, session.totalTokens),
    costPercent: percent(cost, session.costUsd),
  };
}
