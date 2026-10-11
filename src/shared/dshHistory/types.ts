// New in dsh-rebase P1-4a

/**
 * The slice of DSH's session-log vocabulary (`@deepseek-ai/dsh-session` and
 * `@deepseek-ai/dsh-llm` 0.1.7-rc.2) the history projection reads.
 *
 * Declared here rather than imported: this library runs where DSH is not
 * installed (the root Vitest, Electron Main's read-only replay) and inside the
 * bundled bridge, whose only npm import may be `@deepseek-ai/dsh-llm`. Every
 * field is read defensively, so a log written by another DSH version degrades
 * to fewer rows instead of a failed read.
 */

import type { HistoryBlock } from '../types/sessionHistory.ts';

/** One event of a DSH session log, as `sessionQuery.observeSession` and `session/event` carry it. */
export interface DshLogEvent {
  readonly type: string;
  /** Contiguous from 0 within one DSH session, inherited fork prefix included. */
  readonly seq: number;
  /** Unix epoch milliseconds. */
  readonly time: number;
  readonly data: unknown;
  readonly surfaceOp?: unknown;
  readonly sourceEventSeqs?: readonly number[];
  readonly ignorable?: true;
}

/** `MessageSource.kind` of a message the human typed. */
export const DSH_SOURCE_USER = 'user';
/** `MessageSource.kind` of the replacement node a compaction lands (`dsh-compaction-basic`). */
export const DSH_SOURCE_COMPACT_CHECKPOINT = 'compact-checkpoint';
/**
 * `MessageSource.kind` of the hidden continuation prompt a retry sends
 * (P1-4c, dsh-rebase decision 028). Model context only: never a bubble, and
 * the failed turn it continues loses its placeholder.
 */
export const DSH_SOURCE_AICLIENT_RETRY = 'aiclient-retry';
/**
 * The text of that continuation prompt (P1-4c1, decisions 028 and 095): one
 * English sentence the model reads after a failed turn; the user never sees it.
 */
export const DSH_RETRY_CONTINUATION_TEXT =
  'The previous model request failed. Continue from where it stopped.';
/**
 * `MessageSource.kind` of a pi branch summary a migration seed carries (P1-9,
 * `SEED_SOURCE_KIND.piBranchSummary`): model context wrapped in pi's framing,
 * shown as "Context summary" the way 1.0.x showed its `branch_summary` entry.
 */
export const DSH_SOURCE_AICLIENT_PI_BRANCH_SUMMARY = 'aiclient-pi-branch-summary';
/**
 * pi's framing around a branch summary (`BRANCH_SUMMARY_PREFIX` / `_SUFFIX`
 * of `legacyPiSession/convert/llmText.ts`, which this library may not load);
 * `projection.test.ts` pins the copies together.
 */
export const PI_BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
export const PI_BRANCH_SUMMARY_SUFFIX = '</summary>';
/** `ContextForm` of a one-off account of something that happened (`dsh-llm`). */
export const DSH_FORM_NOTICE = 'notice';
/**
 * `AgentCancelCause` reason of a 1.0.x Ctrl+Enter stop at a turn boundary, as
 * the migration converter writes it (`legacyPiSession/convert/seed.ts`), so a
 * migrated session still shows "interjected". The bridge never cancels with
 * it: under DSH Ctrl+Enter steers the running turn (P1-4c1, decision 093,
 * which replaced decision 029's cancel at a step boundary).
 */
export const AICLIENT_INTERJECT_REASON = 'aiclient-interject';
/**
 * `AgentCancelCause` reason of the step ceiling's cut after its wrap-up step
 * (P1-8, `TURN_CEILING_CANCEL_REASON` of src/dsh-host/loopGuard/constants.ts,
 * which the bridge bundle may not take in; a test pins the two together). The
 * live bridge ends such a run as `turn_limit` (decision 081's handoff).
 */
export const AICLIENT_TURN_CEILING_REASON = 'aiclient-turn-ceiling';

/** `tool/result.error.code`: Stop reached the call before it was dispatched (`dsh-tools`). */
export const DSH_TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH';
/** `tool/result.error.code`: the call ran and was cancelled (`dsh-tools` `TOOL_ABORTED`). */
export const DSH_TOOL_ABORTED = 'ABORTED';
/** `tool/result.error.code` of a crash or fork closer: no start was recorded (`dsh-session`). */
export const DSH_TOOL_NOT_STARTED = 'TOOL_NOT_STARTED';
/** `tool/result.error.code` of a crash or fork closer: started, result never recorded. */
export const DSH_TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN';
/**
 * `tool/result.error.name` of a call our permission gate refused
 * (`src/dsh-host/permissions/permissionHost.ts`, P1-6b); a card the user
 * denied, a rule, a timeout. A call whose card Stop took down is cancelled
 * instead, and reads `ABORTED_BEFORE_DISPATCH` (decision 088 rule 6).
 */
