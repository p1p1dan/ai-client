import type {
  RuntimeEvent,
  SessionHistoryEvent,
  SessionRuntimeStatus,
} from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { applyRuntimeEvent, type ChatSessionsState } from '@/stores/chatSessions';
import {
  deriveHistoryNotice,
  deriveRetryControl,
  HISTORY_ERROR_NON_FATAL_HINT,
  HISTORY_RETRY_BUSY_HINT,
  HISTORY_RETRY_FAILED_HINT,
  type HistoryErrorCode,
  parseHistoryError,
  selectHistoryError,
} from '../historyError';

const ENCRYPTED_RAW =
  'encrypted_unreadable: Session file appears TSD-encrypted and unreadable by this Host process: /home/u/.claude/projects/p/rt.jsonl';

describe('parseHistoryError (T-03)', () => {
  it('[PHE-01] parses jsonl_not_found as a non-retryable warning', () => {
    const view = parseHistoryError(
      'jsonl_not_found: No session JSONL found for runtimeIdentity "rt-x" under /home/u/.claude/projects'
    );
    expect(view).not.toBeNull();
    expect(view?.code).toBe('jsonl_not_found');
    expect(view?.message).toBe(
      'No session JSONL found for runtimeIdentity "rt-x" under /home/u/.claude/projects'
    );
    expect(view?.severity).toBe('warning');
    // Re-reading a file that is not there yields the same result every time.
    expect(view?.retryable).toBe(false);
    expect(view?.title.length).toBeGreaterThan(0);
    expect(view?.guidance.length).toBeGreaterThan(0);
  });

  it('[PHE-02] parses encrypted_unreadable and keeps the trailing path intact', () => {
    const view = parseHistoryError(ENCRYPTED_RAW);
    expect(view?.code).toBe('encrypted_unreadable');
    expect(view?.severity).toBe('error');
    expect(view?.retryable).toBe(false);
    expect(view?.message).toBe(
      'Session file appears TSD-encrypted and unreadable by this Host process: /home/u/.claude/projects/p/rt.jsonl'
    );
  });

  it('[PHE-03] parses read_failed as a retryable error', () => {
    const view = parseHistoryError('read_failed: EACCES permission denied');
    expect(view?.code).toBe('read_failed');
    expect(view?.severity).toBe('error');
    expect(view?.message).toBe('EACCES permission denied');
    // Transient IO failure — the only case where re-reading can change anything.
    expect(view?.retryable).toBe(true);
  });

  it('[PHE-04] degrades an unrecognised code to unknown and keeps the whole string', () => {
    const view = parseHistoryError('weird_future_code: boom');
    expect(view?.code).toBe('unknown');
    expect(view?.severity).toBe('error');
    expect(view?.retryable).toBe(true);
    // The head is not a contract code, so it is payload, not a prefix to strip.
    expect(view?.message).toBe('weird_future_code: boom');
  });

  it('[PHE-04b] degrades a separator-less unknown string without throwing', () => {
    const view = parseHistoryError('totally malformed');
    expect(view?.code).toBe('unknown');
    expect(view?.message).toBe('totally malformed');
  });

  it('[PHE-05] splits on the first colon only', () => {
    const view = parseHistoryError(
      "read_failed: ENOENT: no such file or directory, open '/home/u/.claude/projects/a:b/rt.jsonl'"
    );
    expect(view?.code).toBe('read_failed');
    expect(view?.message).toBe(
      "ENOENT: no such file or directory, open '/home/u/.claude/projects/a:b/rt.jsonl'"
    );
  });

  it('[PHE-06] accepts a bare code and yields an empty message', () => {
    const view = parseHistoryError('jsonl_not_found');
    expect(view).not.toBeNull();
    expect(view?.code).toBe('jsonl_not_found');
    // Must not slice the code itself when there is no separator.
    expect(view?.message).toBe('');
  });

  it('[PHE-07] trims an empty message tail to an empty string', () => {
    const view = parseHistoryError('read_failed: ');
    expect(view?.code).toBe('read_failed');
    expect(view?.message).toBe('');
  });

  it('[PHE-08] tolerates surrounding whitespace', () => {
    const view = parseHistoryError('  jsonl_not_found:   no file  ');
    expect(view?.code).toBe('jsonl_not_found');
    expect(view?.message).toBe('no file');
  });

  it('[PHE-09] returns null for null / undefined / empty / blank input', () => {
    expect(parseHistoryError(null)).toBeNull();
    expect(parseHistoryError(undefined)).toBeNull();
    expect(parseHistoryError('')).toBeNull();
    expect(parseHistoryError('   ')).toBeNull();
  });

  it('[PHE-10] gives every code a distinct, non-empty title and guidance', () => {
    const codes: HistoryErrorCode[] = [
      'jsonl_not_found',
      'encrypted_unreadable',
      'read_failed',
      'unknown',
    ];
    const views = codes.map((code) => parseHistoryError(`${code}: x`));
    for (const view of views) {
      expect(view?.title.trim().length).toBeGreaterThan(0);
      expect(view?.guidance.trim().length).toBeGreaterThan(0);
    }
    // jsonl_not_found is the benign, high-frequency case: it must read as a
    // warning so the encrypted case keeps its urgency.
    expect(views[0]?.severity).toBe('warning');
    expect(views[1]?.severity).toBe('error');
    // Guidance must never let "encrypted" be mistaken for "no history".
    expect(new Set(views.map((view) => view?.guidance)).size).toBe(codes.length);
  });

  it('[PHE-11] ships a non-fatal hint stating the session can continue', () => {
    expect(HISTORY_ERROR_NON_FATAL_HINT).toContain('继续');
  });

  it('[PHE-12] never claims the timeline below is empty', () => {
    // The notice survives new messages (DHN-05), so guidance that asserts
    // "nothing is shown below" contradicts the screen as soon as the user
    // sends a prompt. Guidance describes the read, not the current view.
    const codes: HistoryErrorCode[] = [
      'jsonl_not_found',
      'encrypted_unreadable',
      'read_failed',
      'unknown',
    ];
    for (const code of codes) {
      const guidance = parseHistoryError(`${code}: x`)?.guidance ?? '';
      expect(guidance).not.toContain('下面没有');
      expect(guidance).not.toContain('没有历史消息可显示');
    }
  });
});

