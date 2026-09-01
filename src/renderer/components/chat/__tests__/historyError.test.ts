import type {
  RuntimeEvent,
  SessionHistoryEvent,
  SessionRuntimeStatus,
} from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { applyRuntimeEvent, type ChatSession, type ChatSessionsState } from '@/stores/chatSessions';
import {
  deriveHistoryNotice,
  deriveRetryControl,
  HISTORY_ERROR_DEAD_SESSION_HINT,
  HISTORY_ERROR_NON_FATAL_HINT,
  HISTORY_ERROR_UNSUPPORTED_HINT,
  HISTORY_RETRY_BUSY_HINT,
  HISTORY_RETRY_FAILED_HINT,
  type HistoryErrorCode,
  parseHistoryError,
  selectHistoryError,
} from '../historyError';
import { deriveMiddleColumnMode } from '../middleColumnLayout';
import { isSessionBusy } from '../sessionIndex/resumeIntent';

const ENCRYPTED_RAW =
  'encrypted_unreadable: Session file appears TSD-encrypted and unreadable by this Host process: /home/u/.claude/projects/p/rt.jsonl';

describe('parseHistoryError (T-03)', () => {
  it('[PHE-01] parses jsonl_not_found as a non-retryable error (D32: dead session, not a warning)', () => {
    const view = parseHistoryError(
      'jsonl_not_found: No session JSONL found for runtimeIdentity "rt-x" under /home/u/.claude/projects'
    );
    expect(view).not.toBeNull();
    expect(view?.code).toBe('jsonl_not_found');
    expect(view?.message).toBe(
      'No session JSONL found for runtimeIdentity "rt-x" under /home/u/.claude/projects'
    );
    // D32: a missing JSONL means resume fails on the very next send, so this
    // reads as an error, not the old "nothing on disk" warning.
    expect(view?.severity).toBe('error');
    // Re-reading a file that is not there yields the same result every time.
    expect(view?.retryable).toBe(false);
    expect(view?.title.length).toBeGreaterThan(0);
    expect(view?.guidance.length).toBeGreaterThan(0);
    expect(view?.continuationHint).toBe(HISTORY_ERROR_DEAD_SESSION_HINT);
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
      'history_unsupported',
      'unknown',
    ];
    const views = codes.map((code) => parseHistoryError(`${code}: x`));
    for (const view of views) {
      expect(view?.title.trim().length).toBeGreaterThan(0);
      expect(view?.guidance.trim().length).toBeGreaterThan(0);
    }
    // D32: jsonl_not_found is now the dead-session case (resume fails on the
    // next send), so it reads as an error, same urgency tier as encrypted.
    expect(views[0]?.severity).toBe('error');
    expect(views[1]?.severity).toBe('error');
    // history_unsupported is the true "nothing lost, just unreadable here"
    // benign case — it is the one that stays a warning.
    expect(views[3]?.severity).toBe('warning');
    // Guidance must never let "encrypted" be mistaken for "no history".
    expect(new Set(views.map((view) => view?.guidance)).size).toBe(codes.length);
  });

  /**
   * Five-code continuationHint table (D32). Each row is asserted on its own
   * exact string — not "the four non-jsonl codes share a string" — so a slice
   * that accidentally reused `HISTORY_ERROR_NON_FATAL_HINT` for
   * `jsonl_not_found` (the #30 bug this batch fixes) cannot hide behind a
   * merged assertion.
   */
  it('[PHE-13] jsonl_not_found gets the dead-session hint, verbatim', () => {
    const view = parseHistoryError('jsonl_not_found: x');
    expect(view?.code).toBe('jsonl_not_found');
    expect(view?.continuationHint).toBe(HISTORY_ERROR_DEAD_SESSION_HINT);
  });

  it('[PHE-14] encrypted_unreadable gets a hint that does not promise success', () => {
    const view = parseHistoryError('encrypted_unreadable: x');
    expect(view?.code).toBe('encrypted_unreadable');
    expect(view?.continuationHint).toBe('会话或仍可继续发送；若发送同样失败，请新建会话。');
  });

  it('[PHE-15] read_failed gets the shared non-fatal hint, verbatim', () => {
    const view = parseHistoryError('read_failed: x');
    expect(view?.code).toBe('read_failed');
    expect(view?.continuationHint).toBe(HISTORY_ERROR_NON_FATAL_HINT);
  });

  it('[PHE-16] history_unsupported gets its own hint, which never promises a send will work', () => {
    const view = parseHistoryError('history_unsupported: x');
    expect(view?.code).toBe('history_unsupported');
    expect(view?.continuationHint).toBe(HISTORY_ERROR_UNSUPPORTED_HINT);
    // P2 (S3 slice 5a): this code means the build never read anything for the
    // session's agent — and on the Codex path it never contacted the agent at
    // all, so nothing verified the session is still live. The shared non-fatal
    // hint says "可以继续发送消息", a promise this path cannot make.
    expect(view?.continuationHint).not.toBe(HISTORY_ERROR_NON_FATAL_HINT);
    expect(HISTORY_ERROR_UNSUPPORTED_HINT).toContain('新建会话');
  });

  it('[PHE-17] unknown gets the shared non-fatal hint, verbatim', () => {
    const view = parseHistoryError('unknown_future_code: x');
    expect(view?.code).toBe('unknown');
    expect(view?.continuationHint).toBe(HISTORY_ERROR_NON_FATAL_HINT);
  });

  it('[PHE-11] ships a non-fatal hint stating the session can continue', () => {
    expect(HISTORY_ERROR_NON_FATAL_HINT).toContain('继续');
  });

  it('[PHE-18] names no agent-specific file format in the not-found copy', () => {
    // F6 (S3 slice 5a): `jsonl_not_found` keeps its Claude-era wire spelling,
    // but it now means "nothing on disk for this session" whichever store the
    // agent uses — a Codex row has no JSONL for the user to go looking for.
    const view = parseHistoryError('jsonl_not_found: x');
    expect(view?.guidance).not.toContain('JSONL');
    expect(view?.title).not.toContain('JSONL');
    // Still says WHAT was not found, or the copy degrades to "something failed".
    expect(view?.guidance).toContain('历史记录');
  });

  it('[PHE-19] quotes no CLI-specific error string in the dead-session hint', () => {
    // It used to promise the next send would fail with "No conversation found"
    // — the Claude CLI's own wording, which no other agent ever prints.
    expect(HISTORY_ERROR_DEAD_SESSION_HINT).not.toContain('No conversation found');
    // Dropping the quote must not soften the verdict back into "keep sending":
    // the record is gone, so resume has nothing to hand the agent (#30 / D32).
    expect(HISTORY_ERROR_DEAD_SESSION_HINT).toContain('新建会话');
    expect(HISTORY_ERROR_DEAD_SESSION_HINT).not.toBe(HISTORY_ERROR_NON_FATAL_HINT);
  });

  it('[PHE-12] never claims the timeline below is empty', () => {
    // The notice survives new messages (DHN-05), so guidance that asserts
    // "nothing is shown below" contradicts the screen as soon as the user
    // sends a prompt. Guidance describes the read, not the current view.
    const codes: HistoryErrorCode[] = [
      'jsonl_not_found',
      'encrypted_unreadable',
      'read_failed',
      'history_unsupported',
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
      pendingPermissions: [],
      pendingQuestion: null,
      hostBoundSessionIds: [],
      runtimeReady: false,
      lastError: null,
      historyErrors: {},
      selectSession: () => {},
      sendMessage: async () => {},
      stopActiveSession: async () => {},
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

  /**
   * G3 (S3 slice 5a). The Codex degradation, from the wire event the Host
   * really emits to what the timeline shows. Driven through the reducer for the
   * same reason as CTR-01/02: hand-written `historyErrors` literals would stay
   * green if the encoding drifted, while every real Codex resume degraded to
   * `unknown` — i.e. an ERROR banner with a Retry button, which is the opposite
   * of what this code means.
   */
  describe('history_unsupported (S3 slice 5a: the Codex degradation)', () => {
    // Shortened stand-in for the Host's own wording. The exact bytes are pinned
    // Host-side (`codexRuntime.test.ts`, CODEX_HISTORY_UNSUPPORTED_MESSAGE);
    // what this file owns is that the CODE survives the store's encoding.
    const HOST_MESSAGE = 'This build has no Codex history reader.';

    function codexRow(): ChatSession {
      return {
        id: SESSION_ID,
        projectId: 'project-demo',
        workspaceId: 'ws-main',
        title: 'Codex session',
        status: 'idle',
        updatedAt: 42,
        agent: 'codex',
        runtimeIdentity: 'thr-cold-0007',
      };
    }

    /** Field for field what `CodexRuntime.resumeSession` emits with no reader. */
    function codexHistoryEvent(): RuntimeEvent {
      return {
        type: 'session.history',
        seq: 2,
        sessionId: SESSION_ID,
        requestId: 'req-resume',
        timestamp: 1234,
        payload: {
          runtimeIdentity: 'thr-cold-0007',
          workspacePath: '/work/repo',
          agent: 'codex',
          messages: [],
          truncated: false,
          omittedCount: 0,
          error: { code: 'history_unsupported', message: HOST_MESSAGE },
        },
      };
    }

    function ingest(): { patch: Partial<ChatSessionsState>; stored: string | undefined } {
      const state = {
        ...baseState(),
        sessions: [codexRow()],
        activeSessionId: SESSION_ID,
        hostBoundSessionIds: [SESSION_ID],
      } as ChatSessionsState;
      const patch = applyRuntimeEvent(state, codexHistoryEvent());
      return { patch, stored: selectHistoryError(patch.historyErrors ?? {}, SESSION_ID) };
    }

    it('[G3-01] survives the store encoding as history_unsupported, message intact', () => {
      const { stored } = ingest();
      expect(stored).toBe(`history_unsupported: ${HOST_MESSAGE}`);
      const view = parseHistoryError(stored);
      expect(view?.code).toBe('history_unsupported');
      expect(view?.message).toBe(HOST_MESSAGE);
    });

    it('[G3-02] shows a warning notice — a notice, but not a failure', () => {
      const { stored } = ingest();
      const notice = deriveHistoryNotice({ sessionId: SESSION_ID, messageCount: 0, error: stored });
      // A notice IS required: an empty timeline with nothing on it reads as
      // "this session had nothing to say", which is precisely the misreading
      // the explicit error exists to prevent.
      expect(notice.kind).toBe('error');
      // …but the tone is a warning: nothing is broken and nothing was lost.
      expect(notice.error?.severity).toBe('warning');
      expect(notice.error?.guidance).toBe(
        '当前版本还读不到该 agent 的历史记录，更早的消息没有载入；记录仍在磁盘上。'
      );
      expect(notice.error?.continuationHint).toBe(HISTORY_ERROR_UNSUPPORTED_HINT);
      // The honest half of P2, pinned on the copy the user actually reads.
      expect(notice.error?.continuationHint).not.toBe(HISTORY_ERROR_NON_FATAL_HINT);
    });

    it('[G3-03] renders no Retry button at all — not a disabled one (m14)', () => {
      const { stored } = ingest();
      const view = parseHistoryError(stored);
      const control = deriveRetryControl({
        retryable: view?.retryable ?? true,
        status: 'idle',
        retrying: false,
        failed: false,
      });
      // Re-reading cannot conjure a reader this build does not have, so a
      // greyed-out button would invite a click that can never do anything.
      expect(control.visible).toBe(false);
      expect(control.hint).toBeNull();
    });

    it('[G3-04] leaves every input of the composer send gate untouched', () => {
      const { patch } = ingest();
      // The reducer's WHOLE patch. `hostBoundSessionIds` and `activeSessionId`
      // are absent, i.e. unchanged: a history error must not un-bind the
      // session, which is what would actually disable the composer.
      expect(Object.keys(patch).sort()).toEqual(['historyErrors', 'messages', 'sessions']);
      const row = patch.sessions?.find((session) => session.id === SESSION_ID);
      expect(row?.status).toBe('idle');

      // ChatComposer's gate restated from its own inputs (`ChatComposer.tsx`:
      // `activeSessionId && cwd && !disabled && !canStop`, where `disabled` is
      // ChatWorkspace's `!activeSessionId` and `canStop` follows the session
      // status). A history error appears in none of them.
      const canSend = Boolean(SESSION_ID) && !isSessionBusy(row?.status ?? 'idle');
      expect(canSend).toBe(true);
    });

    it('[G3-05] docks the composer instead of showing the centered empty state', () => {
      const { stored } = ingest();
      // The session replayed nothing, so without the error flag the middle
      // column would fall back to "no session yet" and hide the notice under a
      // welcome screen.
      expect(
        deriveMiddleColumnMode({
          sessionId: SESSION_ID,
          messageCount: 0,
          sendAttempted: false,
          hostBound: true,
          hasRuntimeIdentity: true,
          hasHistoryError: Boolean(stored),
          status: 'idle',
        })
      ).toBe('session');
    });
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
