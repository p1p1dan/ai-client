/**
 * Session history shapes for Pi `session.history` hydration and isolated
 * T34 legacy migration-reader adapters.
 * See docs/plans/2026-07-24-c06-session-history-protocol-draft.md
 */

import type { AgentWireName } from './agentWire';

/**
 * One digested history block. Ids are stable across re-reads (derived from
 * JSONL uuids) so repeated resume hydration is idempotent.
 */
export type HistoryBlock =
  | { type: 'text'; id: string; text: string; truncated?: boolean }
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
      error?: string;
      truncated?: boolean;
    };

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
  /** Assistant messages: provider/model when reported by Pi. */
  model?: string;
  blocks: HistoryBlock[];
  /** Crash/abort left an assistant leaf without a complete visible response. */
  incomplete?: boolean;
  /** Pi stop reason retained for diagnostics and future rewind UI. */
  stopReason?: string;
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
  | 'session_cwd_mismatch';

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

/** Summary row retained only for T34 migration-reader compatibility. */
export interface HistorySessionSummary {
  /**
   * The agent's own resume handle, opaque to us: a Claude Code JSONL basename,
   * a Codex threadId, whatever the next reader uses. Only interpretable
   * together with `agent` — never dispatch on the shape of this string.
   */
  runtimeIdentity: string;
  workspacePath: string;
  /**
   * S2 (d): which agent this row belongs to, and therefore which reader can
   * resume it. Absent = Claude Code.
   */
  agent?: AgentWireName;
  /** From an `ai-title` control line when present (CLI sessions carry it). */
  title: string | null;
  /** First user message preview (system tags stripped, ≤80 chars) or `/command` label. */
  firstMessage: string | null;
  createdAt: number | null;
  lastMessageAt: number | null;
  /** From the first assistant line's message.model (system:init is absent in real data). */
  model: string | null;
}
