import type { HistoryBlock, HistoryMessage } from '../shared/types/sessionHistory.ts';
import { HISTORY_MESSAGE_ID_PREFIX } from '../shared/types/sessionHistory.ts';
import { mapCodexItem, readCodexItemType } from './codexItemMapper.ts';

export const CODEX_HISTORY_MAX_MESSAGES = 1000;
export const CODEX_HISTORY_OUTPUT_BUDGET_CHARS = 8 * 1024 * 1024;

/**
 * Codex `thread/resume` result -> `HistoryMessage[]`. PURE, zero IO, zero state.
 *
 * ## What the input is
 *
 * The `result` body of `thread/resume` (S3 slice 5b, F3): `result.thread.turns[]`,
 * each turn `{id, items[], startedAt, completedAt, status, …}`, plus the three
 * pagination keys `initialTurnsPage` / `turnsBackwardsCursor` /
 * `itemsBackwardsCursor` on the result itself. Every field is read defensively
 * (same idiom as `codexItemMapper.ts`): the shape is [实测] from one recorded
 * frame — `__tests__/fixtures/codex/codex-s5-thread-resume.jsonl` line 9 — and
 * one frame is not a schema, so a missing or re-typed field must degrade, never
 * throw.
 *
 * ## Why the ids are rewritten here and not in the mapper
 *
 * Reprojected item ids are POSITIONAL within a turn (`item-1`, `item-2` [实测],
 * U2-a verdict 1) while the live stream uses heterogeneous per-item ids
 * (`rs_…` / `exec-…` / `msg_…`). Positional ids therefore COLLIDE across turns,
 * and the mapper — shared with the live path — legitimately emits item-local
 * bases (`item-1:text`, toolCallId `item-1`). So the whole namespace
 * `codex:<threadId>:<turnId>:` is applied HERE, on the mapper's output: message
 * id, every block id, and every toolCallId (F1/M8). The mapper stays untouched,
 * and the live path keeps its own id space — the two spaces are known to be
 * disjoint (F2), and dedupe by id across them is judged dead by design.
 *
 * ## What this deliberately does NOT do
 *
 * The `thread/turns/list` shape (`{data:[…turns], nextCursor, backwardsCursor}`,
 * the B1 live-connection path) is not accepted here: its `backwardsCursor` is
 * NON-null even for a complete single-turn history [实测
 * `codex-s5-u2a-report.json` → `threadTurnsList.raw.backwardsCursor`], so the
 * "any non-null cursor means truncated" rule below would over-claim truncation
 * on every read. That shape needs its own cursor rule, decided with its own
 * evidence.
 */

/** Id namespace segment — pairs with `HISTORY_MESSAGE_ID_PREFIX` to form `h:codex:…`. */
export const CODEX_HISTORY_NAMESPACE = 'codex';

/**
 * Result keys that mean "there is more history than this page carries".
 *
 * All three were present-and-null on the single recorded resume [实测]; a
 * non-null value on ANY of them is reported as `truncated` rather than silently
 * returning a partial timeline that looks complete (M6, honesty over
 * completeness — full pagination is registered as L7).
 */
export const CODEX_HISTORY_PAGINATION_KEYS = [
  'initialTurnsPage',
  'turnsBackwardsCursor',
  'itemsBackwardsCursor',
] as const;

/** Per-read counters, so a dropped item is diagnosable from one log line. */
export interface CodexHistoryStats {
  turns: number;
  items: number;
  rendered: number;
  /** Declared unrendered by the mapper, or rendered into zero blocks. */
  skipped: number;
  /** Item types outside the pinned contract — the codex-upgrade signal (G9b). */
  unknown: number;
  /** Frames that were not items at all. */
  malformed: number;
}

/**
 * Field-for-field what `session.history` needs (`SessionHistoryEvent.payload`),
 * so the runtime can spread it into the event without reshaping. `stats` is
 * diagnostics only and is not part of the wire payload.
 */
export interface CodexHistoryReadResult {
  messages: HistoryMessage[];
  truncated: boolean;
  omittedCount: number;
  stats: CodexHistoryStats;
}

export interface ReprojectCodexHistoryOptions {
  /**
   * The session's own resume handle (`runtimeIdentity`). Wins over the echoed
   * `thread.id` because every other id in the session — registry key, resume
   * request, `turn/start` — is keyed on the handle we asked with; the echo is
   * the fallback for a result that carries no thread id at all.
   */
  threadId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Turn timestamps are epoch SECONDS on the wire (`startedAt: 1786767552` [实测]),
 * unlike the `*Ms` fields on the live item frames. Non-numbers yield null, which
 * leaves `HistoryMessage.timestamp` absent rather than stamping 1970.
 */
function epochSecondsToMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) : null;
}

function readTurns(result: Record<string, unknown>): unknown[] {
  const thread = isRecord(result.thread) ? result.thread : null;
  const turns = thread ? thread.turns : result.turns;
  return Array.isArray(turns) ? turns : [];
}

function hasPaginationCursor(result: Record<string, unknown>): boolean {
  return CODEX_HISTORY_PAGINATION_KEYS.some((key) => (result[key] ?? null) !== null);
}

/** Index of the turn's closing agent message, or -1. Its stamp is `completedAt`. */
function findLastAgentMessageIndex(items: readonly unknown[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (readCodexItemType(items[i]) === 'agentMessage') return i;
  }
  return -1;
}

/**
 * Re-key one block into the turn namespace.
 *
 * `rewrite` strips the mapper's item-local base and re-prepends the namespaced
 * item id, so `item-1:text` becomes `codex:<thread>:<turn>:item-1:text` and the
 * tool_call/tool_result pair keeps ONE shared toolCallId (the renderer pairs on
 * it; breaking the pairing would orphan every tool result).
 */
