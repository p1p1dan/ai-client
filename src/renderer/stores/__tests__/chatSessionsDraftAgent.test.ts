import { CLAUDE_CODE_AGENT, CODEX_AGENT, sessionAgent } from '@shared/types/agentWire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDismissedSessionRows } from '@/components/chat/sessionIndex/dismissedSessions';
import { mergeSessionIndex } from '@/components/chat/sessionIndex/sessionIndexMerge';
import { type ChatSession, type ChatWorkspace, useChatSessionsStore } from '../chatSessions';

/**
 * D48 S1 · A3 / A5a / A5b / A7 / A11 — the draft-agent write path.
 *
 * The picker is renderer-only and writes through ONE narrow store action, so
 * the lock invariant has a single place it can be asserted. It has to hold in
 * two directions:
 *
 *  - nothing may change the binding of a session that is already materialized
 *    (host-bound, or carrying a resume handle), because the next message would
 *    hand that handle to a runtime that never issued it;
 *  - the `sendAttempted` latch lives in `ChatWorkspace`'s local state and is
 *    invisible to the store, so it has to arrive as an explicit argument —
 *    otherwise the whole "cannot switch agents while the create IPC is in
 *    flight" defence is the composer's `disabled` prop and nothing else.
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

function seedStore(sessions: ChatSession[], extra: Record<string, unknown> = {}) {
  useChatSessionsStore.setState({
    projects: [{ id: 'p1', name: 'repo' }],
    workspaces,
    sessions,
    messages: {},
    activeSessionId: sessions[0]?.id ?? null,
    recentSessionIds: sessions.map((item) => item.id),
    hostBoundSessionIds: [],
    pendingPermissions: [],
    pendingQuestion: null,
    lastError: null,
    historyErrors: {},
    ...extra,
  });
}

const unsent = { sendAttempted: false };

beforeEach(() => {
  resetDismissedSessionRows();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('setDraftSessionAgent — the happy path is a zero-turn draft', () => {
  it('writes the binding and bumps updatedAt, and reports that it wrote', () => {
    stubChatApi();
    seedStore([session('s1', { updatedAt: 1000 })]);

    const wrote = useChatSessionsStore.getState().setDraftSessionAgent('s1', CODEX_AGENT, unsent);

    expect(wrote).toBe(true);
    const row = useChatSessionsStore.getState().sessions[0];
    expect(sessionAgent(row)).toBe(CODEX_AGENT);
    expect(row.updatedAt).toBeGreaterThanOrEqual(1000);
  });

  it('switches back and forth freely before the first send', () => {
    stubChatApi();
    seedStore([session('s1')]);
    const setDraft = useChatSessionsStore.getState().setDraftSessionAgent;

    expect(setDraft('s1', CODEX_AGENT, unsent)).toBe(true);
    expect(setDraft('s1', CLAUDE_CODE_AGENT, unsent)).toBe(true);
    expect(sessionAgent(useChatSessionsStore.getState().sessions[0])).toBe(CLAUDE_CODE_AGENT);
  });

  it('leaves every other session untouched', () => {
    stubChatApi();
    seedStore([session('s1'), session('s2')]);

    useChatSessionsStore.getState().setDraftSessionAgent('s1', CODEX_AGENT, unsent);

    const [first, second] = useChatSessionsStore.getState().sessions;
    expect(sessionAgent(first)).toBe(CODEX_AGENT);
    expect(second.agent).toBeUndefined();
  });

  it('is a no-op for an id that is not in the store', () => {
    stubChatApi();
    seedStore([session('s1')]);
    const before = useChatSessionsStore.getState().sessions;

    expect(
      useChatSessionsStore.getState().setDraftSessionAgent('missing', CODEX_AGENT, unsent)
    ).toBe(false);
    expect(useChatSessionsStore.getState().sessions).toBe(before);
  });
});

describe('A5a — the store’s own two arms reject a materialized session', () => {
  it('refuses a host-bound session and leaves the array reference untouched', () => {
    stubChatApi();
    seedStore([session('s1')], { hostBoundSessionIds: ['s1'] });
    const before = useChatSessionsStore.getState().sessions;

    const wrote = useChatSessionsStore.getState().setDraftSessionAgent('s1', CODEX_AGENT, unsent);

    expect(wrote).toBe(false);
    expect(useChatSessionsStore.getState().sessions).toBe(before);
    expect(sessionAgent(useChatSessionsStore.getState().sessions[0])).toBe(CLAUDE_CODE_AGENT);
  });

  it('refuses a restored session that only carries a runtimeIdentity', () => {
    // Host is not running, so `hostBoundSessionIds` is empty — this arm is the
    // one that keeps a session restored from session-index.json from being
    // re-pointed at another runtime while it still names a live conversation.
    stubChatApi();
    seedStore([session('s1', { runtimeIdentity: 'thread-7' })]);
    const before = useChatSessionsStore.getState().sessions;

    expect(useChatSessionsStore.getState().setDraftSessionAgent('s1', CODEX_AGENT, unsent)).toBe(
      false
    );
    expect(useChatSessionsStore.getState().sessions).toBe(before);
  });
});

describe('A5b — the sendAttempted arm arrives as an explicit argument', () => {
  it('refuses while a send is committed even though the store itself sees nothing', () => {
    // The create IPC is in flight: no id in `hostBoundSessionIds`, no
    // `runtimeIdentity` yet, and the agent for this turn is already committed.
    stubChatApi();
    seedStore([session('s1')]);
    const before = useChatSessionsStore.getState().sessions;

    const wrote = useChatSessionsStore
      .getState()
      .setDraftSessionAgent('s1', CODEX_AGENT, { sendAttempted: true });

    expect(wrote).toBe(false);
    expect(useChatSessionsStore.getState().sessions).toBe(before);
  });
});

describe('A7 — a draft switch does not materialize an index row', () => {
  it('performs no IPC at all', () => {
    const api = stubChatApi();
    seedStore([session('s1')]);

    useChatSessionsStore.getState().setDraftSessionAgent('s1', CODEX_AGENT, unsent);

    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(api.ensureHost).not.toHaveBeenCalled();
    expect(api.closeSession).not.toHaveBeenCalled();
  });

  it('a live-only row still passes through mergeSessionIndex with no entry of its own', () => {
    // `mergeSessionIndex` stays the ONE place a missing binding becomes a
    // materialized one. A user's explicit choice is not a default, and an
    // unsent session has no index entry to write it into.
    stubChatApi();
    seedStore([session('s1')]);
    useChatSessionsStore.getState().setDraftSessionAgent('s1', CODEX_AGENT, unsent);

    const merged = mergeSessionIndex(useChatSessionsStore.getState().sessions, [], { workspaces });

    expect(merged.sessions).toHaveLength(1);
    expect(merged.sessions[0].id).toBe('s1');
    expect(sessionAgent(merged.sessions[0])).toBe(CODEX_AGENT);
    expect(merged.orphaned).toEqual([]);
  });

  it('after the first send the binding and the index entry agree', () => {
    stubChatApi();
    seedStore([session('s1')]);
    useChatSessionsStore.getState().setDraftSessionAgent('s1', CODEX_AGENT, unsent);

    const merged = mergeSessionIndex(
      useChatSessionsStore.getState().sessions,
      [
        {
          sessionId: 's1',
          workspacePath: '/repo',
          title: 's1',
          updatedAt: 2000,
          agent: CODEX_AGENT,
          archived: false,
        },
      ],
      { workspaces }
    );

    expect(sessionAgent(merged.sessions[0])).toBe(CODEX_AGENT);
  });
});

describe('A3 (store path) / A11 — the create payload states the binding the picker shows', () => {
  it('sendMessage forwards the draft agent verbatim', async () => {
    const api = stubChatApi();
    seedStore([session('s1')]);
    useChatSessionsStore.getState().setDraftSessionAgent('s1', CODEX_AGENT, unsent);

    await useChatSessionsStore.getState().sendMessage('hello');

    expect(api.createSession).toHaveBeenCalledWith({
      sessionId: 's1',
      workspacePath: '/repo',
      agent: CODEX_AGENT,
    });
  });

  it('a store change landing mid-flight does not rewrite the payload', async () => {
    // The binding and the resume handle travel together and must describe the
    // same instant — the snapshot is taken before the first await, not read
    // again after it.
    const api = stubChatApi({
      ensureHost: vi.fn().mockImplementation(async () => {
        useChatSessionsStore.setState((prev) => ({
          sessions: prev.sessions.map((item) =>
            item.id === 's1' ? { ...item, agent: CLAUDE_CODE_AGENT } : item
          ),
        }));
      }),
    });
    seedStore([session('s1', { agent: CODEX_AGENT })]);

    await useChatSessionsStore.getState().sendMessage('hello');

    expect(api.createSession).toHaveBeenCalledWith({
      sessionId: 's1',
      workspacePath: '/repo',
      agent: CODEX_AGENT,
    });
  });

  it('a written-back fallback makes sessionAgent and the payload agree', async () => {
    // A11: the picker resolved `codex` down to the compatibility agent and
    // committed it; the create must carry what the user can see, not the stale
    // draft it replaced.
    const api = stubChatApi();
    seedStore([session('s1', { agent: CODEX_AGENT })]);

    useChatSessionsStore.getState().setDraftSessionAgent('s1', CLAUDE_CODE_AGENT, unsent);
    await useChatSessionsStore.getState().sendMessage('hello');

    expect(sessionAgent(useChatSessionsStore.getState().sessions[0])).toBe(CLAUDE_CODE_AGENT);
    expect(api.createSession).toHaveBeenCalledWith({
      sessionId: 's1',
      workspacePath: '/repo',
      agent: CLAUDE_CODE_AGENT,
    });
  });
});