describe('selectHistoryError (T-03)', () => {
  it('[SHE-01] returns this session entry only', () => {
    const historyErrors = { s1: 'read_failed: boom', s2: 'jsonl_not_found: gone' };
    expect(selectHistoryError(historyErrors, 's1')).toBe('read_failed: boom');
  });

  it('[SHE-02] never leaks another session error into this timeline', () => {
    expect(selectHistoryError({ 'session-other': 'read_failed: boom' }, 's1')).toBeUndefined();
  });

  it('[SHE-03] returns undefined when no session is selected', () => {
    expect(selectHistoryError({ s1: 'read_failed: boom' }, null)).toBeUndefined();
  });

  it('[SHE-04] returns a stable value across reads, so subscribers do not re-render', () => {
    const historyErrors = { s1: 'read_failed: boom' };
    const first = selectHistoryError(historyErrors, 's1');
    const second = selectHistoryError(historyErrors, 's1');
    expect(Object.is(first, second)).toBe(true);
    // A background session's ingest rebuilds the record but not this entry.
    const rebuilt = { ...historyErrors, s2: 'jsonl_not_found: gone' };
    expect(Object.is(selectHistoryError(rebuilt, 's1'), first)).toBe(true);
  });
});

describe('deriveHistoryNotice (T-03)', () => {
  it('[DHN-01] reports an error notice for an empty timeline with a history error', () => {
    const notice = deriveHistoryNotice({
      sessionId: 's1',
      messageCount: 0,
      error: 'jsonl_not_found: no file',
    });
    expect(notice.kind).toBe('error');
    expect(notice.error?.code).toBe('jsonl_not_found');
  });

  it('[DHN-02] reports the empty notice for a genuinely empty session', () => {
    const notice = deriveHistoryNotice({
      sessionId: 's1',
      messageCount: 0,
      error: undefined,
    });
    expect(notice).toEqual({ kind: 'empty', error: null });
    // The two states must be machine-distinguishable — that is the whole bug.
    expect(notice.kind).not.toBe(
      deriveHistoryNotice({
        sessionId: 's1',
        messageCount: 0,
        error: 'jsonl_not_found: no file',
      }).kind
    );
  });

  it('[DHN-03] renders nothing when no session is selected', () => {
    expect(
      deriveHistoryNotice({
        sessionId: null,
        messageCount: 0,
        error: 'read_failed: boom',
      })
    ).toEqual({ kind: 'none', error: null });
  });

  it('[DHN-04] never leaks another session error into this timeline', () => {
    // Pairs with SHE-02: the lookup is the guard, this is the consumer side.
    const historyErrors = {
      'session-other': 'read_failed: boom',
      'session-third': 'encrypted_unreadable: x',
    };
    expect(
      deriveHistoryNotice({
        sessionId: 's1',
        messageCount: 0,
        error: selectHistoryError(historyErrors, 's1'),
      })
    ).toEqual({ kind: 'empty', error: null });
  });

  it('[DHN-05] keeps the error notice after new messages arrive', () => {
    const notice = deriveHistoryNotice({
      sessionId: 's1',
      messageCount: 3,
      error: 'jsonl_not_found: no file',
    });
    expect(notice.kind).toBe('error');
  });

  it('[DHN-06] adds no notice to a healthy session with messages', () => {
    expect(deriveHistoryNotice({ sessionId: 's1', messageCount: 3, error: undefined })).toEqual({
      kind: 'none',
      error: null,
    });
  });

  it('[DHN-07] never presents encrypted history as an empty session', () => {
    const notice = deriveHistoryNotice({
      sessionId: 's1',
      messageCount: 0,
      error: ENCRYPTED_RAW,
    });
    expect(notice.kind).toBe('error');
    expect(notice.kind).not.toBe('empty');
    expect(notice.error?.code).toBe('encrypted_unreadable');
    expect(notice.error?.retryable).toBe(false);
  });

  it('[DHN-08] treats a blank stored value as no error', () => {
    expect(deriveHistoryNotice({ sessionId: 's1', messageCount: 0, error: '' })).toEqual({
      kind: 'empty',
      error: null,
    });
  });

  it('[DHN-09] is pure: results are repeatable', () => {
    const input = { sessionId: 's1', messageCount: 0, error: 'read_failed: boom' };
    expect(deriveHistoryNotice(input)).toEqual(deriveHistoryNotice(input));
  });
});

