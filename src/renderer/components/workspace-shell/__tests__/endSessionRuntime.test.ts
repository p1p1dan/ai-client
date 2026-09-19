import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatProject, ChatWorkspace } from '@/stores/chatSessions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { endSessionRuntime } from '../endSessionRuntime';
import { buildSidebarFolders } from '../sidebarTree';

/**
 * Ending a conversation stops its run and keeps everything else.
 *
 * The halves are tested together because each one alone is a bug the user
 * reported: detaching without keeping the row is the dock's Close; keeping the
 * row without detaching is what the tab strip shipped with (the conversation
 * kept running in the background after the user closed it); and dropping the
 * transcript — T092 — blanked the pane the user was still reading.
 */

/** One hydrated history row plus one live reply — what the user is reading. */
const TIMELINE: ChatMessage[] = [
  {
    id: 'h:1',
    sessionId: 's1',
    role: 'user',
    blocks: [{ id: 'h:1:0', type: 'text', text: 'what changed here?' }],
  },
  {
    id: 'm-2',
    sessionId: 's1',
    role: 'assistant',
    blocks: [{ id: 'm-2:0', type: 'text', text: 'the parser moved' }],
  },
];

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
    messages: { s1: [...TIMELINE], s2: [] },
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

describe('endSessionRuntime', () => {
  it('detaches the runtime and reports the acknowledgement', async () => {
    const api = stubChat(Promise.resolve({ requestId: 'req-1' }));

    await expect(endSessionRuntime('s1')).resolves.toBe(true);

    expect(api.closeSession).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('keeps the row in the dock so the conversation can be reopened', async () => {
    stubChat(Promise.resolve({ requestId: 'req-1' }));

    await endSessionRuntime('s1');

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

  it('keeps the timeline so the ended conversation is still readable', async () => {
    stubChat(Promise.resolve({ requestId: 'req-1' }));

    await endSessionRuntime('s1');

    const state = useChatSessionsStore.getState();
    // T092: the transcript survives. What goes is the read cursor around it —
    // pagination and branch revision describe a live read, and with no worker
    // attached "Load earlier messages" is disabled by status anyway.
    expect(state.messages.s1).toEqual(TIMELINE);
    expect(state.hostBoundSessionIds).toEqual(['s2']);
    expect(state.historyErrors.s1).toBeUndefined();
    expect(state.historyPagination?.s1).toBeUndefined();
    expect(state.historyBranchRevisions?.s1).toBeUndefined();
    // A neighbour's state is untouched.
    expect(state.messages.s2).toEqual([]);
  });

  it('keeps the timeline visible for the session the user is still looking at', async () => {
    stubChat(Promise.resolve({ requestId: 'req-1' }));

    // The reported defect exactly: ending from the context menu does not move
    // the user anywhere, so whatever this leaves in `messages` is what the open
    // pane paints. It used to leave nothing, and the pane said "No messages
    // yet" over a conversation the user had just been reading.
    await endSessionRuntime('s1');

    const state = useChatSessionsStore.getState();
    expect(state.activeSessionId).toBe('s1');
    expect(state.messages[state.activeSessionId ?? '']).toEqual(TIMELINE);
  });

  it('still detaches the host binding so the next send re-opens the runtime', async () => {
    const api = stubChat(Promise.resolve({ requestId: 'req-1' }));

    await endSessionRuntime('s1');

    const state = useChatSessionsStore.getState();
    // Keeping the transcript must not cost the detach: a stale host binding
    // would send the next turn to a worker that no longer exists. The identity
    // is what lets that send resume the ORIGINAL session file.
    expect(api.closeSession).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(state.hostBoundSessionIds).not.toContain('s1');
    expect(state.sessions.find((item) => item.id === 's1')?.runtimeIdentity).toBe(
      '/sessions/s1.jsonl'
    );
  });

  it('parks the row at a status a later resume is allowed to run from', async () => {
    stubChat(Promise.resolve({ requestId: 'req-1' }));

    await endSessionRuntime('s1');

    expect(useChatSessionsStore.getState().sessions[0]?.status).toBe('disconnected');
  });

  it('still resets local state when the detach IPC fails', async () => {
    stubChat(Promise.reject(new Error('host down')));

    await expect(endSessionRuntime('s1')).resolves.toBe(false);

    const state = useChatSessionsStore.getState();
    expect(state.hostBoundSessionIds).toEqual(['s2']);
    expect(state.messages.s1).toEqual(TIMELINE);
    expect(state.sessions.find((item) => item.id === 's1')).toBeDefined();
  });
});
