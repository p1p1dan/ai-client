import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import type { HistoryReadErrorCode } from '@shared/types/sessionHistory';
import { isSessionBusy } from './sessionIndex/resumeIntent';

/**
 * View model for the non-fatal per-session history read error (C-06 / T-03).
 *
 * The store keeps `historyErrors[sessionId]` as a flat `${code}: ${message}`
 * string (chatSessions.ts — red-line file, not ours to change). Parsing, copy
 * selection and the "error vs genuinely empty" decision live here as pure
 * functions: the repo's vitest environment is `node` and only collects `.ts`,
 * so anything left inside a `.tsx` cannot be asserted.
 */

/** Contract codes plus a forward-compatible fallback. */
export type HistoryErrorCode = HistoryReadErrorCode | 'unknown';

export interface HistoryErrorView {
  code: HistoryErrorCode;
  /** Alert variant. Warning = nothing on disk; error = history exists but is unreadable. */
  severity: 'warning' | 'error';
  /** Short English label, matching the timeline's other chrome. */
  title: string;
  /**
   * Chinese explanation — must keep "read failed" distinguishable from "empty".
   * The notice outlives the failed read (it survives new messages), so guidance
   * describes the read attempt, never what the timeline currently shows.
   */
  guidance: string;
  /** Raw Host message (paths / errno). Empty when the Host sent none. */
  message: string;
  /** Only transient IO failures are worth re-reading. */
  retryable: boolean;
}

/** Shown under every variant: a history read failure never kills the session. */
export const HISTORY_ERROR_NON_FATAL_HINT = '会话未中断，可以继续发送消息。';

type HistoryErrorCopy = Omit<HistoryErrorView, 'code' | 'message'>;

const CODE_COPY: Record<HistoryErrorCode, HistoryErrorCopy> = {
  jsonl_not_found: {
    severity: 'warning',
    title: 'History file not found',
    guidance: '恢复该会话时未找到它的历史文件（JSONL），历史消息没有载入，以下只有本次的新消息。',
    retryable: false,
  },
  encrypted_unreadable: {
    severity: 'error',
    title: 'History is encrypted — unreadable here',
    guidance:
      '历史文件已加密，本进程读不到明文。这不代表该会话没有历史——记录仍在磁盘上，只是无法在此显示。',
    retryable: false,
  },
  read_failed: {
    severity: 'error',
    title: 'Failed to read history',
    guidance: '读取或解析历史文件时出错，下面的历史可能缺失或不完整。',
    retryable: true,
  },
  unknown: {
    severity: 'error',
    title: 'Failed to read history',
    guidance: '历史读取返回了未知错误，下面的历史可能缺失或不完整。',
    retryable: true,
  },
};

function toCode(value: string): HistoryErrorCode {
  return value === 'jsonl_not_found' || value === 'encrypted_unreadable' || value === 'read_failed'
    ? value
    : 'unknown';
}

/** Parse `historyErrors[sessionId]`. Returns null when the session has no error. */
export function parseHistoryError(raw: string | null | undefined): HistoryErrorView | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const separatorIndex = trimmed.indexOf(':');
  const code = toCode(separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex).trim());
  // An unrecognised head is payload, not a prefix — keep the whole string so no
  // information is lost. A bare code (no separator) has no message at all;
  // slicing regardless would eat its first character.
  const message =
    code === 'unknown'
      ? trimmed
      : separatorIndex === -1
        ? ''
        : trimmed.slice(separatorIndex + 1).trim();

  return { code, message, ...CODE_COPY[code] };
}

export type TimelineHistoryNotice =
  | { kind: 'none'; error: null }
  | { kind: 'empty'; error: null }
  | { kind: 'error'; error: HistoryErrorView };

export interface TimelineHistoryNoticeInput {
  sessionId: string | null;
  messageCount: number;
  /** Raw `historyErrors[sessionId]`, as returned by selectHistoryError. */
  error: string | undefined;
}

/**
 * Read one session's entry out of the store record.
 *
 * Kept separate so the timeline can subscribe to a plain string instead of the
 * whole record: the store rebuilds `historyErrors` on every `session.history`
 * ingest, so subscribing to the record would re-render this timeline whenever
 * any background session replays its history.
 */
export function selectHistoryError(
  historyErrors: Record<string, string>,
  sessionId: string | null
): string | undefined {
  return sessionId ? historyErrors[sessionId] : undefined;
}

/**
 * Decide what the timeline says about missing history.
 *
 * This is the bug surface T-03 fixes: an empty timeline previously read as
 * "no messages yet" whether the history was absent or unreadable. `error`
 * outranks `empty` and survives new messages — once history failed to load,
 * that stays true for the session.
 */
export function deriveHistoryNotice(input: TimelineHistoryNoticeInput): TimelineHistoryNotice {
  const { sessionId, messageCount } = input;
  if (!sessionId) return { kind: 'none', error: null };

  const error = parseHistoryError(input.error);
  if (error) return { kind: 'error', error };

  return messageCount === 0 ? { kind: 'empty', error: null } : { kind: 'none', error: null };
}

/** Shown when the session is mid-turn, explaining the disabled Retry button. */
export const HISTORY_RETRY_BUSY_HINT = '会话正在进行中，本轮结束后可重试读取历史。';
/** Shown when a retry resolved without re-reading history (rejected or IPC error). */
export const HISTORY_RETRY_FAILED_HINT = '重试未生效，历史仍未读到，可稍后再试一次。';

export interface HistoryRetryControl {
  /** Only transient failures offer a retry at all. */
  visible: boolean;
  disabled: boolean;
  hint: string | null;
  /** Lets the view pick a tone without owning copy decisions. */
  hintKind: 'none' | 'busy' | 'failed';
}

export interface HistoryRetryControlInput {
  retryable: boolean;
  status: SessionRuntimeStatus;
  /** A retry request is in flight. */
  retrying: boolean;
  /** The last retry resolved without re-reading history. */
  failed: boolean;
}

/**
 * Retry button state for the history error notice.
 *
 * Retry is backed by resume, which the Host rejects while a turn is running —
 * so a mid-turn button would be a silent no-op. Disable it instead and say why;
 * a resolved-but-failed retry must also leave a visible trace, otherwise the
 * user cannot tell "refused" from "retried and failed again".
 */
export function deriveRetryControl(input: HistoryRetryControlInput): HistoryRetryControl {
  if (!input.retryable) return { visible: false, disabled: true, hint: null, hintKind: 'none' };

  const busy = isSessionBusy(input.status);
  if (input.failed) {
    return {
      visible: true,
      disabled: input.retrying || busy,
      hint: HISTORY_RETRY_FAILED_HINT,
      hintKind: 'failed',
    };
  }
  return {
    visible: true,
    disabled: input.retrying || busy,
    hint: busy ? HISTORY_RETRY_BUSY_HINT : null,
    hintKind: busy ? 'busy' : 'none',
  };
}
