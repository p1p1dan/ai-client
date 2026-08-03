import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatSession, type ChatWorkspace, useChatSessionsStore } from '@/stores/chatSessions';
import { mergeSessionIndex } from '../sessionIndexMerge';
import {
  applySessionIndexRefresh,
  archiveSessionIndexEntry,
  closeSessionAndRemoveRow,
  dropDismissedSessions,
  registerSessionIndexEntry,
  resetDismissedSessionRows,
} from '../useSessionIndex';

/**
 * R5 D2 — Archive / Close on a session that has no `session-index.json`
 * entry yet (the normal state of a chat created in the sidebar that has never
 * sent a message). Both used to be silent no-ops; these cases lock the
 * register-then-retry ladder, the renderer-only fallback, Close's
 * "detach + drop the row for this run" contract, and the TOCTOU guard that
 * keeps a row whose runtime is actually bound.
 */

const workspaces: ChatWorkspace[] = [
  { id: 'ws-1', projectId: 'p1', name: 'Main', kind: 'main', path: '/repo' },
  { id: 'ws-empty', projectId: 'p1', name: 'Seed', kind: 'main', path: '' },
];

function session(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: 'p1',
    workspaceId: 'ws-1',
    title: id,
    status: 'idle',
    updatedAt: 1000,
    ...extra,
  };
}

function entry(sessionId: string): SessionIndexEntry {
  return {
    sessionId,
    workspacePath: '/repo',
    title: sessionId,
    updatedAt: 2000,
    archived: false,
  };
}

interface ChatApiStub {
  archiveSession: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
  registerSession: ReturnType<typeof vi.fn>;
}

