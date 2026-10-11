/**
 * dsh-rebase decision 180 — the timeline rows of a `/compact` the user ran.
 *
 * It shows as an automatic compaction does (decision 178): its command line,
 * then the compaction's own row — running, then the context summary, or a
 * note saying why there is none. The rows the history projects for it carry
 * the ids the live ones had (`dsh-compact-command-<id>`,
 * `dsh-compaction-<id>`), so a replay folds them in place.
 *
 * The composer shows the two rows the moment Enter is pressed, before the
 * engine has a compaction id (the conversation may first have to be started):
 * under ids of its own (`compact-run-<n>`), which the bridge's `started`
 * renames to the live ones. What the composer learns at the end settles the
 * row the bridge has not settled already.
 *
 * Leaf module: no store imports (the reducer in `chatSessions.ts` calls it).
 */

import {
  COMPACT_INSTRUCTIONS_NOTE_KEY,
  compactInstructionsNoteText,
} from '@shared/compactInstructions';
import {
  CONTEXT_SUMMARY_TITLE,
  DSH_COMPACT_COMMAND_LIVE_ID_PREFIX,
  DSH_COMPACT_COMMAND_PART,
  DSH_COMPACT_INSTRUCTIONS_PART,
  DSH_COMPACTION_FAILED_PART,
  DSH_COMPACTION_LIVE_ID_PREFIX,
  DSH_COMPACTION_RUNNING_PART,
  DSH_SUMMARY_PART,
  type DshCompactNote,
  dshCompactCommandLiveId,
  dshCompactionNoteBlockId,
  dshCompactNoteText,
  isDshCompactCommandRow,
} from '@shared/dshHistory/types';
import type { ChatMessage } from './chatSessions';

/** The composer's own ids for a run's two rows, until the bridge names them. */
export const COMPACT_RUN_ID_PREFIX = 'compact-run-';

export function compactRunRowIds(runId: string): { command: string; status: string } {
  return {
    command: `${COMPACT_RUN_ID_PREFIX}${runId}-command`,
    status: `${COMPACT_RUN_ID_PREFIX}${runId}`,
  };
}

export function compactCommandRow(sessionId: string, id: string, text: string): ChatMessage {
  return {
    id,
    sessionId,
    role: 'system',
    blocks: [{ id: `${id}:${DSH_COMPACT_COMMAND_PART}:0`, type: 'text', text }],
  };
}

/** The running row, saying `key` (compacting, or starting the conversation first). */
export function compactRunningRow(sessionId: string, id: string, key: string): ChatMessage {
  return {
    id,
    sessionId,
    role: 'system',
    blocks: [
      {
        id: dshCompactionNoteBlockId(id, DSH_COMPACTION_RUNNING_PART),
        type: 'text',
        text: key,
        notice: { key },
      },
    ],
  };
}

/** Why there is no summary: the history's note for the same outcome. */
export function compactNoteRow(sessionId: string, id: string, note: DshCompactNote): ChatMessage {
  return {
    id,
    sessionId,
    role: 'system',
    blocks: [
      {
        id: dshCompactionNoteBlockId(id, DSH_COMPACTION_FAILED_PART),
        type: 'text',
        text: dshCompactNoteText(note),
        notice: { key: note.key, ...(note.params ? { params: note.params } : {}) },
      },
    ],
  };
}

/** The summary row as the history projects it, with decision 179's line when there were instructions. */
export function compactSummaryRow(
  sessionId: string,
  id: string,
  summary: string | undefined,
  instructions?: string
): ChatMessage {
  return {
    id,
    sessionId,
    role: 'system',
    blocks: [
      { id: `${id}:${DSH_SUMMARY_PART}:0`, type: 'text', text: summary || CONTEXT_SUMMARY_TITLE },
      ...(instructions
        ? [
            {
              id: `${id}:${DSH_COMPACT_INSTRUCTIONS_PART}:0`,
              type: 'text' as const,
              text: compactInstructionsNoteText(instructions),
              notice: { key: COMPACT_INSTRUCTIONS_NOTE_KEY, params: { instructions } },
            },
          ]
        : []),
    ],
  };
}

export function isRunningCompactionRow(message: ChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks[0]?.id === dshCompactionNoteBlockId(message.id, DSH_COMPACTION_RUNNING_PART)
  );
}

/**
 * The compaction id behind a live or replayed manual row, read off its live
 * id: `dsh-compaction-<id>`, `dsh-compact-command-<id>`; undefined otherwise.
 */
function compactionIdOf(id: string, prefix: string): string | undefined {
  return id.startsWith(prefix) ? id.slice(prefix.length) || undefined : undefined;
}

/**
 * Whether `message` (a compaction's row) belongs to a `/compact` the user
 * ran rather than to a turn: the composer's own row, or a live row whose
 * command line is in the bucket. Nothing settles it at a turn's end.
 */
