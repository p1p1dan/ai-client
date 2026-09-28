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

/** A `tool_result` history block. */
export type DshToolResultBlock = Extract<HistoryBlock, { type: 'tool_result' }>;

/**
 * `SessionFileChange.patch` bound (`REVIEW_PATCH_BYTES` of
 * `sessionFileChange.ts`, which loads zod and so is out of this library's
 * reach); `projection.test.ts` pins the copy.
 */
export const REVIEW_PATCH_MAX_LENGTH = 64 * 1024;

/** What a tree node is, beyond its role (`SessionTreeNode.entryType`). */
export type DshHistoryEntryType = 'message' | 'compaction' | 'notice';
