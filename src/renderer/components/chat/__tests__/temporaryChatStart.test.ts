// @vitest-environment happy-dom
/**
 * dsh-rebase decision 176, GUI point-check fix (2026-10-11): every entry that
 * starts a conversation on a send's behalf, over a temporary chat
 * (「不选仓库（临时对话）」) the engine let go — wired to this window's real
 * store and `sessionStartEffects`, so the snapshot, the scratch directory and
 * the resume are the app's own.
 *
 * A temporary chat made in this run carries no record of its scratch
 * directory: `session.unbound` is written by a restart's index merge or by a
 * fork, never by `createUnboundChatSession`. The send path asks for the
 * directory (`useScratchWorkspaceStore.ensure`); the start and the history
 * card's Retry read the session alone and refused it as having no folder.
 * `/compact` is mounted in `compactStartMount.test.ts`; here are the goal bar,
 * the session tree (its rewind and fork share the tree's start) and the card.
 *
 * The `electronAPI` stub is hoisted: persisted stores rehydrate at import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => {
  const chat = {
    ensureHost: vi.fn(async () => ({ state: 'ready' })),
    resumeSession: vi.fn(async () => ({ requestId: 'resume-1' })),
    ensureScratchWorkspace: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      path: `/tmp/scratch/${sessionId}`,
    })),
    runSessionCommand: vi.fn(async () => ({ ok: true })),
    getSessionTree: vi.fn(async () => ({ sessionKey: 't1:key', requestSequence: 1 })),
  };
  window.electronAPI = {
    env: { platform: 'linux', HOME: '/home/test' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined },
    chat: { onRuntimeEvent: () => () => undefined, ...chat },
  } as unknown as typeof window.electronAPI;
  return chat;
});

vi.mock('@/stores/settings', () => {
  const state = { chatAgentDefaults: undefined };
  return {
    useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});

import { type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';
import { useScratchWorkspaceStore } from '@/stores/scratchWorkspace';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { resumeSessionById } from '../sessionIndex/useResumeSession';
import { runWithSessionStarted } from '../sessionStart';
import { sessionStartEffects } from '../sessionStartDeps';

const STUB = '/dsh-home/aiclient-sessions/aiclient-t1.dsh.json';

/** A temporary chat that has run, as `createUnboundChatSession` and a first send leave it. */
function temporary(extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 't1',
    projectId: '',
    workspaceId: '',
    title: 'Temporary chat',
    status: 'idle',
    updatedAt: 1,
    runtimeIdentity: STUB,
    ...extra,
  };
}

function setStore(session: ChatSession) {
  useChatSessionsStore.setState({
    activeSessionId: session.id,
    sessions: [session],
    workspaces: [],
    messages: {},
    // Reclaimed: the engine does not run it.
    hostBoundSessionIds: [],
    historyErrors: {},
    lastError: null,
  } as never);
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear();
  localStorage.clear();
  useScratchWorkspaceStore.setState({ pathsBySession: {} });
  useSessionPanelsStore.setState({ commandPending: {}, commandStarting: {} });
  setStore(temporary());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('a temporary chat made in this run, reclaimed (no record, no folder)', () => {
  it('[TC-01] the goal bar: started in the scratch directory its first send got, then the command runs', async () => {
    useScratchWorkspaceStore.setState({ pathsBySession: { t1: '/tmp/scratch/t1-first-send' } });
    const outcome = await useSessionPanelsStore
      .getState()
      .runGoalCommand('t1', '/goal pause', sessionStartEffects);

    expect(outcome).toEqual({ kind: 'done', value: { ok: true }, started: true });
    expect(api.ensureScratchWorkspace).not.toHaveBeenCalled();
    expect(api.resumeSession).toHaveBeenCalledWith({
      sessionId: 't1',
      runtimeIdentity: STUB,
      workspacePath: '/tmp/scratch/t1-first-send',
    });
    expect(api.runSessionCommand).toHaveBeenCalledWith({ sessionId: 't1', line: '/goal pause' });
    expect(useChatSessionsStore.getState().hostBoundSessionIds).toContain('t1');
  });

  it('[TC-02] the session tree (rewind and fork start the same way): its directory asked of Main as a send asks', async () => {
    const result = await runWithSessionStarted({
      sessionId: 't1',
      operation: () =>
        window.electronAPI.chat.getSessionTree({ sessionId: 't1', requestSequence: 1 }),
      ...sessionStartEffects,
    });

    expect(result.kind).toBe('done');
    expect(api.ensureScratchWorkspace).toHaveBeenCalledWith({ sessionId: 't1' });
    expect(api.resumeSession).toHaveBeenCalledWith({
      sessionId: 't1',
      runtimeIdentity: STUB,
      workspacePath: '/tmp/scratch/t1',
    });
    expect(api.getSessionTree).toHaveBeenCalledTimes(1);
  });

  it('[TC-03] the history card’s Retry reopens it in the same directory', async () => {
    useScratchWorkspaceStore.setState({ pathsBySession: { t1: '/tmp/scratch/t1-first-send' } });
    await expect(resumeSessionById('t1')).resolves.toBe(true);
    expect(api.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 't1', workspacePath: '/tmp/scratch/t1-first-send' })
    );
  });
});

describe('a temporary chat reopened after a restart (`unbound` recorded)', () => {
  it('[TC-04] every entry uses the recorded directory and asks Main for none', async () => {
    setStore(temporary({ unbound: { workspacePath: '/tmp/scratch/t1-recorded' } }));
    const outcome = await useSessionPanelsStore
      .getState()
      .runGoalCommand('t1', '/goal resume', sessionStartEffects);
    expect(outcome).toMatchObject({ kind: 'done', started: true });
    await expect(resumeSessionById('t1')).resolves.toBe(true);

    expect(api.ensureScratchWorkspace).not.toHaveBeenCalled();
    expect(api.resumeSession).toHaveBeenCalledTimes(2);
    for (const [args] of api.resumeSession.mock.calls as unknown as [{ workspacePath: string }][]) {
      expect(args.workspacePath).toBe('/tmp/scratch/t1-recorded');
    }
  });
});
