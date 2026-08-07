/**
 * Session history shapes for the `session.history` batch event and
 * `session.listHistory` command (C-06, CP4-finalized protocol).
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

export interface HistoryMessage {
  /** Stable id: `h:<first-jsonl-uuid>`. The `h:` prefix is contract. */
  id: string;
  role: 'user' | 'assistant';
  /** Epoch ms from the JSONL timestamp when parseable. */
  timestamp?: number;
  /** Assistant messages: message.model of the first merged line. */
  model?: string;
  blocks: HistoryBlock[];
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
  | 'history_unsupported';

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

/** Summary row for session.listHistory. */
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