describe('deriveRetryControl (T-03)', () => {
  const BUSY: SessionRuntimeStatus[] = [
    'starting',
    'running',
    'waiting_permission',
    'waiting_question',
    'stopping',
  ];
  const IDLE: SessionRuntimeStatus[] = ['idle', 'completed', 'failed', 'disconnected'];

  it('[DRC-01] hides the button for non-retryable codes', () => {
    const control = deriveRetryControl({
      retryable: false,
      status: 'idle',
      retrying: false,
      failed: false,
    });
    expect(control.visible).toBe(false);
    expect(control.hint).toBeNull();
  });

  it('[DRC-02] offers a live button on an idle-ish session', () => {
    for (const status of IDLE) {
      const control = deriveRetryControl({
        retryable: true,
        status,
        retrying: false,
        failed: false,
      });
      expect(control).toEqual({ visible: true, disabled: false, hint: null, hintKind: 'none' });
    }
  });

  it('[DRC-03] disables and explains the button while the session is busy', () => {
    // Resume is refused mid-turn (resumeIntent skipBusy), so an enabled button
    // would be a guaranteed no-op.
    for (const status of BUSY) {
      const control = deriveRetryControl({
        retryable: true,
        status,
        retrying: false,
        failed: false,
      });
      expect(control.visible).toBe(true);
      expect(control.disabled).toBe(true);
      expect(control.hintKind).toBe('busy');
      expect(control.hint).toBe(HISTORY_RETRY_BUSY_HINT);
    }
  });

  it('[DRC-04] disables the button while a retry is in flight', () => {
    const control = deriveRetryControl({
      retryable: true,
      status: 'idle',
      retrying: true,
      failed: false,
    });
    expect(control.disabled).toBe(true);
    expect(control.hint).toBeNull();
  });

  it('[DRC-05] surfaces a failed retry instead of silently resetting', () => {
    const control = deriveRetryControl({
      retryable: true,
      status: 'idle',
      retrying: false,
      failed: true,
    });
    expect(control.visible).toBe(true);
    // Still clickable — the failure may be transient.
    expect(control.disabled).toBe(false);
    expect(control.hintKind).toBe('failed');
    expect(control.hint).toBe(HISTORY_RETRY_FAILED_HINT);
  });

  it('[DRC-06] keeps the failure hint when the session went busy afterwards', () => {
    const control = deriveRetryControl({
      retryable: true,
      status: 'running',
      retrying: false,
      failed: true,
    });
    expect(control.disabled).toBe(true);
    expect(control.hintKind).toBe('failed');
  });

  it('[DRC-07] both hints are distinct and non-empty', () => {
    expect(HISTORY_RETRY_BUSY_HINT.trim().length).toBeGreaterThan(0);
    expect(HISTORY_RETRY_FAILED_HINT.trim().length).toBeGreaterThan(0);
    expect(HISTORY_RETRY_BUSY_HINT).not.toBe(HISTORY_RETRY_FAILED_HINT);
  });
});

