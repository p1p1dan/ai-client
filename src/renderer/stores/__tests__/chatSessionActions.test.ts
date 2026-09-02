import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSendCwd } from '@/components/chat/composerTarget';
import { decideSendPreamble } from '@/components/chat/sendPreamble';
import {
  applyAutoSessionTitle,
  createChatSessionOnWorkspace,
  materializeForkedChatSession,
  materializeIndexedPiChatSession,
  retargetChatSession,
} from '../chatSessionActions';
import { type ChatSession, type ChatWorkspace, useChatSessionsStore } from '../chatSessions';

type ChatSessionCreatePayload = {
  sessionId: string;
  workspacePath: string;
};

function makeWorkspace(overrides: Partial<ChatWorkspace> = {}): ChatWorkspace {
  return {
    id: 'ws-1',
    projectId: 'project-1',
    name: 'Main',
    kind: 'main',
    path: '/repo',
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    workspaceId: 'ws-1',
    title: 'Session',
    status: 'idle',
    updatedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useChatSessionsStore.setState({
    projects: [],
    workspaces: [],
    sessions: [],
    messages: {},
    activeSessionId: null,
    recentSessionIds: [],
    hostBoundSessionIds: [],
    lastError: null,
    historyErrors: {},
    pendingPermissions: [],
    pendingQuestion: null,
  });
});

describe('materializeForkedChatSession', () => {
  it('adds, binds, and selects an indexed Pi fork without copying source transient state', () => {
    const workspace = makeWorkspace({ path: '/repo/' });
    const source = makeSession({ id: 'source' });
    useChatSessionsStore.setState({
      workspaces: [workspace],
      sessions: [source],
      recentSessionIds: ['source'],
      hostBoundSessionIds: ['source'],
      messages: { source: [] },
    });

    expect(
      materializeForkedChatSession({
        sessionId: 'forked',
        runtimeIdentity: '/sessions/forked.jsonl',
        agent: 'pi',
        workspacePath: '/repo',
        title: 'Source (fork)',
        updatedAt: 42,
        archived: false,
      })
    ).toBe(true);

    const state = useChatSessionsStore.getState();
    expect(state.activeSessionId).toBe('forked');
    expect(state.hostBoundSessionIds).toEqual(['source', 'forked']);
    expect(state.sessions[0]).toMatchObject({
      id: 'forked',
      runtimeIdentity: '/sessions/forked.jsonl',
      agent: 'pi',
      status: 'idle',
    });
    expect(state.messages).toEqual({ source: [] });
  });

  it('materializes an imported Pi file as resumable rather than falsely host-bound', () => {
    expect(
      materializeIndexedPiChatSession(
        {
          sessionId: 'imported',
          runtimeIdentity: '/sessions/imported.jsonl',
          agent: 'pi',
          workspacePath: '/repo',
          title: 'Imported',
          updatedAt: 42,
          archived: false,
        },
        { createWorkspaceIfMissing: true, hostBound: false }
      )
    ).toBe(true);
    const state = useChatSessionsStore.getState();
    expect(state.hostBoundSessionIds).not.toContain('imported');
    expect(
      decideSendPreamble({
        hostBound: state.hostBoundSessionIds.includes('imported'),
        runtimeIdentity: state.sessions.find((item) => item.id === 'imported')?.runtimeIdentity,
      })
    ).toEqual({ action: 'resume', runtimeIdentity: '/sessions/imported.jsonl' });
  });

  it('refuses a fork whose indexed workspace is not mounted in this window', () => {
    expect(
      materializeForkedChatSession({
        sessionId: 'forked',
        runtimeIdentity: '/sessions/forked.jsonl',
        agent: 'pi',
        workspacePath: '/missing',
        title: 'Fork',
        updatedAt: 1,
        archived: false,
      })
    ).toBe(false);
  });
});

