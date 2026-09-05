import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatProject, ChatWorkspace } from '@/stores/chatSessions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { endSessionForTab } from '../closeSessionTab';
import { buildSidebarFolders } from '../sidebarTree';

/**
 * Closing a center tab ends the conversation but keeps its row.
 *
 * The two halves are tested together because either one alone is a bug the
 * user reported: detaching without keeping the row is the dock's Close, and
 * keeping the row without detaching is what the tab strip shipped with — the
 * conversation kept running in the background after the user closed it.
 */

const projects: ChatProject[] = [{ id: 'p-ai', name: 'ai-client' }];
const workspaces: ChatWorkspace[] = [
  { id: 'ws-main', projectId: 'p-ai', name: 'Main', kind: 'main', path: '/repo', branch: 'main' },
];

function stubChat(closeResult: Promise<unknown>) {
  const api = { closeSession: vi.fn().mockReturnValue(closeResult) };
  (globalThis as { window?: unknown }).window = {
    electronAPI: { chat: api },
  } as unknown as typeof globalThis.window;
  return api;
}

function seedSession() {
  useChatSessionsStore.setState({
    projects,
    workspaces,
    sessions: [
      {
        id: 's1',
        projectId: 'p-ai',
        workspaceId: 'ws-main',
        title: 'Live one',
        status: 'running',
        updatedAt: Date.now(),
        runtimeIdentity: '/sessions/s1.jsonl',
      },
    ],
    messages: { s1: [], s2: [] },
    hostBoundSessionIds: ['s1', 's2'],
    historyErrors: { s1: 'read_failed: boom' },
    historyPagination: { s1: { nextOffset: 20, hydratedCount: 20, totalCount: 60, hasMore: true } },
    historyBranchRevisions: { s1: 4 },
    activeSessionId: 's1',
  });
}

beforeEach(() => {
  seedSession();
});

describe('endSessionForTab', () => {
  it('detaches the runtime and reports the acknowledgement', async () => {
    const api = stubChat(Promise.resolve({ requestId: 'req-1' }));

    await expect(endSessionForTab('s1')).resolves.toBe(true);

    expect(api.closeSession).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('keeps the row in the dock so the conversation can be reopened', async () => {
    stubChat(Promise.resolve({ requestId: 'req-1' }));

    await endSessionForTab('s1');

    const state = useChatSessionsStore.getState();
    const session = state.sessions.find((item) => item.id === 's1');
    expect(session).toBeDefined();
    expect(session?.runtimeIdentity).toBe('/sessions/s1.jsonl');
    expect(
      buildSidebarFolders({ projects, workspaces, sessions: state.sessions })[0]?.rows.map(
        (row) => row.sessionId
      )
    ).toEqual(['s1']);
  });

  it('clears exactly the state that would make a reopen skip the resume', async () => {
    stubChat(Promise.resolve({ requestId: 'req-1' }));

    await endSessionForTab('s1');

    const state = useChatSessionsStore.getState();
    // `useActivateSession` resumes only when the timeline is empty, and
    // `sendMessage` skips createSession while the id is still host-bound.
    expect(state.messages.s1).toBeUndefined();
    expect(state.hostBoundSessionIds).toEqual(['s2']);
    expect(state.historyErrors.s1).toBeUndefined();
    expect(state.historyPagination?.s1).toBeUndefined();
    expect(state.historyBranchRevisions?.s1).toBeUndefined();
    // A neighbour's state is untouched.
    expect(state.messages.s2).toEqual([]);
  });

  it('parks the row at a status a later resume is allowed to run from', async () => {
    stubChat(Promise.resolve({ requestId: 'req-1' }));

    await endSessionForTab('s1');

    expect(useChatSessionsStore.getState().sessions[0]?.status).toBe('disconnected');
  });

  it('still resets local state when the detach IPC fails', async () => {
    stubChat(Promise.reject(new Error('host down')));

    await expect(endSessionForTab('s1')).resolves.toBe(false);

    const state = useChatSessionsStore.getState();
    expect(state.hostBoundSessionIds).toEqual(['s2']);
    expect(state.messages.s1).toBeUndefined();
    expect(state.sessions.find((item) => item.id === 's1')).toBeDefined();
  });
});
