import { englishTranslate, type Translate } from '@shared/i18n';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { classifyTool, pairToolBlocks, refusedToolCallIds } from './toolCard';

/**
 * T-05 turn-timing side registry (T-06 pattern): folds `thinking.started` /
 * `thinking.completed` Runtime Events into a per-block duration lookup.
 *
 * Scope is deliberately narrow — A07 screen 5 (groups A-F) has no per-tool
 * duration column (that "right-hand latency column" was explicitly cut), so
 * `tool.started`/`tool.completed` never enter this registry. Only thinking
 * timing is folded HERE.
 *
 * The turn's own "已工作 Ns" head is not folded either: it is DERIVED from the
 * T-06 metadata the message registry already holds, by `deriveTurnWorkedMs`
 * below. That function replaced the old "reuse `MessageMetadata.latencyMs`"
 * note at the bottom of this header — one message's latency is not the turn's,
 * once a tool result or an authorization wait has split the turn into several
 * messages.
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

/**
 * The three row words. English here is the CATALOG KEY, not the copy a Chinese
 * user sees: a `ToolRowView.verb` is translated once, at the single `.tsx`
 * render site (`ToolRows.tsx`), so every row that flows through that view —
 * tool, thought, aggregate, permission — gets the same treatment from one line
 * of code. Keeping the key here also keeps this module pure and its tests
 * readable.
 */
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
export function formatThoughtRow(
  input: {
    durationMs?: number | null;
    streaming?: boolean;
    briefThresholdMs?: number;
  },
  t: Translate = englishTranslate
): ThoughtRowText {
  if (input.streaming) {
    return { verb: THINKING_VERB };
  }
  if (input.durationMs == null) {
    return { verb: THOUGHT_VERB };
  }
  const threshold = input.briefThresholdMs ?? THOUGHT_BRIEF_THRESHOLD_MS;
  if (input.durationMs < threshold) {
    // The arg, unlike the verb, is finished text by the time it leaves here —
    // it interpolates a number, so it cannot be a bare catalog key downstream.
    return { verb: THOUGHT_VERB, arg: t(THOUGHT_BRIEF_ARG), argKind: 'prose' };
  }
  return {
    verb: THOUGHT_VERB,
    // FB8: share the turn head's duration formatter -- a bare `${seconds}s` here
    // rendered "for 1702s". One definition of "how a minute is written", repo-wide.
    arg: t('for {{duration}}', { duration: formatWorkedForDuration(input.durationMs) }),
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

/** A duration already cut into the two units the copy is written in. */
export interface WorkedForParts {
  minutes: number;
  /** Remainder seconds — `0` when the duration lands on a whole minute. */
  seconds: number;
}

/**
 * The ONE place a millisecond count becomes "how long that was".
 *
 * Structured rather than formatted, because the work-group head has to reach a
 * TRANSLATED sentence ("已工作 1 分 6 秒"), and the only way to do that without
 * shipping English into a `{{…}}` slot is to hand the catalog the numbers and
 * let the render site pick the key. `formatWorkedForDuration` below is the
 * English-only rendering of the same split, kept because the thought row's arg
 * interpolates a duration into an already-translated phrase.
 *
 * `Math.max(1, …)` is the floor the head has always had: a turn that happened
 * at all took at least a second to a reader, and "0s" reads as "didn't run".
 */
export function splitWorkedForDuration(latencyMs: number): WorkedForParts {
  const total = Math.max(1, Math.round(latencyMs / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

/** Duration text for the turn head: "31s" under a minute, "1m 6s" above it, "2m" on the minute. */
export function formatWorkedForDuration(latencyMs: number): string {
  const { minutes, seconds } = splitWorkedForDuration(latencyMs);
  if (minutes === 0) return `${seconds}s`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** The two `MessageMetadata` fields this module needs, named structurally so it stays import-free. */
export interface TurnSpanMetadata {
  startedAt?: number | null;
  completedAt?: number | null;
}

/**
 * How long a whole TURN took: last completion minus first start, across every
 * message in its body.
 *
 * Not `MessageMetadata.latencyMs` (which `formatWorkedForRow` uses): that is ONE
 * message's own span, and a turn interrupted by a tool result or an
 * authorization wait is several messages. Reporting the last one's latency
 * would tell a two-minute turn it took four seconds.
 *
 * ## `null` means OMIT, never zero
 *
 * A07 `:2399`'s red line, restated for the turn scale: a restored history turn
 * replays no `message.started` / `message.completed` events, so it has no
 * timestamps at all and there is no honest number to print. Callers must fall
 * back to a different sentence, not to `0s`. Returns `null` when either end is
 * missing, and also when the arithmetic comes out negative — a clock that ran
 * backwards is unknown time, not negative time.
 */
export function deriveTurnWorkedMs(
  metadata: readonly (TurnSpanMetadata | undefined | null)[]
): number | null {
  let earliestStart: number | null = null;
  let latestCompletion: number | null = null;
  for (const entry of metadata) {
    const startedAt = entry?.startedAt;
    if (typeof startedAt === 'number' && (earliestStart === null || startedAt < earliestStart)) {
      earliestStart = startedAt;
    }
    const completedAt = entry?.completedAt;
    if (
      typeof completedAt === 'number' &&
      (latestCompletion === null || completedAt > latestCompletion)
    ) {
      latestCompletion = completedAt;
    }
  }
  if (earliestStart === null || latestCompletion === null) return null;
  const span = latestCompletion - earliestStart;
  return span < 0 ? null : span;
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
  // `verb` is a catalog key (see `THOUGHT_VERB`); `arg` is a duration and an
  // already-translated `stats`, so neither needs `t` here.
  return { verb: WORKED_FOR_VERB, arg, argKind: 'prose' };
}

/**
 * chat-tool-07 — deliberately still the Claude-era names only.
 *
 * Its one reader, `deriveTurnStats` below, has no caller in `src/`: the turn
 * head's count row went with the retired meta row (T12-b), and this file's
 * remaining live export is `THOUGHT_VERB` / `formatThoughtRow`. Adding our own
 * `edit` / `write` here would look like closing a vocabulary gap while actually
 * writing a case for output nobody renders — which is the trap this note
 * exists to defuse. If a turn summary ever comes back, this is the line to fix
 * FIRST, and `runtimeToolVocabulary.test.ts` is where it gets a guard.
 */
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
  options: { style?: 'long' | 'compact' } = {},
  t: Translate = englishTranslate
): string | null {
  // A refused call never ran, so it is not work this turn did. Counting it made
  // the head say `1 edit` about a write the user had just declined — the same
  // past-tense claim the row itself was making (§6.4, G-9).
  const refused = refusedToolCallIds(message.blocks);
  const runs = pairToolBlocks(message.blocks).filter((run) => !refused.has(run.blockId));
  const searchCount = runs.filter((run) => classifyTool(run.toolName) === 'search').length;
  const editCount = runs.filter((run) => EDIT_TOOL_NAMES.has(run.toolName)).length;
  const toolCount = runs.filter(
    (run) => classifyTool(run.toolName) !== 'search' && !EDIT_TOOL_NAMES.has(run.toolName)
  ).length;

  const compact = options.style === 'compact';
  const segments: string[] = [];
  // Singular and plural are separate keys rather than one key plus an `s`:
  // English needs both spellings and Chinese needs neither, and a catalog that
  // only knows the plural would render 「1 个工具s」in one of the two.
  if (toolCount > 0) {
    segments.push(
      compact
        ? toolCount === 1
          ? t('{{count}} tool', { count: toolCount })
          : t('{{count}} tools', { count: toolCount })
        : toolCount === 1
          ? t('{{count}} tool call', { count: toolCount })
          : t('{{count}} tool calls', { count: toolCount })
    );
  }
  if (searchCount > 0) {
    segments.push(
      searchCount === 1
        ? t('{{count}} search', { count: searchCount })
        : t('{{count}} searches', { count: searchCount })
    );
  }
  if (editCount > 0) {
    segments.push(
      editCount === 1
        ? t('{{count}} edit', { count: editCount })
        : t('{{count}} edits', { count: editCount })
    );
  }

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
  // Same exclusion as `deriveTurnStats`: a turn whose only "tool" was refused
  // did no tool work, so if the rest is thinking, that is what it was.
  const refused = refusedToolCallIds(blocks);
  if (pairToolBlocks(blocks).some((run) => !refused.has(run.blockId))) return false;
  return blocks.some((block) => block.type === 'thinking');
}
