/**
 * What a DSH session's subagents spent, folded from their own logs, so the
 * Run panel's session total takes in delegated work (runtime-hardening
 * decision 005: "会话/轮级总成本含子调用"; dsh-rebase decision 198).
 *
 * A DSH subagent is a session of its own (`subagent`, `subagent_fork`): its
 * model requests are in ITS log, never in the parent's, so the token meter's
 * `tokenUsage` of the parent leaves them out. The parent's log names its
 * direct children (`subagent/catalog`, `catalogChildOf`); each child's log is
 * folded here the way dsh-token-meter folds `tokenUsage`, plus its
 * compaction summaries (`dshAuxiliaryUsage.ts`), and its own catalog names
 * the next level down.
 *
 * A fork child (`subagent_fork`) starts from a copy of the parent's finished
 * turns: the first `inheritedEventCount` events of its log are the parent's,
 * spent and counted already. They are skipped, steps and catalog facts alike
 * (DSH's `subagentCatalog` projection skips them the same way).
 *
 * Plain JSON and in place, like the cache chain's state. Its one import
 * imports nothing, so the bundled bridge and the renderer can both load it.
 */

import {
  type AuxiliaryUsage,
  addAuxiliaryUsage,
  emptyAuxiliaryUsage,
} from './dshAuxiliaryUsage.ts';

/** `0`: no subagent log is read and no delegated share is sent (decision 198). */
export const DELEGATED_USAGE_ENV = 'AICLIENT_RUNTIME_DELEGATED_USAGE';

/** The token meter's buckets: uncached input, output, cache read, cache write. */
export interface DshSpendBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One session's own spend, at the events folded so far. */
export interface DshSessionSpend {
  /** Events copied from the session it was forked from; never counted. */
  readonly inheritedEventCount: number;
  /** Agent-loop requests, as dsh-token-meter's `tokenUsage` sums them. */
  readonly loop: DshSpendBuckets;
  /**
   * The token meter's replacement slot: the last sample's step. A later
   * sample of the same step replaces it (a streaming sample, then the
   * settled one); `llm/retry-started` closes it, so a retry adds.
   */
  last: { turn: unknown; step: unknown; buckets: DshSpendBuckets } | null;
  /** Compaction summaries (`compaction/summary.usage`). */
  readonly auxiliary: AuxiliaryUsage;
  /** Its own direct children, in catalog order. */
  readonly children: string[];
}

/** What the session's delegates spent, for `usage.updated.delegated`. */
export interface DshDelegatedSpend {
  /** Delegated sessions (children and theirs) that reported any usage. */
  delegates: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

type Row = Record<string, unknown>;

function recordOf(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function zero(): DshSpendBuckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function initSessionSpend(inheritedEventCount = 0): DshSessionSpend {
  return {
    inheritedEventCount:
      Number.isSafeInteger(inheritedEventCount) && inheritedEventCount > 0
        ? inheritedEventCount
        : 0,
    loop: zero(),
    last: null,
    auxiliary: emptyAuxiliaryUsage(),
    children: [],
  };
}

/** An event the session inherited from the one it was forked from. */
function inherited(event: { readonly seq?: unknown }, inheritedEventCount: number): boolean {
  return typeof event.seq === 'number' && event.seq < inheritedEventCount;
}

/**
 * The child a `subagent/catalog` fact names, undefined for any other event
 * and for one of the first `inheritedEventCount` (a fork's copy of its
 * parent's catalog).
 */
export function catalogChildOf(
  event: { readonly type: string; readonly seq?: unknown; readonly data?: unknown },
  inheritedEventCount = 0
): string | undefined {
  if (event?.type !== 'subagent/catalog' || inherited(event, inheritedEventCount)) return undefined;
  const childId = recordOf(event.data)?.childId;
  return typeof childId === 'string' && childId.length > 0 ? childId : undefined;
}

/**
 * The usage sample one settlement reports, as dsh-token-meter's `usageOf`
 * reads it: an `assistant/message`'s own `usage`, else the last `usage` chunk
 * of its stream (DSH's compact records, `{type: 'chunk', chunk}`), which is
 * also all a failed `assistant/attempt` carries.
 */
function sampleOf(type: string, data: Row): Row | undefined {
  if (type === 'assistant/message' && data.usage !== undefined) return recordOf(data.usage);
  const stream = Array.isArray(data.stream) ? data.stream : [];
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = recordOf(stream[index]);
    const chunk = record?.type === 'chunk' ? recordOf(record.chunk) : undefined;
    if (chunk?.type === 'usage') return recordOf(chunk.usage);
  }
  return undefined;
}

function same(a: DshSpendBuckets, b: DshSpendBuckets): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite
  );
}