/**
 * Contract pin: the producer of `historyErrors[sessionId]` is the store reducer
 * (a red-line file this track does not own). Parsing hand-written literals would
 * stay green if that encoding drifted, while every real error silently degraded
 * to `unknown`. Drive the reducer instead.
 */
describe('historyErrors encoding contract (store → parseHistoryError)', () => {
  const SESSION_ID = 'session-1';

  function baseState(): ChatSessionsState {
    return {
      projects: [],
      workspaces: [],
      sessions: [],
      messages: {},
      activeSessionId: null,
      recentSessionIds: [],
      pendingPermission: null,
      pendingQuestion: null,
      hostBoundSessionIds: [],
      runtimeReady: false,
      lastError: null,
      historyErrors: {},
      selectSession: () => {},
      sendMessage: async () => {},
      stopActiveSession: async () => {},
      respondPermission: async () => false,
      respondQuestion: async () => false,
      initRuntime: () => () => {},
    };
  }

  function historyEvent(error?: SessionHistoryEvent['payload']['error']): RuntimeEvent {
    return {
      type: 'session.history',
      seq: 1,
      sessionId: SESSION_ID,
      requestId: 'req-1',
      timestamp: 1234,
      payload: {
        runtimeIdentity: 'rt-1',
        workspacePath: '/workspace',
        messages: [],
        truncated: false,
        omittedCount: 0,
        error,
      },
    };
  }

  it('[CTR-01] parses what the reducer actually stores for encrypted_unreadable', () => {
    const message = 'Session file appears TSD-encrypted: /home/u/.claude/projects/p/rt.jsonl';
    const patch = applyRuntimeEvent(
      baseState(),
      historyEvent({ code: 'encrypted_unreadable', message })
    );
    const view = parseHistoryError(patch.historyErrors?.[SESSION_ID]);
    expect(view?.code).toBe('encrypted_unreadable');
    expect(view?.message).toBe(message);
    // The whole point: encrypted history must never read as "no history".
    expect(view?.severity).toBe('error');
  });

  it('[CTR-02] parses what the reducer stores for every contract code', () => {
    const codes = ['jsonl_not_found', 'encrypted_unreadable', 'read_failed'] as const;
    for (const code of codes) {
      const patch = applyRuntimeEvent(baseState(), historyEvent({ code, message: 'boom' }));
      const view = parseHistoryError(patch.historyErrors?.[SESSION_ID]);
      expect(view?.code).toBe(code);
      expect(view?.message).toBe('boom');
    }
  });

  it('[CTR-03] a clean re-read clears the entry, so the notice unmounts', () => {
    const failed = applyRuntimeEvent(
      baseState(),
      historyEvent({ code: 'read_failed', message: 'EACCES' })
    );
    const state = { ...baseState(), historyErrors: failed.historyErrors ?? {} };
    const healed = applyRuntimeEvent(state, historyEvent());
    expect(selectHistoryError(healed.historyErrors ?? {}, SESSION_ID)).toBeUndefined();
    expect(
      deriveHistoryNotice({
        sessionId: SESSION_ID,
        messageCount: 0,
        error: selectHistoryError(healed.historyErrors ?? {}, SESSION_ID),
      }).kind
    ).toBe('empty');
  });
});
