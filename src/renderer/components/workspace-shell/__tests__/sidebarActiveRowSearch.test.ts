// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';

/**
 * T091, rendered for real: a title search never hides the conversation that is
 * currently open.
 *
 * `sidebarTree.test.ts` pins the rule inside `matchesQuery`. This file pins the
 * half that rule cannot see — that LeftNav actually HANDS it `activeSessionId`
 * at all three derivations (folders, temporary chats, Recent). The defect it
 * guards was reported as "New did nothing": with a search active, the new chat
 * is titled `New chat`, the query does not match it, and the row the click was
 * supposed to produce never appeared.
 *
 * Everything LeftNav pulls in that is not the sidebar is stubbed, same as
 * `sidebarContextMenuInteraction.test.ts`: the persisted index (IPC), session
 * activation (starts a worker) and the diff-stats poller (timer + IPC).
 */

vi.hoisted(() => {
  // Must be hoisted: stores rehydrate from `electronAPI` at import time, and a
  // stub installed in `beforeEach` arrives after that read.
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
  } as unknown as typeof window.electronAPI;
});

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/components/chat/sessionIndex/useSessionIndex', () => ({
  useSessionIndex: () => ({ refresh: async () => {}, loading: false, error: null }),
  useSessionIndexMutations: () => ({
    rename: async () => {},
    archive: async () => {},
    archiveMany: async () => {},
    close: async () => {},
  }),
}));
vi.mock('@/components/workspace-shell/useActivateSession', () => ({
  useActivateSession: () => (sessionId: string) =>
    useChatSessionsStore.getState().selectSession(sessionId),
}));
vi.mock('@/components/workspace-shell/useFolderDiffStats', () => ({
  useFolderDiffStatsPolling: () => {},
}));

const { LeftNav } = await import('../LeftNav');

const PROJECT_ID = 'project:/repo/alpha';
const REPO = { id: PROJECT_ID, path: '/repo/alpha', name: 'alpha' };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useChatSessionsStore.setState({
    projects: [{ id: PROJECT_ID, name: 'alpha' }],
    workspaces: [
      { id: 'ws-1', projectId: PROJECT_ID, name: 'Main', kind: 'main', path: '/repo/alpha' },
    ],
    sessions: [
      {
        id: 'session-open',
        projectId: PROJECT_ID,
        workspaceId: 'ws-1',
        title: 'Untitled chat',
        status: 'idle',
        updatedAt: Date.now(),
      },
      {
        id: 'session-other',
        projectId: PROJECT_ID,
        workspaceId: 'ws-1',
        title: 'Parser rewrite',
        status: 'idle',
        updatedAt: Date.now(),
      },
    ],
    activeSessionId: 'session-open',
    hostBoundSessionIds: [],
    unreadSessionIds: [],
    pendingPermissions: [],
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function typeSearch(text: string): Promise<void> {
  const input = [...container.querySelectorAll('input')].find(
    (node) => node.getAttribute('placeholder') === 'Search sessions'
  );
  expect(input, 'the sidebar search box is rendered').toBeTruthy();
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, text);
    (input as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** How many sidebar rows carry this title (Recent and the tree both list it). */
function rowsTitled(title: string): number {
  return [...container.querySelectorAll('[role="button"]')].filter((node) =>
    node.textContent?.includes(title)
  ).length;
}

it('keeps the active session in the sidebar when the query does not match its title', async () => {
  await act(async () => root.render(createElement(LeftNav, { repositories: [REPO] as never })));
  expect(rowsTitled('Untitled chat')).toBe(2);

  await typeSearch('parser');

  // The query matches the other row only — and the open conversation is still
  // listed, because a filter over a list is not a statement about which
  // conversation is open. Two rows, not one: the count is what proves BOTH
  // derivations were given `activeSessionId` (the folder tree and Recent).
  expect(rowsTitled('Parser rewrite')).toBe(2);
  expect(rowsTitled('Untitled chat')).toBe(2);

  // Same query, same rows, only "is it open" differs: the filter really is
  // doing its job, which is what makes the assertion above meaningful.
  await act(async () => {
    useChatSessionsStore.setState({ activeSessionId: null });
  });
  expect(rowsTitled('Parser rewrite')).toBe(2);
  expect(rowsTitled('Untitled chat')).toBe(0);
});

it('keeps an active temporary chat in its own partition too', async () => {
  // The third derivation (`buildUnboundFolder`). A temporary chat is the most
  // likely row to be missing a title a query could match — it is exactly the
  // "New chat" the report was about — and it is listed nowhere else but here
  // and Recent, so the second row can only be the partition's.
  useChatSessionsStore.setState({
    sessions: [
      {
        id: 'session-temp',
        projectId: '',
        workspaceId: '',
        title: 'Untitled chat',
        status: 'idle',
        updatedAt: Date.now(),
        unbound: { workspacePath: '/tmp/scratch' },
      },
      {
        id: 'session-other',
        projectId: PROJECT_ID,
        workspaceId: 'ws-1',
        title: 'Parser rewrite',
        status: 'idle',
        updatedAt: Date.now(),
      },
    ],
    activeSessionId: 'session-temp',
  });
  await act(async () => root.render(createElement(LeftNav, { repositories: [REPO] as never })));

  await typeSearch('parser');

  expect(container.textContent).toContain('Temporary chats');
  expect(rowsTitled('Untitled chat')).toBe(2);

  await act(async () => {
    useChatSessionsStore.setState({ activeSessionId: null });
  });
  expect(rowsTitled('Untitled chat')).toBe(0);
});