/**
 * Folds one event of the session's log into `state`, in place. Mirrors
 * dsh-token-meter's `tokenUsage` unit (stateVersion 2) for the agent loop,
 * `applyAuxiliaryUsage` for compaction summaries, and DSH's catalog for the
 * children. Never throws on a malformed event: it counts nothing.
 */
export function applySessionSpend(
  state: DshSessionSpend,
  event: { readonly type: string; readonly seq?: unknown; readonly data?: unknown }
): void {
  if (typeof event?.type !== 'string' || inherited(event, state.inheritedEventCount)) return;
  const data = recordOf(event.data) ?? {};
  switch (event.type) {
    case 'llm/retry-started':
      if (state.last && state.last.turn === data.turn && state.last.step === data.step) {
        state.last = null;
      }
      return;
    case 'assistant/message':
    case 'assistant/attempt': {
      const sample = sampleOf(event.type, data);
      if (!sample) return;
      const buckets: DshSpendBuckets = {
        input: countOf(sample.inputTokens),
        output: countOf(sample.outputTokens),
        cacheRead: countOf(sample.cacheReadTokens),
        cacheWrite: countOf(sample.cacheWriteTokens),
      };
      const last = state.last;
      const previous =
        last && last.turn === data.turn && last.step === data.step ? last.buckets : undefined;
      if (previous && same(previous, buckets)) return;
      const loop = state.loop;
      loop.input += buckets.input - (previous?.input ?? 0);
      loop.output += buckets.output - (previous?.output ?? 0);
      loop.cacheRead += buckets.cacheRead - (previous?.cacheRead ?? 0);
      loop.cacheWrite += buckets.cacheWrite - (previous?.cacheWrite ?? 0);
      state.last = { turn: data.turn, step: data.step, buckets };
      return;
    }
    case 'compaction/summary':
      addAuxiliaryUsage(state.auxiliary, data.usage);
      return;
    case 'subagent/catalog': {
      const childId = catalogChildOf(event, state.inheritedEventCount);
      if (childId && !state.children.includes(childId)) state.children.push(childId);
      return;
    }
    default:
      return;
  }
}

/** The spend of a whole log. */
export function foldSessionSpend(
  events: Iterable<{ readonly type: string; readonly seq?: unknown; readonly data?: unknown }>,
  inheritedEventCount = 0
): DshSessionSpend {
  const state = initSessionSpend(inheritedEventCount);
  for (const event of events) applySessionSpend(state, event);
  return state;
}

/** Everything the session itself was billed for: its loop and its summaries. */
export function sessionSpendTokens(state: DshSessionSpend): DshSpendBuckets {
  return {
    input: state.loop.input + state.auxiliary.input,
    output: state.loop.output + state.auxiliary.output,
    cacheRead: state.loop.cacheRead + state.auxiliary.cacheRead,
    cacheWrite: state.loop.cacheWrite + state.auxiliary.cacheWrite,
  };
}

/**
 * The delegated share of several sessions' spend, or undefined when none of
 * them reported anything: "no delegate spent anything" is not a measured
 * zero (`deriveDelegatedShare`).
 */
export function sumDelegatedSpend(
  sessions: Iterable<DshSessionSpend>
): DshDelegatedSpend | undefined {
  const sum: DshDelegatedSpend = {
    delegates: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  for (const state of sessions) {
    const tokens = sessionSpendTokens(state);
    const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (total <= 0) continue;
    sum.delegates += 1;
    sum.input += tokens.input;
    sum.output += tokens.output;
    sum.cacheRead += tokens.cacheRead;
    sum.cacheWrite += tokens.cacheWrite;
    sum.totalTokens += total;
  }
  return sum.delegates > 0 ? sum : undefined;
}
