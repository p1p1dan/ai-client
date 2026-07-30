import type { ChatMessage } from '@/stores/chatSessions';
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
    return { verb: THOUGHT_VERB, arg: THOUGHT_BRIEF_ARG };
  }
  return { verb: THOUGHT_VERB, arg: `for ${Math.round(input.durationMs / 1000)}s` };
}

export const WORKED_FOR_VERB = 'Worked for';

export interface WorkedForRowText {
  verb: string;
  arg: string;
}

/**
 * Turn-level "Worked for Ns" row. `latencyMs == null` (no T-06 metadata yet,
 * e.g. a freshly hydrated history message) means the row does not render at
 * all — callers must treat `null` as "omit", not as "0s".
 */
export function formatWorkedForRow(latencyMs: number | null | undefined): WorkedForRowText | null {
  if (latencyMs == null) return null;
  const seconds = Math.max(1, Math.round(latencyMs / 1000));
  return { verb: WORKED_FOR_VERB, arg: `${seconds}s` };
}

const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/**
 * "Worked for" row's expand body (A07 :2421 shape), built purely from what
 * `message.blocks` already carries — no first-token-latency segment (no data
 * source; see T-05 spec R-4). The three buckets are mutually exclusive (a
 * search or edit call is not double-counted into the generic "tool calls"
 * bucket); any zero-count segment is omitted; an all-zero message returns
 * null so the row cannot expand into nothing.
 */
export function deriveTurnStats(message: ChatMessage): string | null {
  const runs = pairToolBlocks(message.blocks);
  const searchCount = runs.filter((run) => classifyTool(run.toolName) === 'search').length;
  const editCount = runs.filter((run) => EDIT_TOOL_NAMES.has(run.toolName)).length;
  const toolCount = runs.filter(
    (run) => classifyTool(run.toolName) !== 'search' && !EDIT_TOOL_NAMES.has(run.toolName)
  ).length;

  const segments: string[] = [];
  if (toolCount > 0) segments.push(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`);
  if (searchCount > 0) segments.push(`${searchCount} search${searchCount === 1 ? '' : 'es'}`);
  if (editCount > 0) segments.push(`${editCount} edit${editCount === 1 ? '' : 's'}`);

  return segments.length > 0 ? segments.join(' · ') : null;
}
