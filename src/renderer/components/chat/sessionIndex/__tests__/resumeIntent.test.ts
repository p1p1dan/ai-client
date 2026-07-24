import { describe, expect, it } from 'vitest';
import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { resumeDisplayTitle, shouldResumeSession } from '../resumeIntent';

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
});
