import { PI_AGENT } from '@shared/types/agentWire';
import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import {
  isSessionBusy,
  resumeDisplayTitle,
  shouldApplyResumeResult,
  shouldResumeSession,
} from '../resumeIntent';

const BUSY_STATUSES: SessionRuntimeStatus[] = [
  'starting',
  'running',
  'waiting_permission',
  'waiting_question',
  'stopping',
];

const RESUMABLE_STATUSES: SessionRuntimeStatus[] = ['idle', 'completed', 'failed', 'disconnected'];

function session(extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    projectId: 'p1',
    workspaceId: 'ws-1',
    title: 'Title',
    status: 'idle',
    updatedAt: 1000,
    ...extra,
  };
}

function workspace(extra: Partial<ChatWorkspace> = {}): ChatWorkspace {
  return {
    id: 'ws-1',
    projectId: 'p1',
    name: 'Main',
    kind: 'main',
    path: '/repo',
    ...extra,
  };
}

describe('shouldResumeSession (T-03)', () => {
  it('returns shouldResume=false and a reason when there is no session', () => {
    expect(shouldResumeSession(undefined, workspace())).toEqual({
      shouldResume: false,
      reason: 'no-session',
    });
  });

  it('returns shouldResume=false and a reason when there is no workspace', () => {
    expect(shouldResumeSession(session({ runtimeIdentity: 'rt' }), undefined)).toEqual({
      shouldResume: false,
      reason: 'no-workspace',
    });
  });

  it('refuses to resume against an empty workspace path (demo placeholder tree)', () => {
    expect(
      shouldResumeSession(session({ runtimeIdentity: 'rt' }), workspace({ path: '' }))
    ).toEqual({
      shouldResume: false,
      reason: 'no-workspace-path',
    });
  });

  it('refuses to resume when the live session has no runtimeIdentity and no persisted fallback', () => {
    const result = shouldResumeSession(session({ runtimeIdentity: undefined }), workspace());
    expect(result.shouldResume).toBe(false);
    expect(result.reason).toBe('no-runtime-identity');
  });

  it('resumes when a persisted runtime identity is supplied even if the live session lacks one', () => {
    const result = shouldResumeSession(session({ runtimeIdentity: undefined }), workspace(), {
      persistedRuntimeIdentity: 'persisted-rt',
    });
    expect(result.shouldResume).toBe(true);
    expect(result.args).toEqual({
      sessionId: 's1',
      runtimeIdentity: 'persisted-rt',
      workspacePath: '/repo',
    });
  });

  it('resumes an explicitly Pi-bound persisted identity', () => {
    const result = shouldResumeSession(
      session({ runtimeIdentity: '/sessions/pi.jsonl', agent: PI_AGENT }),
      workspace()
    );

    expect(result).toEqual({
      shouldResume: true,
      args: {
        sessionId: 's1',
        runtimeIdentity: '/sessions/pi.jsonl',
        workspacePath: '/repo',
      },
    });
  });

  it('resumes when the live session already has a runtimeIdentity and is idle', () => {
    const result = shouldResumeSession(session({ runtimeIdentity: 'rt' }), workspace(), {
      model: 'sonnet',
    });
    expect(result.shouldResume).toBe(true);
    expect(result.args?.model).toBe('sonnet');
  });

  it('skips when the session is busy (starting) by default', () => {
    const result = shouldResumeSession(
      session({ runtimeIdentity: 'rt', status: 'starting' }),
      workspace()
    );
    expect(result.shouldResume).toBe(false);
    expect(result.reason).toBe('busy:starting');
  });

  it('still resumes when busy when skipBusy is explicitly false (manual override)', () => {
    const result = shouldResumeSession(
      session({ runtimeIdentity: 'rt', status: 'running' }),
      workspace(),
      { skipBusy: false }
    );
    expect(result.shouldResume).toBe(true);
  });

  it('skips every busy status the shared predicate reports, with a matching reason', () => {
    // Pins shouldResumeSession to isSessionBusy: any UI control gated on the
    // predicate must never enable a resume this function would refuse.
    for (const status of BUSY_STATUSES) {
      const result = shouldResumeSession(session({ runtimeIdentity: 'rt', status }), workspace());
      expect(isSessionBusy(status)).toBe(true);
      expect(result.shouldResume).toBe(false);
      expect(result.reason).toBe(`busy:${status}`);
    }
  });

  /**
   * U13 (D04): a temporary chat has no workspace by design. Refusing it here
   * was what left a restarted one openable but empty — the history was on
   * disk, and nothing ever asked for it.
   */
  describe('unbound sessions (U13)', () => {
    const unbound = { workspacePath: '/tmp/unbound-sessions/abc' };

    it('resumes into the scratch directory recorded on the session', () => {
      const result = shouldResumeSession(
        session({ workspaceId: '', runtimeIdentity: 'rt', unbound }),
        undefined
      );
      expect(result.shouldResume).toBe(true);
      expect(result.args).toEqual({
        sessionId: 's1',
        runtimeIdentity: 'rt',
        workspacePath: unbound.workspacePath,
      });
    });

    it('prefers the scratch path over a workspace that happens to be passed', () => {
      const result = shouldResumeSession(
        session({ runtimeIdentity: 'rt', unbound }),
        workspace({ path: '/repo' })
      );
      expect(result.args?.workspacePath).toBe(unbound.workspacePath);
    });

    it('still refuses a session with no workspace and no scratch path', () => {
      expect(shouldResumeSession(session({ runtimeIdentity: 'rt' }), undefined).reason).toBe(
        'no-workspace'
      );
    });

    it('applies the ordinary busy and agent guards to unbound sessions too', () => {
      expect(
        shouldResumeSession(
          session({ workspaceId: '', runtimeIdentity: 'rt', unbound, status: 'running' }),
          undefined
        ).reason
      ).toBe('busy:running');
    });
  });
});