function rewriteBlockIds(block: HistoryBlock, rewrite: (id: string) => string): HistoryBlock {
  if (block.type === 'tool_call' || block.type === 'tool_result') {
    return { ...block, id: rewrite(block.id), toolCallId: rewrite(block.toolCallId) };
  }
  return { ...block, id: rewrite(block.id) };
}

function estimateSize(message: HistoryMessage): number {
  try {
    return JSON.stringify(message).length;
  } catch {
    return 0;
  }
}

/**
 * Reproject a resume result into a chronological timeline. Never throws.
 *
 * One rendered item = one `HistoryMessage` (no merging of consecutive assistant
 * items): the message id is the item's identity, which is what makes a re-read
 * of the same thread idempotent.
 *
 * `turn.status` is deliberately not consulted — a failed or interrupted turn
 * still happened, and its items are still transcript.
 *
 * No `model` is set on assistant messages: the resume result's `model` is the
 * model the thread will CONTINUE with, not necessarily the one that produced
 * these messages.
 */
export function reprojectCodexHistory(
  result: unknown,
  opts: ReprojectCodexHistoryOptions = {}
): CodexHistoryReadResult {
  const root: Record<string, unknown> = isRecord(result) ? result : {};
  const thread = isRecord(root.thread) ? root.thread : null;
  const threadId = opts.threadId ?? str(thread?.id) ?? 'thread';

  const stats: CodexHistoryStats = {
    turns: 0,
    items: 0,
    rendered: 0,
    skipped: 0,
    unknown: 0,
    malformed: 0,
  };

  // Ring buffer capped as we go, mirroring the Claude reader
  // (`historyReader.ts` pushMessage): oldest evicted first, `omittedCount`
  // counts what left, `truncated` says so. Both thresholds are IMPORTED, not
  // re-declared — one agent's history must not be silently allowed to be ten
  // times larger than another's.
  const messages: HistoryMessage[] = [];
  const sizes: number[] = [];
  let runningSize = 0;
  let omittedCount = 0;
  let evicted = false;

  function pushMessage(message: HistoryMessage): void {
    messages.push(message);
    const size = estimateSize(message);
    sizes.push(size);
    runningSize += size;
    while (
      messages.length > CODEX_HISTORY_MAX_MESSAGES ||
      runningSize > CODEX_HISTORY_OUTPUT_BUDGET_CHARS
    ) {
      messages.shift();
      runningSize -= sizes.shift() ?? 0;
      omittedCount += 1;
      evicted = true;
    }
  }

  const turns = readTurns(root);
  for (let t = 0; t < turns.length; t += 1) {
    const rawTurn = turns[t];
    const turn: Record<string, unknown> = isRecord(rawTurn) ? rawTurn : {};
    stats.turns += 1;
    // Positional fallbacks are 1-based, matching the wire's own `item-1`
    // numbering, and they are never interpolated from a possibly-undefined
    // value — an `undefined` inside an id would collide across items.
    const turnId = str(turn.id) ?? `turn-${t + 1}`;
    const namespace = `${CODEX_HISTORY_NAMESPACE}:${threadId}:${turnId}:`;
    const items = Array.isArray(turn.items) ? turn.items : [];
    const startedAtMs = epochSecondsToMs(turn.startedAt);
    const completedAtMs = epochSecondsToMs(turn.completedAt) ?? startedAtMs;
    const lastAgentMessageIndex = findLastAgentMessageIndex(items);

    for (let i = 0; i < items.length; i += 1) {
      const mapping = mapCodexItem(items[i]);
      stats.items += 1;
      if (mapping.outcome === 'unknown') stats.unknown += 1;
      if (mapping.outcome === 'malformed') stats.malformed += 1;
      // Covers not_rendered, unknown, malformed and anything that mapped to
      // zero blocks: an empty message would render as a blank transcript row.
      if (mapping.blocks.length === 0) {
        stats.skipped += 1;
        continue;
      }
      stats.rendered += 1;

      // The positional fallback uses the RAW item index, so a skipped item
      // never renumbers its neighbours: ids stay stable if a future codex
      // version starts rendering a type we skip today.
      const itemId = mapping.itemId ?? `item-p${i + 1}`;
      const namespacedItemId = `${namespace}${itemId}`;
      // The base `mapCodexItem` derived its ids from (`codexItemMapper.ts`
      // `const base = itemId ?? \`codex-${itemType}\``). Reproducing it here is
      // the coupling that lets us swap the base out instead of merely
      // prefixing — prefixing alone would keep two id-less items of the same
      // type sharing one block id.
      const mapperBase = mapping.itemId ?? `codex-${mapping.itemType ?? 'item'}`;
      const rewrite = (id: string): string =>
        id.startsWith(mapperBase)
          ? `${namespacedItemId}${id.slice(mapperBase.length)}`
          : `${namespacedItemId}:${id}`;

      const message: HistoryMessage = {
        id: `${HISTORY_MESSAGE_ID_PREFIX}${namespacedItemId}`,
        role: mapping.role ?? 'assistant',
        blocks: mapping.blocks.map((block) => rewriteBlockIds(block, rewrite)),
      };
      // The turn's closing agent message is stamped when the turn finished;
      // everything else when it started. `completedAt` is nullable [实测], and
      // falls back to `startedAt` rather than to "now" — a replayed message
      // must never claim to be newer than the turn that contains it.
      const timestamp = i === lastAgentMessageIndex ? completedAtMs : startedAtMs;
      if (timestamp !== null) message.timestamp = timestamp;
      pushMessage(message);
    }
  }

  return {
    messages,
    truncated: evicted || hasPaginationCursor(root),
    omittedCount,
    stats,
  };
}
