import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { classifyTool, pairToolBlocks } from './toolCard';

/**
 * T-05 turn-timing side registry (T-06 pattern): folds `thinking.started` /
 * `thinking.completed` Runtime Events into a per-block duration lookup.
 *
 * Scope is deliberately narrow — A07 screen 5 (groups A-F) has no per-tool
 * duration column (that "right-hand latency column" was explicitly cut), so
 * `tool.started`/`tool.completed` never enter this registry. Only thinking
 * timing is tracked here; the turn's own "Worked for Ns" line reuses the
 * existing T-06 `MessageMetadata.latencyMs` (see `formatWorkedForRow`) and is
 * not folded again in this module.
 */

export interface ThinkingTiming {
  startedAt?: number | null;
  completedAt?: number | null;
  /** completed - started; only set once both timestamps are known. */
  durationMs?: number | null;
}

export interface TurnTimingRegistry {
  byBlock: Record<string, ThinkingTiming>;
}

export const initialTurnTimingRegistry: TurnTimingRegistry = {
  byBlock: {},
};

interface TurnTimingEvent {
  type: string;
  sessionId?: string;
  timestamp?: number;
  payload?: unknown;
}

function readBlockId(event: TurnTimingEvent): string | undefined {
  const payload = event.payload;
  if (
    payload &&
    typeof payload === 'object' &&
    typeof (payload as { blockId?: unknown }).blockId === 'string'
  ) {
    return (payload as { blockId: string }).blockId;
  }
  return undefined;
}

/**
 * Fold one Runtime Event into the registry. Pure; only `thinking.started` /
 * `thinking.completed` are handled — everything else returns `prev` by
 * reference so callers can skip a re-render.
 */
export function reduceTurnTiming(
  prev: TurnTimingRegistry,
  event: TurnTimingEvent
): TurnTimingRegistry {
  if (event.type !== 'thinking.started' && event.type !== 'thinking.completed') {
    return prev;
  }
  const blockId = readBlockId(event);
  if (!blockId) return prev;

  const existing = prev.byBlock[blockId] ?? {};
  if (event.type === 'thinking.started') {
    return {
      byBlock: {
        ...prev.byBlock,
        [blockId]: { ...existing, startedAt: event.timestamp ?? null },
      },
    };
  }

  // thinking.completed
  const startedAt = existing.startedAt ?? null;
  const completedAt = event.timestamp ?? null;
  const durationMs = startedAt != null && completedAt != null ? completedAt - startedAt : null;
  return {
    byBlock: {
      ...prev.byBlock,
      [blockId]: { ...existing, completedAt, durationMs },
    },
  };
}

/** Short-thought threshold: below this, the row says "briefly" instead of a second count. */
export const THOUGHT_BRIEF_THRESHOLD_MS = 5_000;

export const THOUGHT_VERB = 'Thought';
export const THINKING_VERB = 'Thinking';
export const THOUGHT_BRIEF_ARG = 'briefly';

export interface ThoughtRowText {
  verb: string;
  arg?: string;
  /**
   * D25 §2.4: the "for Ns" / "briefly" arg is prose, not an identifier --
   * always 'prose' when `arg` is set, absent when it isn't (bare "Thought" /
   * "Thinking" has no arg to classify).
   */
  argKind?: 'prose';
}

/**
 * Thought row copy. Historical messages (no folded timing) never get a
 * fabricated duration — they show a bare "Thought" with no `arg` rather than
 * guessing a number (A07 :2399).
 */
export function formatThoughtRow(input: {
  durationMs?: number | null;
  streaming?: boolean;
  briefThresholdMs?: number;
}): ThoughtRowText {
  if (input.streaming) {
    return { verb: THINKING_VERB };
  }
  if (input.durationMs == null) {
    return { verb: THOUGHT_VERB };
  }
  const threshold = input.briefThresholdMs ?? THOUGHT_BRIEF_THRESHOLD_MS;
  if (input.durationMs < threshold) {
    return { verb: THOUGHT_VERB, arg: THOUGHT_BRIEF_ARG, argKind: 'prose' };
  }
  return {
    verb: THOUGHT_VERB,
    // FB8: share the turn head's duration formatter -- a bare `${seconds}s` here
    // rendered "for 1702s". One definition of "how a minute is written", repo-wide.
    arg: `for ${formatWorkedForDuration(input.durationMs)}`,
    argKind: 'prose',
  };
}

export const WORKED_FOR_VERB = 'Worked for';