export const AICLIENT_PERMISSION_DENIAL = 'PermissionDenial';
/** `tool/result.error.name` of a call the loop guard refused inside the step ceiling's wrap-up (P1-8). */
export const AICLIENT_LOOP_GUARD_DENIAL = 'LoopGuard';

/** A `tool_result` history block. */
export type DshToolResultBlock = Extract<HistoryBlock, { type: 'tool_result' }>;

/**
 * `SessionFileChange.patch` bound (`REVIEW_PATCH_BYTES` of
 * `sessionFileChange.ts`, which loads zod and so is out of this library's
 * reach); `projection.test.ts` pins the copy.
 */
export const REVIEW_PATCH_MAX_LENGTH = 64 * 1024;

/**
 * Part-id kind of the first block of a context-summary row (`<row id>:summary:0`):
 * a compaction's checkpoint, or a migrated pi branch summary. The projection
 * mints it; `isDshSummaryRow` reads it back.
 */
export const DSH_SUMMARY_PART = 'summary';

/**
 * The first line of a context-summary row's text, above the summary itself.
 * The row is transcript data, so it is written in English like every other
 * projected byte; the renderer shows this line in the UI language
 * (dsh-rebase decision 144) and leaves the summary under it as it is.
 */
export const CONTEXT_SUMMARY_TITLE = 'Context summary';

/**
 * Whether a timeline row is a context summary, by the id of its first block —
 * a history row as the projection wrote it, or the same row in the renderer's
 * store, which keeps block ids as they came. dsh-rebase P1-7e (decision 140):
 * a turn's clock must not run on to a compaction that happened after it.
 */
export function isDshSummaryRow(message: {
  readonly id: string;
  readonly role: string;
  readonly blocks: readonly { readonly id: string }[];
}): boolean {
  return (
    message.role === 'system' && message.blocks[0]?.id === `${message.id}:${DSH_SUMMARY_PART}:0`
  );
}

/**
 * dsh-rebase decision 178: the live id of an automatic compaction's row
 * (`dsh-compaction-<compactionId>`, `session.compaction`). The history names
 * it as `liveMessageId` on the same compaction's summary row, or on its note
 * when it failed, so the live row and the replayed one are one row.
 */
export const DSH_COMPACTION_LIVE_ID_PREFIX = 'dsh-compaction-';

export function dshCompactionLiveId(compactionId: string): string {
  return `${DSH_COMPACTION_LIVE_ID_PREFIX}${compactionId}`;
}

/**
 * Decision 178: part-id kinds of the first block of a compaction's own note
 * (`<row id>:<kind>:0`), the way `DSH_SUMMARY_PART` marks a summary: one still
 * running (live only), and one that ended without a summary.
 */
export const DSH_COMPACTION_RUNNING_PART = 'compaction-running';
export const DSH_COMPACTION_FAILED_PART = 'compaction-failed';

/**
 * Decision 178: the notes, dictionary keys in English like every projected
 * byte (the row's `notice.key`). The running line is the one decision 176
 * gave the composer's `/compact` status line; since decision 180 a `/compact`
 * runs in the timeline too, on this same row.
 */
export const DSH_COMPACTION_RUNNING_KEY = 'Compacting the context…';
/** A pressure compaction failed; the step goes on with the context it had. */
export const DSH_COMPACTION_FAILED_KEY =
  'Automatic compaction did not succeed; this turn goes on with the full context.';
/** An overflow compaction failed; the refused request still does not fit. */
export const DSH_COMPACTION_OVERFLOW_FAILED_KEY =
  'Automatic compaction did not succeed; the request still exceeds the model’s context window.';
/** Stopped while it ran, or the engine went away under it. */
export const DSH_COMPACTION_INTERRUPTED_KEY =
  'Automatic compaction did not finish; the context was not compacted.';

/** The first-block id of a compaction note row. */
export function dshCompactionNoteBlockId(
  rowId: string,
  kind: typeof DSH_COMPACTION_RUNNING_PART | typeof DSH_COMPACTION_FAILED_PART
): string {
  return `${rowId}:${kind}:0`;
}

/**
 * Whether a timeline row is a compaction's own note — running, failed or
 * interrupted (decision 178) — by the id of its first block, as
 * `isDshSummaryRow` reads a summary. Like a summary, it is not a turn's work.
 */
export function isDshCompactionNoteRow(message: {
  readonly id: string;
  readonly role: string;
  readonly blocks: readonly { readonly id: string }[];
}): boolean {
  if (message.role !== 'system') return false;
  const first = message.blocks[0]?.id;
  return (
    first === dshCompactionNoteBlockId(message.id, DSH_COMPACTION_RUNNING_PART) ||
    first === dshCompactionNoteBlockId(message.id, DSH_COMPACTION_FAILED_PART)
  );
}

/**
 * dsh-rebase decision 180: a `/compact` the user ran shows in the timeline as
 * an automatic compaction does — its command line, then the compaction's own
 * row (running, then the summary, or a note saying why there is none). The
 * command line is a system row whose first block is `<row id>:compact-command:0`;
 * live it is `dsh-compact-command-<compactionId>`, and the history names that
 * id on the row it projects from the same `compaction/start`.
 */