function stubChatApi(overrides: Partial<ChatApiStub> = {}): ChatApiStub {
  const api: ChatApiStub = {
    archiveSession: vi.fn().mockResolvedValue(true),
    closeSession: vi.fn().mockResolvedValue({ requestId: 'req-1' }),
    registerSession: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  (globalThis as { window?: unknown }).window = {
    electronAPI: { chat: api },
  } as unknown as typeof globalThis.window;
  return api;
}

function seedStore(
  sessions: ChatSession[],
  extra: Partial<Parameters<typeof useChatSessionsStore.setState>[0]> = {}
) {
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

const refresh = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  resetDismissedSessionRows();
  refresh.mockClear();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('archiveSessionIndexEntry — indexed session (unchanged happy path)', () => {
  it('flips the bit once, never registers, and refreshes', async () => {
    const api = stubChatApi();
    seedStore([session('s1'), session('s2')]);

    await expect(archiveSessionIndexEntry('s1', true, refresh)).resolves.toBe(true);

    expect(api.archiveSession).toHaveBeenCalledTimes(1);
    expect(api.archiveSession).toHaveBeenCalledWith({ sessionId: 's1', archived: true });
    expect(api.registerSession).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('removes the row and hands activeSessionId over BEFORE the refresh (A1)', async () => {
    stubChatApi();
    seedStore([session('s1'), session('s2')], { activeSessionId: 's1' });
    const seen: Array<{ ids: string[]; active: string | null }> = [];
    const observingRefresh = vi.fn().mockImplementation(async () => {
      const state = useChatSessionsStore.getState();
      seen.push({ ids: state.sessions.map((item) => item.id), active: state.activeSessionId });
    });

    await expect(archiveSessionIndexEntry('s1', true, observingRefresh)).resolves.toBe(true);

    // Archiving the session the user is looking at must not leave the Composer
    // pointing at it for the length of the round-trip (or forever, if the
    // refresh fails) — so the handover is already done when refresh runs.
    expect(seen).toEqual([{ ids: ['s2'], active: 's2' }]);
  });

  it('un-archiving neither removes a row nor detaches anything', async () => {
    const api = stubChatApi();
    seedStore([session('s1')], { hostBoundSessionIds: ['s1'] });

    await expect(archiveSessionIndexEntry('s1', false, refresh)).resolves.toBe(true);

    expect(api.closeSession).not.toHaveBeenCalled();
    expect(useChatSessionsStore.getState().sessions.map((item) => item.id)).toEqual(['s1']);
  });
});

describe('archiveSessionIndexEntry — unindexed session (D2 gap A)', () => {
  it('registers the missing entry and retries exactly once', async () => {
    const api = stubChatApi({
      archiveSession: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    });
    seedStore([session('fresh')]);

    await expect(archiveSessionIndexEntry('fresh', true, refresh)).resolves.toBe(true);

    expect(api.registerSession).toHaveBeenCalledWith({
      sessionId: 'fresh',
      workspacePath: '/repo',
    });
    expect(api.archiveSession).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('falls back to a renderer-only removal when the retry also fails', async () => {
    stubChatApi({ archiveSession: vi.fn().mockResolvedValue(false) });
    seedStore([session('fresh'), session('other')]);

    await expect(archiveSessionIndexEntry('fresh', true, refresh)).resolves.toBe(true);

    const state = useChatSessionsStore.getState();
    expect(state.sessions.map((item) => item.id)).toEqual(['other']);
    expect(state.recentSessionIds).toEqual(['other']);
    // No index truth to re-read — the store write is the whole mutation.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('removes the row even when no workspace path can be resolved (no register attempt)', async () => {
    const api = stubChatApi({ archiveSession: vi.fn().mockResolvedValue(false) });
    seedStore([session('fresh', { workspaceId: 'ws-empty' })]);

    await expect(archiveSessionIndexEntry('fresh', true, refresh)).resolves.toBe(true);

    expect(api.registerSession).not.toHaveBeenCalled();
    expect(useChatSessionsStore.getState().sessions).toEqual([]);
  });

  it('keeps the fallback out of the un-archive direction', async () => {
    const api = stubChatApi({ archiveSession: vi.fn().mockResolvedValue(false) });
    seedStore([session('s1')]);

    await expect(archiveSessionIndexEntry('s1', false, refresh)).resolves.toBe(false);

    expect(api.registerSession).not.toHaveBeenCalled();
    expect(useChatSessionsStore.getState().sessions.map((item) => item.id)).toEqual(['s1']);
  });
});

describe('archiveSessionIndexEntry — TOCTOU guard on hostBoundSessionIds', () => {
  it('keeps the row (visible no-op) when the session is Host-bound and the index write fails', async () => {
    stubChatApi({ archiveSession: vi.fn().mockResolvedValue(false) });
    seedStore([session('bound')], { hostBoundSessionIds: ['bound'] });

    await expect(archiveSessionIndexEntry('bound', true, refresh)).resolves.toBe(false);

    expect(useChatSessionsStore.getState().sessions.map((item) => item.id)).toEqual(['bound']);
  });

  it('keeps the row when a persisted runtimeIdentity exists (server truth to preserve)', async () => {
    stubChatApi({ archiveSession: vi.fn().mockResolvedValue(false) });
    seedStore([session('resumed', { runtimeIdentity: 'rt-1' })]);

    await expect(archiveSessionIndexEntry('resumed', true, refresh)).resolves.toBe(false);

    expect(useChatSessionsStore.getState().sessions.map((item) => item.id)).toEqual(['resumed']);
  });

  it('keeps the row when the first send binds the Host DURING the archive round-trip', async () => {
    const api = stubChatApi({
      archiveSession: vi.fn().mockImplementation(async () => {
        // The lazy `chat.createSession` from a concurrent first send lands
        // while our IPC is in flight.
        useChatSessionsStore.setState({ hostBoundSessionIds: ['racing'] });
        return false;
      }),
      registerSession: vi.fn().mockResolvedValue(false),
    });
    seedStore([session('racing')]);

    await expect(archiveSessionIndexEntry('racing', true, refresh)).resolves.toBe(false);

    expect(api.registerSession).toHaveBeenCalledTimes(1);
    expect(useChatSessionsStore.getState().sessions.map((item) => item.id)).toEqual(['racing']);
  });

  it('detaches the runtime when the archive lands but the Host bound the session mid-flight', async () => {
    const api = stubChatApi({
      archiveSession: vi.fn().mockImplementation(async () => {
        useChatSessionsStore.setState({ hostBoundSessionIds: ['racing'] });
        return true;
      }),
    });
    seedStore([session('racing')]);

    await expect(archiveSessionIndexEntry('racing', true, refresh)).resolves.toBe(true);

    expect(api.closeSession).toHaveBeenCalledWith({ sessionId: 'racing' });
  });

  it('detaches a session that was already Host-bound before the click (A2)', async () => {
    const api = stubChatApi();
    seedStore([session('bound')], { hostBoundSessionIds: ['bound'] });

    await archiveSessionIndexEntry('bound', true, refresh);

    // Archive is a permanent exit from the nav, so the gate is "is the Host
    // holding it" — not "did the binding appear during this round-trip".
    // Leaving a runtime with no row to reach or stop it is the worse outcome.
    expect(api.closeSession).toHaveBeenCalledWith({ sessionId: 'bound' });
  });
});

describe('closeSessionAndRemoveRow — detach + drop the row for this run', () => {
  it('detaches the runtime and removes the row', async () => {
    const api = stubChatApi();
    seedStore([session('s1'), session('s2')]);

    await expect(closeSessionAndRemoveRow('s1', refresh)).resolves.toBe(true);

    expect(api.closeSession).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(useChatSessionsStore.getState().sessions.map((item) => item.id)).toEqual(['s2']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('never flips the index archived bit (restart restores the session by design)', async () => {
    const api = stubChatApi();
    seedStore([session('s1')]);

    await closeSessionAndRemoveRow('s1', refresh);

    expect(api.archiveSession).not.toHaveBeenCalled();
  });

  it('still removes the row when the detach IPC throws, reporting the failed detach', async () => {
    stubChatApi({ closeSession: vi.fn().mockRejectedValue(new Error('host down')) });
    seedStore([session('s1'), session('s2')]);

    await expect(closeSessionAndRemoveRow('s1', refresh)).resolves.toBe(false);

    expect(useChatSessionsStore.getState().sessions.map((item) => item.id)).toEqual(['s2']);
  });

  it('drops per-session leftovers with the row', async () => {
    stubChatApi();
    seedStore([session('s1'), session('s2')], {
      messages: { s1: [], s2: [] },
      hostBoundSessionIds: ['s1', 's2'],
      historyErrors: { s1: 'boom' },
      pendingPermissions: [{ sessionId: 's1', permissionId: 'perm-1', messageId: 'm1' }],
      pendingQuestion: { sessionId: 's1', questionId: 'q-1', messageId: 'm1' },
    });

    await closeSessionAndRemoveRow('s1', refresh);

    const state = useChatSessionsStore.getState();
    expect(Object.keys(state.messages)).toEqual(['s2']);
    expect(state.hostBoundSessionIds).toEqual(['s2']);
    expect(state.historyErrors).toEqual({});
    expect(state.pendingPermissions).toEqual([]);
    expect(state.pendingQuestion).toBeNull();
  });
});

describe('activeSessionId handover on removal', () => {
  it('moves to the row that slides into the removed slot', async () => {
    stubChatApi();
    seedStore([session('s1'), session('s2'), session('s3')], { activeSessionId: 's2' });

    await closeSessionAndRemoveRow('s2', refresh);

    expect(useChatSessionsStore.getState().activeSessionId).toBe('s3');
  });

  it('falls back to the previous row when the removed one was last', async () => {
    stubChatApi();
    seedStore([session('s1'), session('s2')], { activeSessionId: 's2' });

    await closeSessionAndRemoveRow('s2', refresh);

    expect(useChatSessionsStore.getState().activeSessionId).toBe('s1');
  });

  it('drops to the empty state (null) when the last session goes', async () => {
    stubChatApi();
    seedStore([session('only')], { activeSessionId: 'only' });

    await closeSessionAndRemoveRow('only', refresh);

    expect(useChatSessionsStore.getState().activeSessionId).toBeNull();
  });

  it('leaves a different active session alone', async () => {
    stubChatApi();
    seedStore([session('s1'), session('s2')], { activeSessionId: 's1' });

    await closeSessionAndRemoveRow('s2', refresh);

    expect(useChatSessionsStore.getState().activeSessionId).toBe('s1');
  });
});

describe('run-scoped dismissal list', () => {
  it('keeps a closed session out of the very next index refresh', async () => {
    stubChatApi();
    seedStore([session('s1'), session('s2')]);

    await closeSessionAndRemoveRow('s1', refresh);

    // Close leaves the index entry in place on purpose, so the merge alone
    // would re-seed the row — the dismissal list is what makes Close stick.
    const merged = mergeSessionIndex(
      useChatSessionsStore.getState().sessions,
      [entry('s1'), entry('s2')],
      { workspaces }
    );
    expect(merged.sessions.map((item) => item.id)).toContain('s1');
    expect(dropDismissedSessions(merged.sessions).map((item) => item.id)).toEqual(['s2']);
  });

  it('keeps an archive-fallback removal out of the next refresh too', async () => {
    stubChatApi({ archiveSession: vi.fn().mockResolvedValue(false) });
    seedStore([session('fresh')]);

    await archiveSessionIndexEntry('fresh', true, refresh);

    const merged = mergeSessionIndex([], [entry('fresh')], { workspaces });
    expect(dropDismissedSessions(merged.sessions)).toEqual([]);
  });

  it('returns the same array when nothing was dismissed', () => {
    const sessions = [session('s1')];
    expect(dropDismissedSessions(sessions)).toBe(sessions);
  });

  it('resets per app run', async () => {
    stubChatApi();
    seedStore([session('s1')]);
    await closeSessionAndRemoveRow('s1', refresh);

    resetDismissedSessionRows();

    expect(dropDismissedSessions([session('s1')]).map((item) => item.id)).toEqual(['s1']);
  });
});

describe('applySessionIndexRefresh — the refresh body, now reachable (A6)', () => {
  it('drops rows dismissed in this run, where the raw merge resurrects them', async () => {
    stubChatApi();
    seedStore([session('s1'), session('s2')]);
    await closeSessionAndRemoveRow('s1', refresh);

    const state = useChatSessionsStore.getState();
    const entries = [entry('s1'), entry('s2')];

    // Negative control — the same merge WITHOUT the dismissal filter, i.e.
    // what a straight-through refresh would write. It brings the closed row
    // straight back, which is what makes the assertion below non-vacuous:
    // Close leaves the index entry in place on purpose.
    const straightThrough = mergeSessionIndex(state.sessions, entries, { workspaces });
    expect(straightThrough.sessions.map((item) => item.id)).toContain('s1');

    const patch = applySessionIndexRefresh(entries, state);
    expect(patch.sessions.map((item) => item.id)).toEqual(['s2']);
    expect(patch.recentSessionIds).toEqual(['s2']);
  });

  it('keeps a never-sent chat that has no index entry at all', () => {
    stubChatApi();
    seedStore([session('fresh')]);

    // Creating a chat no longer registers an index entry (round-2 A3), so the
    // very first refresh after "New" sees zero entries for it. The live-only
    // safety net in mergeSessionIndex is the only thing keeping the row.
    const patch = applySessionIndexRefresh([], useChatSessionsStore.getState());

    expect(patch.sessions.map((item) => item.id)).toEqual(['fresh']);
  });

  it('re-derives Recent from the surviving rows, newest first', () => {
    stubChatApi();
    seedStore([session('old', { updatedAt: 10 })]);

    const patch = applySessionIndexRefresh(
      [{ ...entry('newer'), updatedAt: 5000 }, entry('old')],
      useChatSessionsStore.getState()
    );

    expect(patch.recentSessionIds).toEqual(['newer', 'old']);
  });
});

describe('registerSessionIndexEntry', () => {
  it('forwards sessionId + workspacePath and returns the Main-side result', async () => {
    const api = stubChatApi({ registerSession: vi.fn().mockResolvedValue(true) });

    await expect(registerSessionIndexEntry('s1', '/repo')).resolves.toBe(true);
    expect(api.registerSession).toHaveBeenCalledWith({ sessionId: 's1', workspacePath: '/repo' });
  });

  it('short-circuits on an empty workspace path', async () => {
    const api = stubChatApi();

    await expect(registerSessionIndexEntry('s1', '')).resolves.toBe(false);
    expect(api.registerSession).not.toHaveBeenCalled();
  });

  it('tolerates a rejecting IPC', async () => {
    stubChatApi({ registerSession: vi.fn().mockRejectedValue(new Error('nope')) });

    await expect(registerSessionIndexEntry('s1', '/repo')).resolves.toBe(false);
  });

  it('tolerates a preload without the channel (older bridge)', async () => {
    (globalThis as { window?: unknown }).window = {
      electronAPI: { chat: {} },
    } as unknown as typeof globalThis.window;

    await expect(registerSessionIndexEntry('s1', '/repo')).resolves.toBe(false);
  });
});