describe('retargetChatSession', () => {
  it('moves the session to the target workspace and project', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const wsB = makeWorkspace({ id: 'ws-b', projectId: 'proj-b', path: '/b' });
    const session = makeSession({
      id: 's1',
      workspaceId: 'ws-a',
      projectId: 'proj-a',
      updatedAt: 1,
    });
    useChatSessionsStore.setState({ workspaces: [wsA, wsB], sessions: [session] });

    const result = retargetChatSession('s1', 'ws-b');

    expect(result).toBe(true);
    const updated = useChatSessionsStore.getState().sessions.find((item) => item.id === 's1');
    expect(updated?.workspaceId).toBe('ws-b');
    expect(updated?.projectId).toBe('proj-b');
    expect(updated?.updatedAt).toBeGreaterThan(1);
  });

  it('leaves every other session object untouched (identity check)', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const wsB = makeWorkspace({ id: 'ws-b', projectId: 'proj-b', path: '/b' });
    const target = makeSession({ id: 's1', workspaceId: 'ws-a' });
    const other = makeSession({ id: 's2', workspaceId: 'ws-a' });
    useChatSessionsStore.setState({ workspaces: [wsA, wsB], sessions: [target, other] });

    retargetChatSession('s1', 'ws-b');

    const untouched = useChatSessionsStore.getState().sessions.find((item) => item.id === 's2');
    expect(untouched).toBe(other);
  });

  it('is a no-op when the workspace is unknown', () => {
    const wsA = makeWorkspace({ id: 'ws-a', path: '/a' });
    const session = makeSession({ id: 's1', workspaceId: 'ws-a' });
    useChatSessionsStore.setState({ workspaces: [wsA], sessions: [session] });

    const result = retargetChatSession('s1', 'ws-missing');

    expect(result).toBe(false);
    expect(useChatSessionsStore.getState().sessions[0]).toBe(session);
  });

  it('is a no-op when the session already sits on that workspace', () => {
    const wsA = makeWorkspace({ id: 'ws-a', path: '/a' });
    const session = makeSession({ id: 's1', workspaceId: 'ws-a' });
    useChatSessionsStore.setState({ workspaces: [wsA], sessions: [session] });

    const result = retargetChatSession('s1', 'ws-a');

    expect(result).toBe(false);
    expect(useChatSessionsStore.getState().sessions[0]).toBe(session);
  });

  it('does not touch hostBoundSessionIds or messages', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const wsB = makeWorkspace({ id: 'ws-b', projectId: 'proj-b', path: '/b' });
    const sessionId = 's1';
    const session = makeSession({ id: sessionId, workspaceId: 'ws-a' });
    const messages = { [sessionId]: [] };
    useChatSessionsStore.setState({
      workspaces: [wsA, wsB],
      sessions: [session],
      hostBoundSessionIds: ['s1'],
      messages,
    });

    retargetChatSession('s1', 'ws-b');

    const state = useChatSessionsStore.getState();
    expect(state.hostBoundSessionIds).toEqual(['s1']);
    expect(state.messages).toBe(messages);
  });
});

describe('createChatSessionOnWorkspace (moved)', () => {
  it('prepends the session, activates it and returns the id', () => {
    const ws = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const existing = makeSession({ id: 'existing', workspaceId: 'ws-a' });
    useChatSessionsStore.setState({ workspaces: [ws], sessions: [existing], recentSessionIds: [] });

    const id = createChatSessionOnWorkspace('ws-a', 'New chat');

    expect(id).not.toBeNull();
    const state = useChatSessionsStore.getState();
    expect(state.sessions[0]?.id).toBe(id);
    expect(state.sessions[1]).toBe(existing);
    expect(state.activeSessionId).toBe(id);
  });

  it('returns null for an unknown workspace', () => {
    useChatSessionsStore.setState({ workspaces: [], sessions: [] });

    const id = createChatSessionOnWorkspace('nope');

    expect(id).toBeNull();
  });
});

