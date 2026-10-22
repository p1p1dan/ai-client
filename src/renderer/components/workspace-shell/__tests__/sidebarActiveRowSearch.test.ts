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
 * at every derivation (the repository groups and Temporary chats — decision
 * 170 retired Recent and decision 183 「正在活动」). The defect it
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
  // Layout 5b: the filter field shows once asked for — from the list menu a
  // group heading carries.
  if (!container.querySelector('input[placeholder="Search sessions"]')) {
    const trigger = container.querySelector<HTMLElement>('[aria-label="Group and filter chats"]');
    expect(trigger, 'the list menu is rendered').toBeTruthy();
    await act(async () => trigger?.click());
    const item = [...document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')].find(
      (node) => node.textContent?.trim() === 'Filter chats'
    );
    await act(async () => item?.click());
  }
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

/** How many sidebar rows carry this title (since decision 183 a chat is listed once). */
function rowsTitled(title: string): number {
  return [...container.querySelectorAll('[role="button"]')].filter((node) =>
    node.textContent?.includes(title)
  ).length;
}

it('keeps the active session in the sidebar when the query does not match its title', async () => {
  await act(async () => root.render(createElement(LeftNav, { repositories: [REPO] as never })));
  expect(rowsTitled('Untitled chat')).toBe(1);

  await typeSearch('parser');

  // The query matches the other row only — and the open conversation is still
  // listed, because a filter over a list is not a statement about which
  // conversation is open. (Neither chat is started, so the folder tree is the
  // one list here; the started case is the last test below.)
  expect(rowsTitled('Parser rewrite')).toBe(1);
  expect(rowsTitled('Untitled chat')).toBe(1);

  // Same query, same rows, only "is it open" differs: the filter really is
  // doing its job, which is what makes the assertion above meaningful.
  await act(async () => {
    useChatSessionsStore.setState({ activeSessionId: null });
  });
  expect(rowsTitled('Parser rewrite')).toBe(1);
  expect(rowsTitled('Untitled chat')).toBe(0);
});

it('keeps an active temporary chat in its own partition too', async () => {
  // The third derivation (`buildUnboundFolder`). A temporary chat is the most
  // likely row to be missing a title a query could match — it is exactly the
  // "New chat" the report was about — and, not started, it is listed nowhere
  // else, so the row can only be the partition's.
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
  expect(rowsTitled('Untitled chat')).toBe(1);

  await act(async () => {
    useChatSessionsStore.setState({ activeSessionId: null });
  });
  expect(rowsTitled('Untitled chat')).toBe(0);
});

it('lists an active, started chat once — in its folder — and keeps it there under a query', async () => {
  // Decision 183 retired 「正在活动」 (the fourth derivation): a started chat
  // is no longer listed twice. It stays in its folder, marked by the
  // background ring, and the folder still exempts it from the query.
  useChatSessionsStore.setState({ hostBoundSessionIds: ['session-open'] });
  await act(async () => root.render(createElement(LeftNav, { repositories: [REPO] as never })));
  expect(rowsTitled('Untitled chat')).toBe(1);
  expect(container.textContent).not.toContain('Active now');
  const folder = () => container.querySelector(`[data-sidebar-group="${PROJECT_ID}"]`);
  expect(folder()?.textContent).toContain('Untitled chat');

  await typeSearch('parser');
  expect(rowsTitled('Untitled chat')).toBe(1);
  expect(folder()?.textContent).toContain('Untitled chat');

  await act(async () => {
    useChatSessionsStore.setState({ activeSessionId: null });
  });
  expect(rowsTitled('Untitled chat')).toBe(0);
});
