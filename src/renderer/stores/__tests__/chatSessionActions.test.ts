import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSendCwd } from '@/components/chat/composerTarget';
import { decideSendPreamble } from '@/components/chat/sendPreamble';
import {
  applyAutoSessionTitle,
  createChatSessionInCurrentDirectory,
  createChatSessionOnWorkspace,
  createOrReuseChatSessionOnWorkspace,
  createOrReuseUnboundChatSession,
  createUnboundChatSession,
  materializeForkedChatSession,
  materializeIndexedPiChatSession,
  retargetChatSession,
  stopChatSession,
} from '../chatSessionActions';
import { type ChatSession, type ChatWorkspace, useChatSessionsStore } from '../chatSessions';
import { isFreshEmptySession } from '../sessionFreshness';
import { useTurnSendStatusStore } from '../turnSendStatus';

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
    pendingQuestions: [],
  });
  useTurnSendStatusStore.setState({ status: null, baseline: null, pendingReply: null });
});

/**
 * T091 — arm the turn-send slot the way `ChatComposer.runSend` does at its
 * commit point. Goes through the store's own `begin` rather than a hand-built
 * `setState`, so the test cannot arm a shape production never produces (the
 * slot carries an ownership token these tests have no business minting).
 */
function armSendInFlight(sessionId: string): void {
  useTurnSendStatusStore.getState().begin(
    {
      sessionId,
      phase: 'handshake',
      elapsedSeconds: 0,
      turnStartedAtMs: 0,
      budgetMs: 1000,
      attachmentCount: 0,
      attachmentBytes: 0,
      promptChars: 4,
    },
    null
  );
}

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

  /**
   * session-index-02 — a fork of an unbound chat lands in the index with its
   * source's scratch posture and no workspace, which is exactly the shape
   * `mergeSessionIndex` keeps for it across a restart. Requiring a mounted
   * workspace here made the tree dialog report "created, but its workspace
   * could not be materialized" for a fork that had fully landed, with no way to
   * open it before the next restart.
   */
  it('[release-blocker] materializes a fork of an unbound chat, which has no workspace', () => {
    expect(
      materializeForkedChatSession({
        sessionId: 'forked',
        runtimeIdentity: '/sessions/forked.jsonl',
        agent: 'pi',
        workspacePath: '/tmp/base/unbound-sessions/abc',
        unbound: true,
        title: 'Chat (fork)',
        updatedAt: 42,
        archived: false,
      })
    ).toBe(true);

    const state = useChatSessionsStore.getState();
    expect(state.activeSessionId).toBe('forked');
    expect(state.sessions[0]).toMatchObject({
      id: 'forked',
      projectId: '',
      workspaceId: '',
      runtimeIdentity: '/sessions/forked.jsonl',
      unbound: { workspacePath: '/tmp/base/unbound-sessions/abc' },
    });
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

describe('createOrReuseChatSessionOnWorkspace (idempotent New button, A/B/C tiers)', () => {
  it('tier A: does nothing when the active session is already a fresh empty session on the target workspace', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const fresh = makeSession({
      id: 'fresh',
      workspaceId: 'ws-a',
      projectId: 'proj-a',
      title: 'New chat',
      status: 'idle',
    });
    useChatSessionsStore.setState({
      workspaces: [wsA],
      sessions: [fresh],
      activeSessionId: 'fresh',
      messages: {},
      hostBoundSessionIds: [],
      recentSessionIds: ['fresh'],
    });

    const result = createOrReuseChatSessionOnWorkspace('ws-a');

    const state = useChatSessionsStore.getState();
    expect(result).toBe('fresh');
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toBe(fresh); // reference untouched — no write happened
    expect(state.activeSessionId).toBe('fresh');
    expect(state.recentSessionIds).toEqual(['fresh']);
  });

  it('tier B: retargets the fresh empty session onto a different workspace instead of creating a new one', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const wsB = makeWorkspace({ id: 'ws-b', projectId: 'proj-b', path: '/b' });
    const fresh = makeSession({
      id: 'fresh',
      workspaceId: 'ws-a',
      projectId: 'proj-a',
      title: 'New chat',
      status: 'idle',
    });
    useChatSessionsStore.setState({
      workspaces: [wsA, wsB],
      sessions: [fresh],
      activeSessionId: 'fresh',
      messages: {},
      hostBoundSessionIds: [],
    });

    const result = createOrReuseChatSessionOnWorkspace('ws-b');

    const state = useChatSessionsStore.getState();
    expect(result).toBe('fresh');
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.workspaceId).toBe('ws-b');
    expect(state.sessions[0]?.projectId).toBe('proj-b');
    expect(state.activeSessionId).toBe('fresh');
  });

  it('tier C: creates a new session as before when the active session already has messages', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const withHistory = makeSession({
      id: 'with-history',
      workspaceId: 'ws-a',
      projectId: 'proj-a',
      title: 'New chat',
      status: 'idle',
    });
    useChatSessionsStore.setState({
      workspaces: [wsA],
      sessions: [withHistory],
      activeSessionId: 'with-history',
      messages: {
        'with-history': [{ id: 'm1', sessionId: 'with-history', role: 'user', blocks: [] }],
      },
      hostBoundSessionIds: [],
    });

    const result = createOrReuseChatSessionOnWorkspace('ws-a');

    const state = useChatSessionsStore.getState();
    expect(result).not.toBe('with-history');
    expect(state.sessions).toHaveLength(2);
    expect(state.activeSessionId).toBe(result);
    expect(state.sessions.find((item) => item.id === 'with-history')).toBe(withHistory);
  });

  it('tier C: creates a new session as before when the active session is already host-bound', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const bound = makeSession({
      id: 'bound',
      workspaceId: 'ws-a',
      projectId: 'proj-a',
      title: 'New chat',
      status: 'idle',
    });
    useChatSessionsStore.setState({
      workspaces: [wsA],
      sessions: [bound],
      activeSessionId: 'bound',
      messages: {},
      hostBoundSessionIds: ['bound'],
    });

    const result = createOrReuseChatSessionOnWorkspace('ws-a');

    const state = useChatSessionsStore.getState();
    expect(result).not.toBe('bound');
    expect(state.sessions).toHaveLength(2);
  });

  it('tier C: creates a new session as before when the active session title is no longer a placeholder', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const renamed = makeSession({
      id: 'renamed',
      workspaceId: 'ws-a',
      projectId: 'proj-a',
      title: 'Fix the login flow',
      status: 'idle',
    });
    useChatSessionsStore.setState({
      workspaces: [wsA],
      sessions: [renamed],
      activeSessionId: 'renamed',
      messages: {},
      hostBoundSessionIds: [],
    });

    const result = createOrReuseChatSessionOnWorkspace('ws-a');

    const state = useChatSessionsStore.getState();
    expect(result).not.toBe('renamed');
    expect(state.sessions).toHaveLength(2);
  });

  it('guard: an empty, never-host-bound session that is BUSY is not misjudged as fresh — still creates new', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const running = makeSession({
      id: 'running',
      workspaceId: 'ws-a',
      projectId: 'proj-a',
      title: 'New chat', // placeholder title
      status: 'running', // the ONLY non-fresh signal in this case
    });
    useChatSessionsStore.setState({
      workspaces: [wsA],
      sessions: [running],
      activeSessionId: 'running',
      messages: {}, // zero messages
      hostBoundSessionIds: [], // never host-bound
    });

    const result = createOrReuseChatSessionOnWorkspace('ws-a');

    const state = useChatSessionsStore.getState();
    expect(result).not.toBe('running');
    expect(state.sessions).toHaveLength(2);
    // The busy session itself must be left completely alone.
    expect(state.sessions.find((item) => item.id === 'running')).toBe(running);
  });

  it('falls back to the unconditional create when the target workspace id does not resolve (defensive)', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const fresh = makeSession({
      id: 'fresh',
      workspaceId: 'ws-a',
      projectId: 'proj-a',
      title: 'New chat',
    });
    useChatSessionsStore.setState({
      workspaces: [wsA],
      sessions: [fresh],
      activeSessionId: 'fresh',
      messages: {},
      hostBoundSessionIds: [],
    });

    const result = createOrReuseChatSessionOnWorkspace('ws-missing');

    expect(result).toBeNull();
    expect(useChatSessionsStore.getState().sessions).toHaveLength(1);
  });

  it('creates a new session when there is no active session at all', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    useChatSessionsStore.setState({
      workspaces: [wsA],
      sessions: [],
      activeSessionId: null,
      messages: {},
      hostBoundSessionIds: [],
    });

    const result = createOrReuseChatSessionOnWorkspace('ws-a');

    expect(result).not.toBeNull();
    expect(useChatSessionsStore.getState().sessions).toHaveLength(1);
  });

  /**
   * T091, field repro A-b (2026-09-19) — THE acceptance point for this task.
   *
   * Click Send, then click New 0.7s later. The Host has not answered yet, so
   * the session the send belongs to still satisfies every clause of
   * `isFreshEmptySession`: zero messages, never host-bound, status still
   * `idle`, title still `New chat`. The reuse branch therefore fired,
   * `planTargetChange` answered `same-workspace`, and the click did NOTHING —
   * no new session, no navigation, no message. A second later the session the
   * user believed they had left started streaming in front of them. The
   * handshake window measured 1–3.5s on a live gateway, which is exactly long
   * enough to be the common case rather than a race.
   */
  it('[A-b] creates a new session when the active one has a send in flight, even though it still looks fresh', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const sending = makeSession({
      id: 'sending',
      workspaceId: 'ws-a',
      projectId: 'proj-a',
      title: 'New chat', // still a placeholder
      status: 'idle', // the Host has not answered yet
    });
    useChatSessionsStore.setState({
      workspaces: [wsA],
      sessions: [sending],
      activeSessionId: 'sending',
      messages: {}, // no echo yet either
      hostBoundSessionIds: [],
    });
    // Everything except the in-flight send says "fresh".
    expect(isFreshEmptySession(useChatSessionsStore.getState(), 'sending')).toBe(true);

    armSendInFlight('sending');
    const result = createOrReuseChatSessionOnWorkspace('ws-a');

    const state = useChatSessionsStore.getState();
    expect(result).not.toBe('sending');
    expect(state.sessions).toHaveLength(2);
    expect(state.activeSessionId).toBe(result);
    // The committed session is left completely alone — same reference, and it
    // keeps its own workspace binding (the retarget branch must not have run).
    expect(state.sessions.find((item) => item.id === 'sending')).toBe(sending);
  });

  it('[A-b] the in-flight escape hatch is scoped: another session’s send does not disable reuse', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const fresh = makeSession({
      id: 'fresh',
      workspaceId: 'ws-a',
      projectId: 'proj-a',
      title: 'New chat',
    });
    useChatSessionsStore.setState({
      workspaces: [wsA],
      sessions: [fresh],
      activeSessionId: 'fresh',
      messages: {},
      hostBoundSessionIds: [],
    });

    // A send is in flight, but for a session that is not the active one.
    armSendInFlight('somebody-else');
    const result = createOrReuseChatSessionOnWorkspace('ws-a');

    // Unchanged tier-A behaviour: stay put, write nothing.
    expect(result).toBe('fresh');
    expect(useChatSessionsStore.getState().sessions).toHaveLength(1);
  });

  it('[A-b] a finished send releases the slot, so reuse works again', () => {
    const wsA = makeWorkspace({ id: 'ws-a', projectId: 'proj-a', path: '/a' });
    const fresh = makeSession({
      id: 'fresh',
      workspaceId: 'ws-a',
      projectId: 'proj-a',
      title: 'New chat',
    });
    useChatSessionsStore.setState({
      workspaces: [wsA],
      sessions: [fresh],
      activeSessionId: 'fresh',
      messages: {},
      hostBoundSessionIds: [],
    });

    armSendInFlight('fresh');
    const owner = useTurnSendStatusStore.getState().status?.owner;
    expect(owner).toBeDefined();
    // `runSend`'s `finally`.
    useTurnSendStatusStore.getState().end(owner as number);

    expect(createOrReuseChatSessionOnWorkspace('ws-a')).toBe('fresh');
    expect(useChatSessionsStore.getState().sessions).toHaveLength(1);
  });
});