describe('target change flow (流程断言 · 验收②)', () => {
  it('retarget → resolveSendCwd equals the new workspace path', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const wsB = makeWorkspace({ id: 'ws-b', projectId: 'proj-b', path: '/b' });
    const session = makeSession({ id: 's1', workspaceId: 'ws-a' });
    useChatSessionsStore.setState({
      workspaces: [wsA, wsB],
      sessions: [session],
      activeSessionId: 's1',
    });

    retargetChatSession('s1', 'ws-b');

    const state = useChatSessionsStore.getState();
    const cwd = resolveSendCwd({
      activeSessionId: state.activeSessionId,
      sessions: state.sessions,
      workspaces: state.workspaces,
    });
    expect(cwd).toBe('/b');
  });

  it('fork → resolveSendCwd equals the new workspace path and the old session keeps its own', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const wsB = makeWorkspace({ id: 'ws-b', projectId: 'proj-b', path: '/b' });
    const oldSession = makeSession({ id: 'old', workspaceId: 'ws-a' });
    useChatSessionsStore.setState({
      workspaces: [wsA, wsB],
      sessions: [oldSession],
      activeSessionId: 'old',
    });

    const newId = createChatSessionOnWorkspace('ws-b');

    const state = useChatSessionsStore.getState();
    const cwd = resolveSendCwd({
      activeSessionId: state.activeSessionId,
      sessions: state.sessions,
      workspaces: state.workspaces,
    });
    expect(cwd).toBe('/b');

    const oldNow = state.sessions.find((item) => item.id === 'old');
    expect(oldNow?.workspaceId).toBe('ws-a');
    expect(newId).not.toBe('old');
  });

  it('after retarget the send preamble is create (so createSession carries the new cwd)', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const wsB = makeWorkspace({ id: 'ws-b', projectId: 'proj-b', path: '/b' });
    const session = makeSession({ id: 's1', workspaceId: 'ws-a' });
    useChatSessionsStore.setState({
      workspaces: [wsA, wsB],
      sessions: [session],
      activeSessionId: 's1',
    });

    retargetChatSession('s1', 'ws-b');

    const state = useChatSessionsStore.getState();
    const cwd = resolveSendCwd({
      activeSessionId: state.activeSessionId,
      sessions: state.sessions,
      workspaces: state.workspaces,
    });
    expect(cwd).toBe('/b');

    // A retargeted session was never created on the Host for the new
    // workspace, so the next send must go through session.create with the
    // new cwd rather than direct/resume against the old workspace's
    // registry entry.
    const preamble = decideSendPreamble({ hostBound: false, runtimeIdentity: undefined });
    expect(preamble).toEqual({ action: 'create' });
  });

  it('builds a createSession payload whose workspacePath survives structuredClone', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const wsB = makeWorkspace({ id: 'ws-b', projectId: 'proj-b', path: '/b' });
    const session = makeSession({ id: 's1', workspaceId: 'ws-a' });
    useChatSessionsStore.setState({
      workspaces: [wsA, wsB],
      sessions: [session],
      activeSessionId: 's1',
    });

    retargetChatSession('s1', 'ws-b');

    const state = useChatSessionsStore.getState();
    const cwd = resolveSendCwd({
      activeSessionId: state.activeSessionId,
      sessions: state.sessions,
      workspaces: state.workspaces,
    });

    const payload: ChatSessionCreatePayload = {
      sessionId: 's1',
      workspacePath: cwd ?? '',
    };
    expect(structuredClone(payload).workspacePath).toBe('/b');
  });
});

