import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markSessionDismissed,
  resetDismissedSessionRows,
} from '@/components/chat/sessionIndex/dismissedSessions';
import { type ChatSession, type ChatWorkspace, useChatSessionsStore } from '../chatSessions';

/**
 * R5 round-2 (A5) — ghost-session guard in `sendMessage`.
 *
 * The send crosses `ensureHost` and `createSession` before it reaches
 * `chat.send`. Closing or archiving the active session inside that window used
 * to leave the Host driving a session with no row in the UI: nothing could
 * stop it, and its error message landed in a deleted message bucket.
 */

const workspaces: ChatWorkspace[] = [
  { id: 'ws-main', projectId: 'p1', name: 'Main', kind: 'main', path: '/repo' },
];

function session(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: 'p1',
    workspaceId: 'ws-main',
    title: id,
    status: 'idle',
    updatedAt: 1000,
    ...extra,
  };
}

interface ChatApiStub {
  ensureHost: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
}

function stubChatApi(overrides: Partial<ChatApiStub> = {}): ChatApiStub {
  const api: ChatApiStub = {
    ensureHost: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue({ requestId: 'req-create' }),
    send: vi.fn().mockResolvedValue({ requestId: 'req-send' }),
    closeSession: vi.fn().mockResolvedValue({ requestId: 'req-close' }),
    ...overrides,
  };
  (globalThis as { window?: unknown }).window = {
    electronAPI: { chat: api },
  } as unknown as typeof globalThis.window;
  return api;
}

/** The store surgery Close / Archive perform on the row (see removeSessionRow). */
function removeRow(sessionId: string): void {
  const state = useChatSessionsStore.getState();
  markSessionDismissed(sessionId);
  useChatSessionsStore.setState({
    sessions: state.sessions.filter((item) => item.id !== sessionId),
    activeSessionId: null,
    hostBoundSessionIds: state.hostBoundSessionIds.filter((id) => id !== sessionId),
  });
}

function seedStore(extra: Partial<ReturnType<typeof useChatSessionsStore.getState>> = {}) {
  useChatSessionsStore.setState({
    projects: [{ id: 'p1', name: 'repo' }],
    workspaces,
    sessions: [session('s1')],
    messages: {},
    activeSessionId: 's1',
    recentSessionIds: ['s1'],
    hostBoundSessionIds: [],
    pendingPermissions: [],
    pendingQuestion: null,
    lastError: null,
    historyErrors: {},
    ...extra,
  });
}

const send = (text = 'hello') => useChatSessionsStore.getState().sendMessage(text);

beforeEach(() => {
  resetDismissedSessionRows();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('sendMessage — unchanged happy path', () => {
  it('ensures the host, creates the session once, sends, and records the binding', async () => {
    const api = stubChatApi();
    seedStore();

    await send();

    expect(api.ensureHost).toHaveBeenCalledTimes(1);
    // Chat is Pi-only, so the renderer no longer names a runtime: Main stamps
    // `agent: PI_AGENT` in `chat:createSession` itself. Asserting the exact
    // payload keeps a re-introduced renderer-side binding visible here.
    expect(api.createSession).toHaveBeenCalledWith({
      sessionId: 's1',
      workspacePath: '/repo',
    });
    // Every send carries a fresh `attemptId` so the runtime's echo can be
    // matched back to this attempt — nondeterministic by design, so only its
    // presence and prefix are pinned.
    expect(api.send).toHaveBeenCalledWith({
      sessionId: 's1',
      text: 'hello',
      attemptId: expect.stringMatching(/^send-attempt-/),
    });
    expect(api.closeSession).not.toHaveBeenCalled();
    expect(useChatSessionsStore.getState().hostBoundSessionIds).toEqual(['s1']);
  });

  it('still surfaces a genuine send failure as lastError + a failed row', async () => {
    stubChatApi({ send: vi.fn().mockRejectedValue(new Error('boom')) });
    seedStore();

    await send();

    const state = useChatSessionsStore.getState();
    expect(state.lastError).toBe('boom');
    expect(state.sessions[0]?.status).toBe('failed');
    expect(state.messages.s1?.[0]?.role).toBe('error');
  });
});

describe('sendMessage — ghost-session guards (A5)', () => {
  it('aborts when the session is removed while ensureHost is in flight', async () => {
    const api = stubChatApi({
      ensureHost: vi.fn().mockImplementation(async () => {
        removeRow('s1');
      }),
    });
    seedStore();

    await send();

    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    // Nothing was started Host-side, so there is nothing to reap — and no
    // error banner for a session the user deliberately removed.
    expect(api.closeSession).not.toHaveBeenCalled();
    expect(useChatSessionsStore.getState().lastError).toBeNull();
  });

  it('aborts before send for an already Host-bound session that was removed', async () => {
    const api = stubChatApi({
      ensureHost: vi.fn().mockImplementation(async () => {
        removeRow('s1');
      }),
    });
    seedStore({ hostBoundSessionIds: ['s1'] });

    await send();

    expect(api.send).not.toHaveBeenCalled();
  });

  it('reaps the runtime when the session is removed while createSession is in flight', async () => {
    const api = stubChatApi({
      createSession: vi.fn().mockImplementation(async () => {
        removeRow('s1');
        return { requestId: 'req-create' };
      }),
    });
    seedStore();

    await send();

    expect(api.send).not.toHaveBeenCalled();
    // The Host now holds a session the UI can never reach again.
    expect(api.closeSession).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(useChatSessionsStore.getState().hostBoundSessionIds).toEqual([]);
  });

  it('aborts when a refresh re-added the row but it is still dismissed this run', async () => {
    const api = stubChatApi({
      ensureHost: vi.fn().mockImplementation(async () => {
        // Row present again (an index refresh re-merged it), yet the user's
        // removal stands for the rest of the run — existence alone is not
        // enough to keep going.
        markSessionDismissed('s1');
      }),
    });
    seedStore();

    await send();

    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('tolerates a failing reap without throwing out of sendMessage', async () => {
    const api = stubChatApi({
      createSession: vi.fn().mockImplementation(async () => {
        removeRow('s1');
        return { requestId: 'req-create' };
      }),
      closeSession: vi.fn().mockRejectedValue(new Error('host down')),
    });
    seedStore();

    await expect(send()).resolves.toBeUndefined();
    expect(api.send).not.toHaveBeenCalled();
  });
});