export function isManualCompactionRow(
  bucket: readonly ChatMessage[],
  message: ChatMessage
): boolean {
  if (message.id.startsWith(COMPACT_RUN_ID_PREFIX)) return true;
  const compactionId = compactionIdOf(message.id, DSH_COMPACTION_LIVE_ID_PREFIX);
  if (!compactionId) return false;
  const command = dshCompactCommandLiveId(compactionId);
  return bucket.some(
    (row) => isDshCompactCommandRow(row) && (row.id === command || row.liveMessageId === command)
  );
}

/** The composer's rows of a run still waiting for the bridge to name them, newest last. */
function placeholders(bucket: readonly ChatMessage[]): { command: number; status: number } | null {
  let status = -1;
  for (let index = bucket.length - 1; index >= 0; index -= 1) {
    const row = bucket[index];
    if (row?.id.startsWith(COMPACT_RUN_ID_PREFIX) && isRunningCompactionRow(row)) {
      status = index;
      break;
    }
  }
  if (status < 0) return null;
  const statusId = bucket[status]?.id ?? '';
  const command = bucket.findIndex((row) => row.id === `${statusId}-command`);
  return { command, status };
}

/**
 * Decision 180, the bridge's `started` for a `/compact`: the composer's two
 * rows take the live ids (in place), or — another window's, or a reload's —
 * the command line and the running row go at the end.
 */
export function withManualCompactionStarted(
  bucket: readonly ChatMessage[],
  sessionId: string,
  payload: { messageId: string; commandMessageId?: string; command?: string; key: string }
): ChatMessage[] {
  if (bucket.some((row) => row.id === payload.messageId)) return [...bucket];
  const commandId = payload.commandMessageId ?? `${payload.messageId}-command`;
  const found = placeholders(bucket);
  if (found) {
    const next = bucket.slice();
    const status = next[found.status];
    if (status) next[found.status] = compactRunningRow(sessionId, payload.messageId, payload.key);
    const command = found.command >= 0 ? next[found.command] : undefined;
    if (command) {
      const text = payload.command ?? textOf(command);
      next[found.command] = compactCommandRow(sessionId, commandId, text);
    }
    return next;
  }
  return [
    ...bucket,
    compactCommandRow(sessionId, commandId, payload.command ?? '/compact'),
    compactRunningRow(sessionId, payload.messageId, payload.key),
  ];
}

function textOf(message: ChatMessage): string {
  const block = message.blocks[0];
  return block?.type === 'text' ? (block.text ?? '') : '';
}

/**
 * The composer settles its run. `summary`: the row the answer carried (the
 * history's own, by its `h:` id) takes the running row's place — or the place
 * of the live summary the bridge already made of it — and the composer's
 * command line takes the live id the summary names. `note`: a running row
 * says why there is no summary; one the bridge settled already is left as it
 * is. `remove`: nothing ran — the composer's rows go, the bridge's stay.
 */
export type CompactRunSettle =
  | { kind: 'summary'; summary: ChatMessage; liveMessageId?: string }
  | { kind: 'note'; note: DshCompactNote }
  | { kind: 'remove' };

export function withCompactRunSettled(
  bucket: readonly ChatMessage[],
  sessionId: string,
  runId: string,
  settle: CompactRunSettle
): ChatMessage[] {
  const ids = compactRunRowIds(runId);
  const statusIndex = bucket.findIndex((row) => row.id === ids.status);
  if (settle.kind === 'remove') {
    return bucket.filter((row) => row.id !== ids.status && row.id !== ids.command);
  }
  if (settle.kind === 'note') {
    const index =
      statusIndex >= 0
        ? statusIndex
        : findLastIndex(
            bucket,
            (row) => isRunningCompactionRow(row) && isManualCompactionRow(bucket, row)
          );
    const row = index >= 0 ? bucket[index] : undefined;
    if (!row || !isRunningCompactionRow(row)) return [...bucket];
    const next = bucket.slice();
    next[index] = compactNoteRow(sessionId, row.id, settle.note);
    return next;
  }
  const live = settle.liveMessageId;
  const next = bucket.filter((row) => row.id !== settle.summary.id);
  const index =
    statusIndex >= 0
      ? next.findIndex((row) => row.id === ids.status)
      : live
        ? next.findIndex((row) => row.id === live)
        : -1;
  if (index >= 0) next[index] = settle.summary;
  else next.push(settle.summary);
  // The composer's command line, when the bridge never named it: the id the
  // history gives it is the one the summary's compaction names.
  const compactionId = live ? compactionIdOf(live, DSH_COMPACTION_LIVE_ID_PREFIX) : undefined;
  const commandIndex = next.findIndex((row) => row.id === ids.command);
  const command = commandIndex >= 0 ? next[commandIndex] : undefined;
  if (command && compactionId) {
    next[commandIndex] = compactCommandRow(
      sessionId,
      `${DSH_COMPACT_COMMAND_LIVE_ID_PREFIX}${compactionId}`,
      textOf(command)
    );
  }
  return next;
}

function findLastIndex<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && test(item)) return index;
  }
  return -1;
}
