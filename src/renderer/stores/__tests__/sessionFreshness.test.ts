import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatSession } from '../chatSessions';
import { isFreshEmptySession } from '../sessionFreshness';

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    workspaceId: 'ws-1',
    title: 'New chat',
    status: 'idle',
    updatedAt: 0,
    ...overrides,
  };
}

interface FreshnessState {
  sessions: ChatSession[];
  messages: Record<string, ChatMessage[]>;
  hostBoundSessionIds: string[];
}

function makeState(overrides: Partial<FreshnessState> = {}): FreshnessState {
  return {
    sessions: [makeSession()],
    messages: {},
    hostBoundSessionIds: [],
    ...overrides,
  };
}

describe('isFreshEmptySession', () => {
  it('is true for a brand-new session: no messages, never host-bound, idle, placeholder title', () => {
    expect(isFreshEmptySession(makeState(), 'session-1')).toBe(true);
  });

  it('is false for a null/undefined sessionId', () => {
    expect(isFreshEmptySession(makeState(), null)).toBe(false);
    expect(isFreshEmptySession(makeState(), undefined)).toBe(false);
  });

  it('is false for an empty-string sessionId', () => {
    expect(isFreshEmptySession(makeState(), '')).toBe(false);
  });

  it('is false when no session in `sessions` matches the id', () => {
    expect(isFreshEmptySession(makeState({ sessions: [] }), 'session-1')).toBe(false);
  });

  it('is false once the message bucket has at least one entry', () => {
    const state = makeState({
      messages: { 'session-1': [{ id: 'm1', sessionId: 'session-1', role: 'user', blocks: [] }] },
    });
    expect(isFreshEmptySession(state, 'session-1')).toBe(false);
  });

  it('treats a missing message bucket the same as an empty one (still fresh)', () => {
    // No `messages['session-1']` key at all — createChatSessionOnWorkspace
    // never allocates one, so this is the normal shape for a brand-new session.
    const state = makeState({ messages: {} });
    expect(isFreshEmptySession(state, 'session-1')).toBe(true);
  });

  it('is false once the session is registered in hostBoundSessionIds', () => {
    const state = makeState({ hostBoundSessionIds: ['session-1'] });
    expect(isFreshEmptySession(state, 'session-1')).toBe(false);
  });

  // A restored session looks EXACTLY like a brand-new one until its transcript
  // is replayed into the bucket: empty messages, idle, and a title that was
  // never derived. Only `runtimeIdentity` separates the two, so without it the
  // retarget branch would rewrite a real conversation's workspace binding.
  it('is false for a restored session that carries a runtimeIdentity but has no replayed messages', () => {
    const state = makeState({
      sessions: [makeSession({ runtimeIdentity: 'pi-session-1' })],
    });
    expect(isFreshEmptySession(state, 'session-1')).toBe(false);
  });

  // Explicit regression target (task spec): zero messages + never host-bound
  // + placeholder title must NOT be judged fresh while the session is busy.
  it.each([
    'starting',
    'running',
    'stopping',
    'waiting_permission',
    'waiting_question',
    'failed',
  ] as const)('is false when status is %s even with zero messages and a placeholder title', (status) => {
    const state = makeState({ sessions: [makeSession({ status })] });
    expect(isFreshEmptySession(state, 'session-1')).toBe(false);
  });

  it('is false once the title is no longer a placeholder (user-renamed or derived)', () => {
    const state = makeState({ sessions: [makeSession({ title: 'Fix the login flow' })] });
    expect(isFreshEmptySession(state, 'session-1')).toBe(false);
  });

  it('recognizes every placeholder title shape via isPlaceholderTitle (delegation, not a re-implementation)', () => {
    for (const title of ['New chat', 'Live Agent Host', 'Session ab12cd', '', '   ']) {
      const state = makeState({ sessions: [makeSession({ title })] });
      expect(isFreshEmptySession(state, 'session-1')).toBe(true);
    }
  });
});
