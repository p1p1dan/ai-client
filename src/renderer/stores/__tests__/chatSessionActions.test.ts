import type { SessionCreateCommand } from '@shared/types/agentHost';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveSendCwd } from '@/components/chat/composerTarget';
import { decideSendPreamble } from '@/components/chat/sendPreamble';
import { createChatSessionOnWorkspace, retargetChatSession } from '../chatSessionActions';
import { type ChatSession, type ChatWorkspace, useChatSessionsStore } from '../chatSessions';

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
    pendingPermission: null,
    pendingQuestion: null,
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

    const payload: SessionCreateCommand['payload'] = {
      sessionId: 's1',
      workspacePath: cwd ?? '',
    };
    expect(structuredClone(payload).workspacePath).toBe('/b');
  });
});