describe('applyAutoSessionTitle (T-27 round-3, point-check #10)', () => {
  function stubRenameSession(renameSession: (args: unknown) => Promise<boolean>) {
    (globalThis as { window?: unknown }).window = {
      electronAPI: { chat: { renameSession } },
    } as unknown as typeof globalThis.window;
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('renames a placeholder-titled session from the first message and patches the store', async () => {
    const renameSession = vi.fn().mockResolvedValue(true);
    stubRenameSession(renameSession);
    const session = makeSession({ id: 's1', title: 'New chat' });
    useChatSessionsStore.setState({ sessions: [session] });

    await applyAutoSessionTitle('s1', 'Fix the login flow. Also check signup.');

    expect(renameSession).toHaveBeenCalledWith({ sessionId: 's1', title: 'Fix the login flow' });
    const updated = useChatSessionsStore.getState().sessions.find((item) => item.id === 's1');
    expect(updated?.title).toBe('Fix the login flow');
  });

  it('recognizes the "Session xxxxxx" fallback shape as a placeholder too', async () => {
    const renameSession = vi.fn().mockResolvedValue(true);
    stubRenameSession(renameSession);
    const session = makeSession({ id: 's1', title: 'Session ab12cd' });
    useChatSessionsStore.setState({ sessions: [session] });

    await applyAutoSessionTitle('s1', 'hello there');

    expect(renameSession).toHaveBeenCalled();
    const updated = useChatSessionsStore.getState().sessions.find((item) => item.id === 's1');
    expect(updated?.title).toBe('hello there');
  });

  it('never overwrites a real (non-placeholder / user-renamed) title', async () => {
    const renameSession = vi.fn().mockResolvedValue(true);
    stubRenameSession(renameSession);
    const session = makeSession({ id: 's1', title: 'My custom name' });
    useChatSessionsStore.setState({ sessions: [session] });

    await applyAutoSessionTitle('s1', 'some other message');

    expect(renameSession).not.toHaveBeenCalled();
    const updated = useChatSessionsStore.getState().sessions.find((item) => item.id === 's1');
    expect(updated?.title).toBe('My custom name');
  });

  it('leaves the placeholder in place when no title is derivable from the message', async () => {
    const renameSession = vi.fn().mockResolvedValue(true);
    stubRenameSession(renameSession);
    const session = makeSession({ id: 's1', title: 'New chat' });
    useChatSessionsStore.setState({ sessions: [session] });

    await applyAutoSessionTitle('s1', '!!!');

    expect(renameSession).not.toHaveBeenCalled();
    const updated = useChatSessionsStore.getState().sessions.find((item) => item.id === 's1');
    expect(updated?.title).toBe('New chat');
  });

  it('is a no-op for an unknown session id', async () => {
    const renameSession = vi.fn().mockResolvedValue(true);
    stubRenameSession(renameSession);
    useChatSessionsStore.setState({ sessions: [] });

    await applyAutoSessionTitle('missing', 'hello');

    expect(renameSession).not.toHaveBeenCalled();
  });

  it('leaves the store title untouched when the IPC rename fails', async () => {
    const renameSession = vi.fn().mockResolvedValue(false);
    stubRenameSession(renameSession);
    const session = makeSession({ id: 's1', title: 'New chat' });
    useChatSessionsStore.setState({ sessions: [session] });

    await applyAutoSessionTitle('s1', 'hello there');

    expect(renameSession).toHaveBeenCalled();
    const updated = useChatSessionsStore.getState().sessions.find((item) => item.id === 's1');
    expect(updated?.title).toBe('New chat');
  });

  // R2: race convergence between the auto-title IPC round-trip and a
  // concurrent manual rename / a second applyAutoSessionTitle call.
  describe('R2 race convergence', () => {
    it('keeps a manual rename made WHILE the IPC round-trip is still pending', async () => {
      let resolveRename: (ok: boolean) => void = () => {};
      const renameSession = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRename = resolve;
          })
      );
      stubRenameSession(renameSession);
      const session = makeSession({ id: 's1', title: 'New chat' });
      useChatSessionsStore.setState({ sessions: [session] });

      const pending = applyAutoSessionTitle('s1', 'Fix the login flow');

      // Simulate the user manually renaming the session while the auto-title
      // IPC call is still in flight (setState directly — the manual rename
      // flow's own IPC path is out of scope for this unit test).
      useChatSessionsStore.setState((state) => ({
        sessions: state.sessions.map((item) =>
          item.id === 's1' ? { ...item, title: 'My manual title' } : item
        ),
      }));

      resolveRename(true);
      await pending;

      const updated = useChatSessionsStore.getState().sessions.find((item) => item.id === 's1');
      expect(updated?.title).toBe('My manual title');
    });

    it('issues only ONE IPC rename call for two concurrent applyAutoSessionTitle calls on the same session', async () => {
      let resolveRename: (ok: boolean) => void = () => {};
      const renameSession = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRename = resolve;
          })
      );
      stubRenameSession(renameSession);
      const session = makeSession({ id: 's1', title: 'New chat' });
      useChatSessionsStore.setState({ sessions: [session] });

      const first = applyAutoSessionTitle('s1', 'Fix the login flow');
      const second = applyAutoSessionTitle('s1', 'Fix the login flow');

      resolveRename(true);
      await Promise.all([first, second]);

      expect(renameSession).toHaveBeenCalledTimes(1);
    });

    it('releases the in-flight lock so a LATER call (after the first settles) can still rename', async () => {
      const renameSession = vi.fn().mockResolvedValue(true);
      stubRenameSession(renameSession);
      const session = makeSession({ id: 's1', title: 'New chat' });
      useChatSessionsStore.setState({ sessions: [session] });

      await applyAutoSessionTitle('s1', 'Fix the login flow');
      // A second session reusing the id space after the first genuinely
      // completed must not still be blocked by the lock.
      useChatSessionsStore.setState({
        sessions: [makeSession({ id: 's1', title: 'New chat' })],
      });
      await applyAutoSessionTitle('s1', 'Second real message');

      expect(renameSession).toHaveBeenCalledTimes(2);
    });
  });
});
