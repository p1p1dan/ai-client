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
      model: undefined,
      // S2 slice 1: the resume handle is opaque and only interpretable
      // together with the agent that issued it, so both travel as one.
      agent: 'claude-code',
    });
  });

  it('G13 — hands a codex row its own agent and threadId, not the Claude default', () => {
    // S3 slice 5b: `runtimeIdentity` is opaque and means nothing without the
    // agent beside it — a Codex threadId resumed as `claude-code` reaches the
    // Claude runtime, which looks for a JSONL file named after a thread id and
    // reports an empty history. Both fields therefore travel as one.
    const threadId = '01a003a5-307f-77d1-b7a4-a5379a560067';
    const result = shouldResumeSession(
      session({ runtimeIdentity: threadId, agent: 'codex' }),
      workspace()
    );

    expect(result.shouldResume).toBe(true);
    expect(result.args).toEqual({
      sessionId: 's1',
      runtimeIdentity: threadId,
      workspacePath: '/repo',
      model: undefined,
      agent: 'codex',
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
