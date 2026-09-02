import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveSessionIndexEntry,
  closeSessionAndRemoveRow,
  resetDismissedSessionRows,
} from '@/components/chat/sessionIndex/useSessionIndex';
import { createChatSessionOnWorkspace } from '@/stores/chatSessionActions';
import type { ChatProject, ChatWorkspace } from '@/stores/chatSessions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { buildSidebarFolders, deriveRecentRows } from '../sidebarTree';

/**
 * R5 D2 regression: a freshly created chat (never sent a message, so no
 * `session-index.json` entry) must disappear from BOTH sidebar derivations
 * after Archive and after Close. Before D2 the click was a silent no-op and
 * the row stayed put.
 */

const projects: ChatProject[] = [{ id: 'p-ai', name: 'ai-client' }];
const workspaces: ChatWorkspace[] = [
  { id: 'ws-main', projectId: 'p-ai', name: 'Main', kind: 'main', path: '/repo', branch: 'main' },
];

const refresh = vi.fn().mockResolvedValue(undefined);

function stubChat(archiveResult: boolean) {
  const api = {
    archiveSession: vi.fn().mockResolvedValue(archiveResult),
    closeSession: vi.fn().mockResolvedValue({ requestId: 'req-1' }),
    registerSession: vi.fn().mockResolvedValue(true),
  };
  (globalThis as { window?: unknown }).window = {
    electronAPI: { chat: api },
  } as unknown as typeof globalThis.window;
  return api;
}

function rowIds(): { folder: string[]; recent: string[] } {
  const state = useChatSessionsStore.getState();
  const now = Date.now();
  return {
    folder:
      buildSidebarFolders({
        projects,
        workspaces,
        sessions: state.sessions,
      })[0]?.rows.map((row) => row.sessionId) ?? [],
    recent: deriveRecentRows({ sessions: state.sessions, workspaces, now }).rows.map(
      (row) => row.sessionId
    ),
  };
}

beforeEach(() => {
  resetDismissedSessionRows();
  refresh.mockClear();
  useChatSessionsStore.setState({
    projects,
    workspaces,
    sessions: [],
    messages: {},
    activeSessionId: null,
    recentSessionIds: [],
    hostBoundSessionIds: [],
    pendingPermissions: [],
    pendingQuestion: null,
    lastError: null,
    historyErrors: {},
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('freshly created session — sidebar row lifecycle', () => {
  it('creates the row without writing to the index (R5 round-2: no eager registration)', () => {
    const api = stubChat(true);

    const sessionId = createChatSessionOnWorkspace('ws-main');

    expect(sessionId).not.toBeNull();
    // D2 registered here; that was reverted — every "New" click otherwise left
    // a permanent empty-titled entry in `session-index.json`. The row's
    // visibility rests on mergeSessionIndex's live-only safety net instead.
    expect(api.registerSession).not.toHaveBeenCalled();
    expect(rowIds().folder).toEqual([sessionId]);
  });

  it('Archive of an unregistered row registers on demand, then takes the live-only fallback', async () => {
    // Main returns false for both the first call and the post-register retry:
    // the worst case, where only the renderer-side fallback can honour the click.
    const api = stubChat(false);
    const sessionId = createChatSessionOnWorkspace('ws-main');
    expect(rowIds().folder).toEqual([sessionId]);

    await expect(archiveSessionIndexEntry(sessionId as string, true, refresh)).resolves.toBe(true);

    // S2 (b): the on-demand register is the only index write a never-sent
    // session ever gets. Chat is Pi-only, so Main supplies the binding —
    // the renderer sends identity and location, nothing more.
    expect(api.registerSession).toHaveBeenCalledWith({
      sessionId,
      workspacePath: '/repo',
    });
    expect(api.archiveSession).toHaveBeenCalledTimes(2);
    expect(rowIds()).toEqual({ folder: [], recent: [] });
    // Nothing landed in the index, so there is no index truth to re-read.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Archive removes the row when the post-register retry succeeds', async () => {
    const api = stubChat(false);
    api.archiveSession.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const sessionId = createChatSessionOnWorkspace('ws-main');

    await expect(archiveSessionIndexEntry(sessionId as string, true, refresh)).resolves.toBe(true);

    // A1: the success path drops the row itself, before the refresh. This
    // suite stubs `refresh`, so a hand-rolled filter here (what this case used
    // to do) would have hidden a success path that never removed anything.
    expect(rowIds()).toEqual({ folder: [], recent: [] });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('Close removes the row from folder + Recent', async () => {
    const api = stubChat(true);
    const sessionId = createChatSessionOnWorkspace('ws-main');

    await closeSessionAndRemoveRow(sessionId as string, refresh);

    expect(api.closeSession).toHaveBeenCalledWith({ sessionId });
    expect(rowIds()).toEqual({ folder: [], recent: [] });
  });

  it('removing one of two sessions leaves the other row intact', async () => {
    stubChat(true);
    const first = createChatSessionOnWorkspace('ws-main', 'first');
    // Ids are `session-${Date.now()}`; keep the second distinct.
    useChatSessionsStore.setState({
      sessions: useChatSessionsStore
        .getState()
        .sessions.map((item) => (item.id === first ? { ...item, id: 'session-first' } : item)),
    });
    const second = createChatSessionOnWorkspace('ws-main', 'second');

    await closeSessionAndRemoveRow(second as string, refresh);

    expect(rowIds().folder).toEqual(['session-first']);
  });
});