export const DSH_COMPACT_COMMAND_PART = 'compact-command';
/**
 * Part-id kind of a context summary's line about the `/compact` instructions
 * it was written with (decision 179): `<row id>:compact-instructions:0`.
 */
export const DSH_COMPACT_INSTRUCTIONS_PART = 'compact-instructions';
export const DSH_COMPACT_COMMAND_LIVE_ID_PREFIX = 'dsh-compact-command-';

export function dshCompactCommandLiveId(compactionId: string): string {
  return `${DSH_COMPACT_COMMAND_LIVE_ID_PREFIX}${compactionId}`;
}

/** The command line's text: `/compact`, and what was typed after it. */
export function dshCompactCommandText(instructions: string | undefined): string {
  return instructions ? `/compact ${instructions}` : '/compact';
}

/** Whether a timeline row is a `/compact` command line (decision 180), by its first block. */
export function isDshCompactCommandRow(message: {
  readonly id: string;
  readonly role: string;
  readonly blocks: readonly { readonly id: string }[];
}): boolean {
  return (
    message.role === 'system' &&
    message.blocks[0]?.id === `${message.id}:${DSH_COMPACT_COMMAND_PART}:0`
  );
}

/**
 * Decision 180: why the bridge aborted a `/compact`. DSH's command logs the
 * abort reason's message as its `command/done` text (`dsh-commands`
 * `withAbort`), so the history can tell a cancel from the time limit — the
 * same way the step ceiling's cut is told apart (`AICLIENT_TURN_CEILING_REASON`).
 */
export const AICLIENT_COMPACT_CANCELLED_REASON = 'aiclient: /compact was cancelled by the user';
export const AICLIENT_COMPACT_TIMEOUT_REASON =
  'aiclient: /compact ran past its time limit and was cancelled';

/**
 * Decision 180: the notes a `/compact` that wrote no summary leaves where it
 * ran, dictionary keys like every projected byte. The first three are the
 * composer's own words for the same outcomes (decision 176).
 */
export const DSH_COMPACT_CANCELLED_KEY = 'Compaction cancelled. Nothing was compacted.';
export const DSH_COMPACT_TIMEOUT_KEY =
  'Summarizing took too long, so the compaction was cancelled. Nothing was compacted.';
export const DSH_COMPACT_NO_SUMMARY_KEY =
  'No useful summary could be written, so nothing was compacted. The attempt is recorded in the session log.';
/** DSH's own sentence follows (`{{reason}}`): a history that changed under it, say. */
export const DSH_COMPACT_FAILED_REASON_KEY =
  'The compaction did not succeed, and nothing was compacted: {{reason}}';
export const DSH_COMPACT_FAILED_KEY = 'The compaction did not succeed, and nothing was compacted.';
/** Started and never closed: the engine went away under it. */
export const DSH_COMPACT_INTERRUPTED_KEY =
  'The compaction did not finish; the context was not compacted.';
/** Live only, while the conversation is being started for it (decision 176). */
export const DSH_COMPACT_STARTING_KEY = 'Starting the conversation…';

/** How much of DSH's sentence a note keeps. */
const COMPACT_REASON_CHARS = 500;

export interface DshCompactNote {
  key: string;
  params?: Record<string, string>;
}

/**
 * Decision 180: the note a `/compact` that ended without a summary leaves,
 * from what its `command/done` said (the abort reason the bridge gave, or
 * DSH's sentence). The bridge's live row, the history's row and the
 * composer's settle all read it here, so the three say the same.
 */
export function dshCompactNote(doneText: string | undefined): DshCompactNote {
  const text = doneText?.trim();
  if (!text) return { key: DSH_COMPACT_FAILED_KEY };
  if (text === AICLIENT_COMPACT_CANCELLED_REASON) return { key: DSH_COMPACT_CANCELLED_KEY };
  if (text === AICLIENT_COMPACT_TIMEOUT_REASON) return { key: DSH_COMPACT_TIMEOUT_KEY };
  if (/could not produce a (?:useful|smaller) summary/iu.test(text)) {
    return { key: DSH_COMPACT_NO_SUMMARY_KEY };
  }
  // DSH's own cancel (the agent was disposed under it), not the user's.
  if (/^compaction cancelled\.?$/iu.test(text)) return { key: DSH_COMPACT_INTERRUPTED_KEY };
  const reason =
    text.length > COMPACT_REASON_CHARS ? `${text.slice(0, COMPACT_REASON_CHARS)}…` : text;
  return { key: DSH_COMPACT_FAILED_REASON_KEY, params: { reason } };
}

/** The English rendering of a note, for a row's `text` (the renderer translates `notice`). */
export function dshCompactNoteText(note: DshCompactNote): string {
  const reason = note.params?.reason;
  return reason === undefined ? note.key : note.key.replace('{{reason}}', () => reason);
}

/** What a tree node is, beyond its role (`SessionTreeNode.entryType`). */
export type DshHistoryEntryType = 'message' | 'compaction' | 'notice';