describe('shouldApplyResumeResult (F2, D29 adversarial-review)', () => {
  it('applies the resume result when the store is still on the resumed session', () => {
    expect(shouldApplyResumeResult('s1', 's1')).toBe(true);
  });

  it('skips the write when the user selected a different session mid-await', () => {
    expect(shouldApplyResumeResult('s2', 's1')).toBe(false);
  });

  it('skips the write when nothing is active anymore (session closed mid-await)', () => {
    expect(shouldApplyResumeResult(null, 's1')).toBe(false);
  });
});

describe('isSessionBusy (T-03)', () => {
  it('reports exactly the statuses where the Host refuses a resume', () => {
    for (const status of BUSY_STATUSES) {
      expect(isSessionBusy(status)).toBe(true);
    }
    for (const status of RESUMABLE_STATUSES) {
      expect(isSessionBusy(status)).toBe(false);
    }
  });
});

describe('resumeDisplayTitle (T-03)', () => {
  it('uses an explicit title when set and non-placeholder', () => {
    expect(resumeDisplayTitle(session({ title: 'My chat' }), { firstMessage: null })).toBe(
      'My chat'
    );
  });

  it('falls back to the firstMessage preview, truncated when longer than 60 chars', () => {
    const longFirst =
      'fix the login flow on mobile and add tests for it also please thanks alright'; // > 60 chars
    const out = resumeDisplayTitle(session({ title: 'New chat' }), { firstMessage: longFirst });
    expect(out.length).toBe(60);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('fix the login')).toBe(true);
  });

  it('falls back to the firstMessage preview unchanged when short enough', () => {
    expect(
      resumeDisplayTitle(session({ title: 'New chat' }), {
        firstMessage: 'fix the login flow on mobile and add tests',
      })
    ).toBe('fix the login flow on mobile and add tests');
  });

  it('defaults to Untitled session when nothing usable', () => {
    expect(resumeDisplayTitle(session({ title: 'Live Agent Host' }), { firstMessage: null })).toBe(
      'Untitled session'
    );
  });

  // Round-3 (point-check #10): now shares `isPlaceholderTitle` with the
  // first-message auto-title wiring, which also recognizes the
  // `sessionIndexMerge.ts` `fallbackSessionTitle` shape ("Session xxxxxx")
  // as a placeholder — previously this function's own inline check did not.
  it('treats the "Session xxxxxx" fallback shape as a placeholder too', () => {
    expect(
      resumeDisplayTitle(session({ title: 'Session ab12cd' }), {
        firstMessage: 'fix the login flow',
      })
    ).toBe('fix the login flow');
    expect(resumeDisplayTitle(session({ title: 'Session ab12cd' }), { firstMessage: null })).toBe(
      'Untitled session'
    );
  });
});