describe('createOrReuseUnboundChatSession (idempotent New button — unbound branch)', () => {
  it('tier A: does nothing when the active session is already a fresh, unbound empty session', () => {
    const unbound = makeSession({
      id: 'fresh-unbound',
      workspaceId: '',
      projectId: '',
      title: 'New chat',
      status: 'idle',
    });
    useChatSessionsStore.setState({
      workspaces: [],
      sessions: [unbound],
      activeSessionId: 'fresh-unbound',
      messages: {},
      hostBoundSessionIds: [],
      recentSessionIds: ['fresh-unbound'],
    });

    const result = createOrReuseUnboundChatSession();

    const state = useChatSessionsStore.getState();
    expect(result).toBe('fresh-unbound');
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toBe(unbound);
    expect(state.activeSessionId).toBe('fresh-unbound');
    expect(state.recentSessionIds).toEqual(['fresh-unbound']);
  });

  it('tier A: also treats a fresh session pointed at a non-targetable (empty-path) workspace as unbound', () => {
    // Mirrors the DEMO seed shape: a real workspace row whose path is empty.
    const wsSeed = makeWorkspace({ id: 'ws-seed', path: '' });
    const fresh = makeSession({
      id: 'fresh',
      workspaceId: 'ws-seed',
      title: 'New chat',
      status: 'idle',
    });
    useChatSessionsStore.setState({
      workspaces: [wsSeed],
      sessions: [fresh],
      activeSessionId: 'fresh',
      messages: {},
      hostBoundSessionIds: [],
    });

    const result = createOrReuseUnboundChatSession();

    const state = useChatSessionsStore.getState();
    expect(result).toBe('fresh');
    expect(state.sessions).toHaveLength(1);
  });

  it('tier C: creates a new unbound session as before when the active session already has messages', () => {
    const unbound = makeSession({
      id: 'has-history',
      workspaceId: '',
      projectId: '',
      title: 'New chat',
      status: 'idle',
    });
    useChatSessionsStore.setState({
      workspaces: [],
      sessions: [unbound],
      activeSessionId: 'has-history',
      messages: {
        'has-history': [{ id: 'm1', sessionId: 'has-history', role: 'user', blocks: [] }],
      },
      hostBoundSessionIds: [],
    });

    const result = createOrReuseUnboundChatSession();

    const state = useChatSessionsStore.getState();
    expect(result).not.toBe('has-history');
    expect(state.sessions).toHaveLength(2);
    expect(state.activeSessionId).toBe(result);
  });

  it('is not tier A when the fresh active session is bound to a real, usable workspace (only the CLICK TARGET is unbound)', () => {
    const wsA = makeWorkspace({ id: 'ws-a', path: '/a' });
    const fresh = makeSession({
      id: 'fresh-bound',
      workspaceId: 'ws-a',
      title: 'New chat',
      status: 'idle',
    });
    useChatSessionsStore.setState({
      workspaces: [wsA],
      sessions: [fresh],
      activeSessionId: 'fresh-bound',
      messages: {},
      hostBoundSessionIds: [],
    });

    const result = createOrReuseUnboundChatSession();

    const state = useChatSessionsStore.getState();
    expect(result).not.toBe('fresh-bound');
    expect(state.sessions).toHaveLength(2);
  });

  it('guard: a fresh, unbound session that is BUSY is not misjudged as fresh — still creates a new one', () => {
    const unbound = makeSession({
      id: 'running-unbound',
      workspaceId: '',
      projectId: '',
      title: 'New chat',
      status: 'running',
    });
    useChatSessionsStore.setState({
      workspaces: [],
      sessions: [unbound],
      activeSessionId: 'running-unbound',
      messages: {},
      hostBoundSessionIds: [],
    });

    const result = createOrReuseUnboundChatSession();

    const state = useChatSessionsStore.getState();
    expect(result).not.toBe('running-unbound');
    expect(state.sessions).toHaveLength(2);
  });

  /** T091 — the unbound branch carries the same escape hatch as the bound one. */
  it('[A-b] creates a new unbound session when the active one has a send in flight', () => {
    const sendingUnbound = makeSession({
      id: 'sending-unbound',
      workspaceId: '',
      projectId: '',
      title: 'New chat',
      status: 'idle',
    });
    useChatSessionsStore.setState({
      workspaces: [],
      sessions: [sendingUnbound],
      activeSessionId: 'sending-unbound',
      messages: {},
      hostBoundSessionIds: [],
    });
    expect(isFreshEmptySession(useChatSessionsStore.getState(), 'sending-unbound')).toBe(true);

    armSendInFlight('sending-unbound');
    const result = createOrReuseUnboundChatSession();

    const state = useChatSessionsStore.getState();
    expect(result).not.toBe('sending-unbound');
    expect(state.sessions).toHaveLength(2);
    expect(state.activeSessionId).toBe(result);
  });
});

