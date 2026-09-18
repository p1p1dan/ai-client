/**
 * TUI `/new` — the one row the renderer does not ask for.
 *
 * Main indexes the chats pi created inside a terminal once that terminal is
 * dead (`main/ipc/piTui.ts`). `session-index.json` is otherwise pull-only — read
 * on mount and after this side's own mutations — so without the subscription
 * under test the chat sits in the index, correct and invisible, until something
 * unrelated refreshes the sidebar.
 */

import { PI_AGENT } from '@shared/types/agentWire';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { resetSessionRetirementForTests } from '@/stores/sessionRetirement';
import { resetDismissedSessionRows, subscribeToTerminalCreatedSessions } from '../useSessionIndex';

const indexedChat: SessionIndexEntry = {
  sessionId: 'tui-new-1',
  runtimeIdentity: '/repo/sessions/2026-09-18T10-00-00-000Z_new.jsonl',
  workspacePath: '/repo',
  title: 'started with /new',
  updatedAt: 3000,
  archived: false,
  agent: PI_AGENT,
};

/** The preload bridge, with the push channel Main announces new rows on. */
function stubApi(options: { withChannel?: boolean } = {}) {
  const listeners: Array<() => void> = [];
  const onSessionsIndexed = vi.fn((callback: () => void) => {
    listeners.push(callback);
    return () => {
      const at = listeners.indexOf(callback);
      if (at >= 0) listeners.splice(at, 1);
    };
  });
  const listSessions = vi.fn().mockResolvedValue([indexedChat]);
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      chat: { listSessions },
      piTui: options.withChannel === false ? {} : { onSessionsIndexed },
    },
  } as unknown as typeof globalThis.window;
  return { listeners, onSessionsIndexed, listSessions };
}

beforeEach(() => {
  resetDismissedSessionRows();
  resetSessionRetirementForTests();
  useChatSessionsStore.setState({
    projects: [{ id: 'p1', name: 'repo' }],
    workspaces: [{ id: 'ws-1', projectId: 'p1', name: 'Main', kind: 'main', path: '/repo' }],
    sessions: [],
    messages: {},
    activeSessionId: null,
    recentSessionIds: [],
    hostBoundSessionIds: [],
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
    historyErrors: {},
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

it('re-reads the index when Main says it added a terminal-created chat', async () => {
  const api = stubApi();
  subscribeToTerminalCreatedSessions();

  // Subscribing alone must not cost a read; the mount hydration already did one.
  expect(api.listSessions).not.toHaveBeenCalled();
  for (const listener of api.listeners) listener();

  await vi.waitFor(() =>
    expect(useChatSessionsStore.getState().sessions.map((item) => item.id)).toEqual(['tui-new-1'])
  );
  expect(useChatSessionsStore.getState().sessions[0]).toMatchObject({
    title: 'started with /new',
    workspaceId: 'ws-1',
    runtimeIdentity: indexedChat.runtimeIdentity,
  });
});

it('stops listening when the sidebar unmounts', () => {
  const api = stubApi();

  subscribeToTerminalCreatedSessions()();

  expect(api.listeners).toEqual([]);
});

it('is a no-op on a preload that predates the channel', () => {
  stubApi({ withChannel: false });

  // A mount must not throw because the bridge is older than the renderer.
  expect(() => subscribeToTerminalCreatedSessions()()).not.toThrow();
});
