import type { SessionFileChange } from '../sessionFileChange.ts';

/**
 * Session history shapes for Pi `session.history` hydration and isolated
 * T34 legacy migration-reader adapters.
 * See docs/plans/2026-07-24-c06-session-history-protocol-draft.md
 */

/**
 * T023 — a line the APP wrote into a transcript, marked as translatable.
 *
 * Almost everything in a history block is content: the user typed it or a
 * model produced it, and it must reach the screen byte for byte. A handful of
 * lines are not — they are this app explaining its own state inside the
 * transcript, and those are UI copy that has to follow the language setting.
 *
 * Nothing distinguished the two, so the one such line we had
 * (`piSessionTimeline`'s imported-history banner) was written as a finished
 * Chinese sentence in a worker that has no locale. This marker is the
 * distinction: `text` stays the English rendering, so any surface that ignores
 * the marker still prints a correct sentence, and a surface that honours it
 * runs `key` through `t()` with `params`.
 *
 * `key` is the English sentence itself — the repo's convention, see
 * `noHardcodedChinese.test.ts`. Params are already-formatted strings; the
 * worker does no number or date formatting it would have to localise.
 */
export interface HistoryNotice {
  key: string;
  params?: Record<string, string>;
}

/**
 * One digested history block. Ids are stable across re-reads (derived from
 * JSONL uuids) so repeated resume hydration is idempotent.
 */
export type HistoryBlock =
  | { type: 'text'; id: string; text: string; truncated?: boolean; notice?: HistoryNotice }
  | { type: 'thinking'; id: string; text: string; truncated?: boolean }
  | {
      type: 'tool_call';
      id: string;
      toolCallId: string;
      name: string;
      input?: unknown;
      truncated?: boolean;
    }
  | {
      type: 'tool_result';
      id: string;
      toolCallId: string;
      ok: boolean;
      output?: string;
      patch?: string;
      review?: SessionFileChange;
      error?: string;
      truncated?: boolean;
      /**
       * N5: the replay half of `ToolOutcomeDetails` (runtimeEvents.ts). The
       * runtime refused the call instead of acting on it — copied from the
       * result's own `details.refused`.
       */
      refused?: true;
      /**
       * N5: the call was never executed. Pi runs no tool call of an assistant
       * message that ended `aborted` or `error`, and writes no result for it;
       * the projection supplies this result so the row does not replay as
       * still running.
       */
      notStarted?: true;
    };

/**
 * P5-2-6 — one delegation, rebuilt from the session file.
 *
 * What a reopened session needs to put a delegation panel back under the `Task`
 * row that started it: which row it belongs to, what it was, how it ended, and
 * what it reported. Deliberately a SUMMARY — the delegate's own messages stay
 * in the session file and are read on demand. The live channel is capped at 40
 * rows per lane anyway, so replaying a full transcript here would be paying a
 * bootstrap cost for something the panel would immediately drop.
 *
 * `status` carries `interrupted`, which no live run ever produces: it is what a
 * hard exit leaves behind — a delegation that started and never settled. Saying
 * so is the point. The alternative, showing it as still running, is a reopened
 * session claiming work is in flight when the process that was doing it is gone.
 */
export interface SubagentHistorySummary {
  delegationId: string;
  /** The parent's `Task` tool-call id — the join key for the panel. */
  parentToolCallId: string;
  agentName: string;
  /** The short label the parent gave this delegation, when it gave one. */
  label?: string;
  status:
    | 'completed'
    | 'failed'
    | 'aborted'
    | 'stopped'
    | 'truncated'
    | 'timed_out'
    | 'interrupted'
    | 'running';
  startedAt: number;
  completedAt?: number;
  turns?: number;
  toolCalls?: number;
  totalTokens?: number;
  /** The delegate's report, clamped for transport. */
  report?: string;
  model?: string;
}

/**
 * Why a run ended when the USER ended it, rather than the model finishing.
 *
 * - `interjected`: Ctrl+Enter stopped the run at a turn boundary so the queued
 *   message could go next.
 * - `user_stop`: the run was aborted (the Stop button, "send now", or the
 *   session closing mid-run — all of them abort the same run signal).
 *
 * A run that ended on its own carries no cause at all.
 */
export type TurnStopCause = 'interjected' | 'user_stop';

/**
 * `customType` of the session entry that records a {@link TurnStopCause}.
 *
 * A plain pi `custom` entry (`{ type: 'custom', customType, data }`), which pi's
 * own context builder ignores and its TUI tree hides as bookkeeping. `data` is
 * `{ cause: TurnStopCause, runId: string }`. The history projection folds it
 * onto the run's last assistant message; the session tree skips it.
 */
export const RUN_STOP_CUSTOM_TYPE = 'aiclient.runStop';

/**
 * `customType` of the record a subagent loop guard leaves when it fires.
 *
 * Written by the runtime's agent loop when it cuts a reply that kept repeating
 * a subagent tool call, or wraps up a run whose replies kept calling the
 * subagent tools with nothing left to act on. `data` is
 * `{ rule, sessionId, runId, at, … }` plus what the rule saw (the repeated call
 * signature and counts, or the idle replies' calls). Bookkeeping like
 * {@link RUN_STOP_CUSTOM_TYPE}: never model context, never a message, never a
 * tree node — it is evidence for a person reading the file.
 */
export const LOOP_GUARD_CUSTOM_TYPE = 'aiclient.loopGuard';

/** Prefix of every history message id — the store's replace semantics key on it. */
export const HISTORY_MESSAGE_ID_PREFIX = 'h:' as const;

/** T33 hard bounds: worker projection and renderer display are deliberately separate. */
export const PI_SESSION_TREE_BACKEND_LIMIT = 4_000;
export const PI_SESSION_TREE_UI_LIMIT = 320;

