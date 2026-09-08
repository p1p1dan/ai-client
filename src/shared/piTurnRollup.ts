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
 * PARENT's own provider call — a sub-agent runs its own agent loop inside the
 * opt-in `@gotgenes/pi-subagents` extension, so its tokens are never in there.
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
  return {
    sessionId: state.sessionId,
    turns: state.turns + (fromTool ? 0 : 1),
    toolResults: state.toolResults + (fromTool ? 1 : 0),
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