/**
 * T091, field repro A-c (2026-09-19) — Stop stopped the wrong session.
 *
 * `stopActiveSession` re-resolves `activeSessionId` for itself, so every caller
 * that knew better (the composer's `inFlightSessionIdRef`, the timeline's
 * `sessionId` prop) silently handed that knowledge back. After creating a new
 * chat mid-handshake, `activeSessionId` names the new empty session and the
 * abort went there while the real turn kept running.
 */
describe('stopChatSession (T091)', () => {
  function stubChatStop(stop: (args: { sessionId: string }) => Promise<unknown>) {
    (globalThis as { window?: unknown }).window = {
      electronAPI: { chat: { stop } },
    } as unknown as typeof globalThis.window;
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('stops the NAMED session, not the active one', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    stubChatStop(stop);
    useChatSessionsStore.setState({
      sessions: [makeSession({ id: 'in-flight' }), makeSession({ id: 'brand-new' })],
      // The exact divergence the field repro produced: the user clicked New
      // during the handshake, so the active session is the empty one.
      activeSessionId: 'brand-new',
      lastError: 'stale',
    });

    await stopChatSession('in-flight');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith({ sessionId: 'in-flight' });
    expect(useChatSessionsStore.getState().lastError).toBeNull();
  });

  it('no-ops on a null/empty session id instead of reaching for the active one', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    stubChatStop(stop);
    useChatSessionsStore.setState({
      sessions: [makeSession({ id: 's1' })],
      activeSessionId: 's1',
    });

    await stopChatSession(null);
    await stopChatSession('');
    await stopChatSession(undefined);

    expect(stop).not.toHaveBeenCalled();
  });

  it('surfaces an IPC failure as lastError, like the store action it replaces', async () => {
    stubChatStop(vi.fn().mockRejectedValue(new Error('worker gone')));
    useChatSessionsStore.setState({ sessions: [makeSession({ id: 's1' })], activeSessionId: 's1' });

    await stopChatSession('s1');

    expect(useChatSessionsStore.getState().lastError).toBe('worker gone');
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

describe('createUnboundChatSession (U22)', () => {
  it('creates and selects a session on a machine with no workspace at all', () => {
    // The reported dead end: a fresh install has no repository, so
    // `createChatSessionOnWorkspace` returns null (asserted above) and there was
    // no other way to get an `activeSessionId` — which `canSend` requires.
    useChatSessionsStore.setState({ workspaces: [], sessions: [], recentSessionIds: [] });

    const id = createUnboundChatSession();

    const state = useChatSessionsStore.getState();
    expect(state.sessions[0]?.id).toBe(id);
    expect(state.activeSessionId).toBe(id);
    expect(state.recentSessionIds[0]).toBe(id);
  });

  it('resolves to a null cwd, which is what makes it unbound', () => {
    // `isUnboundSession` in ChatComposer is `Boolean(activeSessionId) && cwd === null`,
    // so this null is the whole mechanism — a session that resolved to some
    // placeholder path would spawn there instead of in its scratch directory.
    useChatSessionsStore.setState({ workspaces: [], sessions: [] });

    const id = createUnboundChatSession();
    const state = useChatSessionsStore.getState();

    expect(
      resolveSendCwd({
        activeSessionId: id,
        sessions: state.sessions,
        workspaces: state.workspaces,
      })
    ).toBeNull();
  });

  it('carries no workspacePath — the scratch directory is allocated on first send', () => {
    // U13's `unbound.workspacePath` is a RESUME handle for a directory that
    // already exists. Setting it at creation time would name a directory Main
    // has not made yet, which is the fake-cwd failure U13 exists to prevent.
    useChatSessionsStore.setState({ workspaces: [], sessions: [] });

    createUnboundChatSession();

    const session = useChatSessionsStore.getState().sessions[0];
    expect(session?.workspaceId).toBe('');
    expect(session?.projectId).toBe('');
    expect(session?.unbound).toBeUndefined();
  });

  it('keeps existing sessions and does not disturb an existing workspace', () => {
    const ws = makeWorkspace({ id: 'ws-a', path: '/a' });
    const existing = makeSession({ id: 'existing', workspaceId: 'ws-a' });
    useChatSessionsStore.setState({ workspaces: [ws], sessions: [existing] });

    const id = createUnboundChatSession();

    const state = useChatSessionsStore.getState();
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions[1]).toBe(existing);
    expect(state.workspaces).toEqual([ws]);
    expect(
      resolveSendCwd({
        activeSessionId: 'existing',
        sessions: state.sessions,
        workspaces: state.workspaces,
      })
    ).toBe('/a');
    expect(id).not.toBe('existing');
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

describe('/new inherits only the directory', () => {
  it.each([
    'main',
    'worktree',
    'temp',
  ] as const)('inherits a %s workspace without modifying old context', (kind) => {
    const workspace = makeWorkspace({ kind });
    const old = makeSession({ runtimeIdentity: '/old.jsonl' });
    useChatSessionsStore.setState({
      workspaces: [workspace],
      sessions: [old],
      activeSessionId: old.id,
    });
    const id = createChatSessionInCurrentDirectory();
    const state = useChatSessionsStore.getState();
    expect(id).not.toBe(old.id);
    expect(state.sessions.find((session) => session.id === id)).toMatchObject({
      workspaceId: workspace.id,
      status: 'idle',
    });
    expect(state.sessions.find((session) => session.id === id)?.runtimeIdentity).toBeUndefined();
    expect(state.messages[id!]).toBeUndefined();
    expect(state.sessions.find((session) => session.id === old.id)).toBe(old);
  });
  it('inherits restored unbound cwd and creates an unbound chat when no cwd exists', () => {
    const old = makeSession({
      workspaceId: '',
      projectId: '',
      unbound: { workspacePath: 'C:\\scratch\\old' },
    });
    useChatSessionsStore.setState({ sessions: [old], activeSessionId: old.id });
    const id = createChatSessionInCurrentDirectory();
    expect(useChatSessionsStore.getState().sessions.find((s) => s.id === id)?.unbound).toEqual(
      old.unbound
    );
    useChatSessionsStore.setState({ sessions: [], activeSessionId: null });
    const empty = createChatSessionInCurrentDirectory();
    expect(
      useChatSessionsStore.getState().sessions.find((s) => s.id === empty)?.unbound
    ).toBeUndefined();
  });
  it.each([
    'starting',
    'running',
    'stopping',
    'waiting_permission',
    'waiting_question',
  ] as const)('refuses %s without changing the current session', (status) => {
    const old = makeSession({ status });
    useChatSessionsStore.setState({ sessions: [old], activeSessionId: old.id });
    expect(createChatSessionInCurrentDirectory()).toBeNull();
    expect(useChatSessionsStore.getState().activeSessionId).toBe(old.id);
  });
  it('refuses a send before the running event', () =>
    expect(createChatSessionInCurrentDirectory(true)).toBeNull());
});