/**
 * Active Pi branch checkpoint. `activeEntryId: null` means before the first
 * root entry. `fileTailEntryId` invalidates a stale checkpoint after a new
 * physical append has made the JSONL tail authoritative again.
 */
export interface PiLeafCheckpoint {
  activeEntryId: string | null;
  fileTailEntryId: string | null;
}

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  depth: number;
  entryType: string;
  role?: string;
  preview?: string;
  label?: string;
  timestamp?: number;
  childCount: number;
  /** Selected path contains at least one assistant message, so Pi materializes the fork file. */
  forkable: boolean;
  active: boolean;
  leaf: boolean;
}

export interface SessionTreeSnapshot {
  logicalSessionId: string;
  sessionFile: string;
  workspacePath: string;
  leaf: PiLeafCheckpoint;
  nodes: SessionTreeNode[];
  totalNodes: number;
  returnedNodes: number;
  truncated: boolean;
}

/**
 * 2026-08-10: what a rebuilt user turn had attached — METADATA ONLY.
 *
 * Field-for-field the live wire's `MessageAttachmentMeta` (runtimeEvents.ts)
 * and the renderer's `ChatMessageAttachment`, so a history-rebuilt chip and a
 * live chip are the same object shape and render through the same branch.
 *
 * Deliberately NO `data`: the digest never re-reads the attached bytes off
 * disk and never renders a real bitmap thumbnail. A cold restart therefore
 * recovers "an image called X was attached here" (icon + label), which is
 * strictly more than the nothing it used to recover. Real thumbnails are a
 * separate piece of work with its own IO/permission surface.
 */
export interface HistoryAttachment {
  kind: 'image' | 'text';
  mediaType: string;
  name?: string;
}

export interface HistoryMessage {
  /** Stable renderer id derived from the Pi session entry id. */
  id: `${typeof HISTORY_MESSAGE_ID_PREFIX}${string}`;
  /** Exact Pi JSONL entry id. Required on Pi history; legacy T34 adapters may omit it. */
  entryId?: string;
  role: 'user' | 'assistant' | 'system';
  /** Epoch ms from the Pi entry timestamp when parseable. */
  timestamp?: number;
  /**
   * The latest Pi entry this message stands for, when that is LATER than its
   * own `timestamp`: the message's own entry, every `toolResult` entry folded
   * into its blocks, and the {@link RUN_STOP_CUSTOM_TYPE} entry stamped onto it
   * — the maximum of the three. Absent when nothing later was folded in.
   *
   * An assistant entry is dated when the model finished WRITING it, i.e. before
   * its tool calls ran. A run that ends on a tool result (Ctrl+Enter stops at
   * the tool boundary) has no later assistant entry, so without this a
   * replayed 20-second turn measured as the write of the call that started
   * the 20 seconds (devbox 2026-09-24, N2: 「已工作 20 秒」 → 「1 秒」).
   * Optional-field addition; older readers ignore it.
   */
  settledAt?: number;
  /** Assistant messages: provider/model when reported by Pi. */
  model?: string;
  blocks: HistoryBlock[];
  /** Crash/abort left an assistant leaf without a complete visible response. */
  incomplete?: boolean;
  /** Pi stop reason retained for diagnostics and future rewind UI. */
  stopReason?: string;
  /**
   * Assistant messages only: set on the LAST assistant message of a run the
   * user ended (see {@link TurnStopCause}), off the run's
   * {@link RUN_STOP_CUSTOM_TYPE} entry. Optional-field addition; older readers
   * ignore it.
   */
  stopCause?: TurnStopCause;
  /**
   * 2026-08-10 optional-field widening (protocol version unchanged, same
   * discipline as `message.started.attachments`): user turns only, present
   * only when the turn actually attached something. Older payloads simply
   * lack the key and older readers ignore it — compatible both directions.
   *
   * A user message may now carry attachments and ZERO blocks: an image sent
   * with no prose used to digest to nothing at all, which lost the whole turn
   * rather than just its chip.
   */
  attachments?: HistoryAttachment[];
}

/**
 * S2 (d, C11): `history_unsupported` is the only widening this round — the
 * session's agent has no history reader in this build (flag off, or a reader
 * not written yet). Widening a union is safe here because the renderer maps
 * unknown codes to `'unknown'` rather than switching exhaustively.
 *
 * `jsonl_not_found` keeps its wire value but is no longer JSONL-specific: it
 * means "nothing on disk for this session", whichever store the agent uses.
 */
export type HistoryReadErrorCode =
  | 'jsonl_not_found'
  | 'encrypted_unreadable'
  | 'read_failed'
  | 'history_unsupported'
  | 'session_file_corrupt'
  | 'session_cwd_mismatch'
  /**
   * F2-c: the session names a working directory that is no longer on disk.
   *
   * Distinct from the app-managed temp workspace, which is recreated in place
   * (`TempWorkspaceService`): a folder the USER made and deleted must not be
   * silently recreated, so the session stays unopenable until the user acts.
   * The code exists to say which action is available instead of handing them
   * the raw spawn failure.
   */
  | 'workspace_missing';

export interface HistoryReadError {
  code: HistoryReadErrorCode;
  message: string;
}

/** Diagnostics: known control lines are NOT bad lines. */
export interface HistoryParseStats {
  totalLines: number;
  controlLines: number;
  badLines: number;
}

/** One chronological page selected backwards from the active Pi branch leaf. */
export interface SessionHistoryPage {
  messages: HistoryMessage[];
  /** Number of newer projected messages skipped from the branch leaf. */
  offset: number;
  /** Normalized page limit (1..500). */
  limit: number;
  /** Total projected messages on the active branch. */
  totalCount: number;
  /** True when an older page exists before this page. */
  hasMore: boolean;
}
