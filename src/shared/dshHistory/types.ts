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
/** `ContextForm` of a one-off account of something that happened (`dsh-llm`). */
export const DSH_FORM_NOTICE = 'notice';
/**
 * `AgentCancelCause` reason of the Ctrl+Enter stop at a step boundary (P1-4c,
 * decision 029): `cancel({kind: 'hook', reason: AICLIENT_INTERJECT_REASON})`.
 */
export const AICLIENT_INTERJECT_REASON = 'aiclient-interject';

/** `tool/result.error.code`: Stop reached the call before it was dispatched (`dsh-tools`). */
export const DSH_TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH';
/** `tool/result.error.code`: the call ran and was cancelled (`dsh-tools` `TOOL_ABORTED`). */
export const DSH_TOOL_ABORTED = 'ABORTED';
/** `tool/result.error.code` of a crash or fork closer: no start was recorded (`dsh-session`). */
export const DSH_TOOL_NOT_STARTED = 'TOOL_NOT_STARTED';
/** `tool/result.error.code` of a crash or fork closer: started, result never recorded. */
export const DSH_TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN';

/**
 * A `tool_result` history block with the P1-4 flag `sessionHistory.ts` does not
 * carry yet: the call started, the engine died, and its outcome was never
 * recorded (`TOOL_OUTCOME_UNKNOWN`, decision 032). It rides the wire as an
 * extra optional field until the shared type and the renderer adopt it.
 */
export type DshToolResultBlock = Extract<HistoryBlock, { type: 'tool_result' }> & {
  outcomeUnknown?: true;
};

/** What a tree node is, beyond its role (`SessionTreeNode.entryType`). */
export type DshHistoryEntryType = 'message' | 'compaction' | 'notice';
