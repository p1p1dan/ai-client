import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthRequiredError } from '@/components/chat/authRequiredError';
import { resetDismissedSessionRows } from '@/components/chat/sessionIndex/dismissedSessions';
import { type ChatSession, type ChatWorkspace, useChatSessionsStore } from '../chatSessions';

/**
 * D47 S5 §3 cross-check (施工规格 件一-1) — end-to-end SHAPE test proving the
 * spawn gate's rejection actually survives from a (faked) `main/ipc/chat.ts`
 * handler through the IPC boundary into the renderer store, and that
 * `authRequiredError.ts`'s pure `isAuthRequiredError` matcher recognizes the
 * result.
 *
 * `main/services/auth/spawnGate.ts` throws a plain `Error` (never resolves
 * `{ok:false,...}`) whose `.message` is `${code}: ${message}` — this is the
 * ONE shape Electron's `ipcRenderer.invoke` reliably preserves across the IPC
 * boundary. This test fakes exactly that shape at the `window.electronAPI`
 * seam (the same seam `chatSessionsSendGuard.test.ts` stubs) rather than
 * spinning up real Electron IPC — the "fake handler" is the stubbed
 * `createSession` rejecting with that literal Error, matching what a real
 * `ipcRenderer.invoke` rejection looks like once it reaches the renderer.
 *
 * Chain under test: fake handler throw -> chatSessions.sendMessage's
 * try/catch (never silently swallowed) -> `lastError` / `role:'error'`
 * message block -> `isAuthRequiredError` (consumed by MessageTimeline.tsx)
 * correctly classifies it, and a negative control proves the same code path
 * does NOT misclassify an unrelated failure.
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

describe('spawn-gate rejection shape (fake handler -> renderer, D47 S5 §3)', () => {
  it('a thrown `auth_required: <message>` Error (the spawnGate.ts shape) is never silently swallowed and is recognized by isAuthRequiredError', async () => {
    stubChatApi({
      createSession: vi
        .fn()
        .mockRejectedValue(
          new Error('auth_required: Sign-in required before starting an agent session.')
        ),
    });
    seedStore();

    await send();

    const state = useChatSessionsStore.getState();
    // Not silently swallowed: lastError is set and a role:'error' message
    // block was appended — the S5b self-reported risk (a `resolve({ok:false})`
    // handler shape whose renderer try/catch never fires) does not apply
    // here because the fake handler throws, exactly like the real one.
    expect(state.lastError).toBe(
      'auth_required: Sign-in required before starting an agent session.'
    );
    expect(state.sessions[0]?.status).toBe('failed');
    const block = state.messages.s1?.[0];
    expect(block?.role).toBe('error');
    expect(block?.blocks[0]?.text).toBe(
      'auth_required: Sign-in required before starting an agent session.'
    );

    // The pure function MessageTimeline.tsx calls to swap in the re-login
    // card recognizes both surfaces.
    expect(isAuthRequiredError(state.lastError)).toBe(true);
    expect(isAuthRequiredError(block?.blocks[0]?.text)).toBe(true);
  });

  it("the locked-credentials rejection message (spawnGate.ts's other fixed string) is also recognized", async () => {
    stubChatApi({
      createSession: vi
        .fn()
        .mockRejectedValue(
          new Error('auth_required: Credentials are still unlocking — try again in a moment.')
        ),
    });
    seedStore();

    await send();

    const state = useChatSessionsStore.getState();
    expect(isAuthRequiredError(state.lastError)).toBe(true);
  });

  it('negative control — an unrelated createSession failure is surfaced but NOT classified as auth-required', async () => {
    stubChatApi({
      createSession: vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:1234')),
    });
    seedStore();

    await send();

    const state = useChatSessionsStore.getState();
    expect(state.lastError).toBe('ECONNREFUSED 127.0.0.1:1234');
    expect(isAuthRequiredError(state.lastError)).toBe(false);
  });
});