export interface WorkedForRowText {
  verb: string;
  arg: string;
  /** D25 §2.4: the "Ns" arg is prose, not an identifier -- always set (arg is mandatory here). */
  argKind: 'prose';
}

/** Duration text for the turn head: "31s" under a minute, "1m 6s" above it, "2m" on the minute. */
export function formatWorkedForDuration(latencyMs: number): string {
  const seconds = Math.max(1, Math.round(latencyMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/**
 * Turn-level "Worked for Ns" row. `latencyMs == null` (no T-06 metadata yet,
 * e.g. a freshly hydrated history message) means the row does not render at
 * all — callers must treat `null` as "omit", not as "0s". This is the guard
 * A07 `:2399` ("never fabricate seconds") rests on, and T-31 keeps it verbatim.
 *
 * T-31 (§4.2): `stats` appends the turn's call counts to the same arg, e.g.
 * "Worked for 1m 6s · 3 tools, 11 searches". A07 v3 made those counts the row's
 * *expand body*; round-4's collapsed/expanded pair showed the body is the
 * process segment instead, so the counts move up into the collapsed row — which
 * ends up carrying more information than before, not less. Pass
 * `deriveTurnStats(message, { style: 'compact' })`; a `null`/empty value leaves
 * the arg exactly as it was.
 */
export function formatWorkedForRow(
  latencyMs: number | null | undefined,
  stats?: string | null
): WorkedForRowText | null {
  if (latencyMs == null) return null;
  const duration = formatWorkedForDuration(latencyMs);
  const arg = stats ? `${duration} · ${stats}` : duration;
  return { verb: WORKED_FOR_VERB, arg, argKind: 'prose' };
}

const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/**
 * Turn call counts, built purely from what `message.blocks` already carries —
 * no first-token-latency segment (no data source; see T-05 spec R-4). The three
 * buckets are mutually exclusive (a search or edit call is not double-counted
 * into the generic tool bucket); any zero-count segment is omitted; an all-zero
 * message returns null so nothing renders an empty summary.
 *
 * Two renderings of the same single count, chosen by `style` (T-31 §4.2):
 *  - `long` (default, A07 :2421's shape) — "3 tool calls · 11 searches · 1 edit",
 *    the standalone body form.
 *  - `compact` — "3 tools, 11 searches, 1 edit", the form that rides along
 *    inside the "Worked for …" arg, where ` · ` is already taken as the
 *    separator between duration and counts.
 */
export function deriveTurnStats(
  message: ChatMessage,
  options: { style?: 'long' | 'compact' } = {}
): string | null {
  const runs = pairToolBlocks(message.blocks);
  const searchCount = runs.filter((run) => classifyTool(run.toolName) === 'search').length;
  const editCount = runs.filter((run) => EDIT_TOOL_NAMES.has(run.toolName)).length;
  const toolCount = runs.filter(
    (run) => classifyTool(run.toolName) !== 'search' && !EDIT_TOOL_NAMES.has(run.toolName)
  ).length;

  const compact = options.style === 'compact';
  const segments: string[] = [];
  if (toolCount > 0) {
    const noun = compact ? 'tool' : 'tool call';
    segments.push(`${toolCount} ${noun}${toolCount === 1 ? '' : 's'}`);
  }
  if (searchCount > 0) segments.push(`${searchCount} search${searchCount === 1 ? '' : 'es'}`);
  if (editCount > 0) segments.push(`${editCount} edit${editCount === 1 ? '' : 's'}`);

  if (segments.length === 0) return null;
  return segments.join(compact ? ', ' : ' · ');
}

/**
 * True when a turn's whole process segment is thinking and nothing else — no
 * tool run at all. `deriveTurnStats` above counts only tool runs (search /
 * edit / generic), by design (T-31, "no invented time"), so a turn made of a
 * single thinking block scores zero on every bucket and returns `null`. Before
 * this, `turnHead.ts`'s degradation chain then fell all the way to its `bare`
 * rung — a text-less chevron — discarding the one thing the turn actually
 * knows: the process was a thought. `turnHead.ts` uses this to add a `thought`
 * rung between `stats` and `bare` (D25 §2.4's "bare Thought, no arg" applied
 * one level up, from the per-row shape to the turn head).
 *
 * Reads the same block list `deriveTurnStats` already scans, for the same
 * reason it lives here rather than in `turnHead.ts` (a leaf module with no
 * block-shape knowledge of its own).
 */
export function turnHasThinkingOnlyProcess(blocks: readonly ChatBlock[]): boolean {
  if (pairToolBlocks(blocks).length > 0) return false;
  return blocks.some((block) => block.type === 'thinking');
}
