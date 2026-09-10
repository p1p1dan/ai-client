// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';

/**
 * H/18 S1 + S2, rendered for real.
 *
 * The static tests next door pin which element owns which menu; this one
 * answers the question they cannot — does right-clicking actually OPEN the
 * right one. The rule it exercises is the nesting one: a right-click on a
 * session row must give the ROW's menu, not the partition's, and a right-click
 * on a repository header must give the repository's.
 *
 * Everything LeftNav pulls in that is not the sidebar itself is stubbed: the
 * persisted session index (an IPC call), session activation (starts a worker)
 * and the diff-stats poller (a timer plus IPC).
 */

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/chat/sessionIndex/useSessionIndex', () => ({
  useSessionIndex: () => ({ refresh: async () => {}, loading: false, error: null }),
  useSessionIndexMutations: () => ({
    rename: async () => {},
    archive: async () => {},
    archiveMany: async () => {},
    close: async () => {},
  }),
}));
// Stands in for the real hook's FIRST line (`selectSession(sessionId)`); what
// is dropped is the resume-if-needed half, which reaches for a worker. Keeping
// the selection is what lets the unread test below click a row and see the
// marker clear the way it would in the app.
vi.mock('@/components/workspace-shell/useActivateSession', () => ({
  useActivateSession: () => (sessionId: string) =>
    useChatSessionsStore.getState().selectSession(sessionId),
}));
vi.mock('@/components/workspace-shell/useFolderDiffStats', () => ({
  useFolderDiffStatsPolling: () => {},
}));

const { LeftNav } = await import('../LeftNav');

/**
 * `id` must equal the seeded project's id: LeftNav matches folder → repository
 * through `projectIdForRepo`, which prefers `repo.id`. Get it wrong and the
 * folder renders with no repository behind it — the un-wrapped case — which is
 * a different branch than the one under test here.
 */
const PROJECT_ID = 'project:/repo/alpha';
const REPO = { id: PROJECT_ID, path: '/repo/alpha', name: 'alpha' };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useChatSessionsStore.setState({
    projects: [{ id: PROJECT_ID, name: 'alpha' }],
    workspaces: [
      {
        id: 'ws-1',
        projectId: PROJECT_ID,
        name: 'Main',
        kind: 'main',
        path: '/repo/alpha',
      },
    ],
    sessions: [
      {
        id: 'session-a',
        projectId: PROJECT_ID,
        workspaceId: 'ws-1',
        title: 'Session A',
        status: 'idle',
        updatedAt: Date.now(),
      },
    ],
    activeSessionId: null,
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
});

/** Every menu item currently on screen, popups included (they portal to body). */
function openMenuItems(): string[] {
  return [...document.querySelectorAll('[data-slot="menu-item"]')].map(
    (item) => item.textContent?.trim() ?? ''
  );
}

async function rightClick(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    );
  });
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

it('gives the row menu on a row and the repository menu on its folder header', async () => {
  const onAddRepository = vi.fn();
  await act(async () =>
    root.render(
      createElement(LeftNav, {
        repositories: [REPO] as never,
        onAddRepository,
        onRemoveRepository: () => {},
      })
    )
  );

  // The tree rendered at all — the S1/S2 restructure moved real JSX around.
  expect(container.textContent).toContain('Session A');
  expect(container.textContent).toContain('alpha');
  expect(openMenuItems()).toEqual([]);

  const row = [...container.querySelectorAll('[role="button"]')].find((element) =>
    element.textContent?.includes('Session A')
  );
  expect(row, 'session row is rendered').toBeTruthy();

  await rightClick(row as Element);
  const rowMenu = openMenuItems();
  expect(rowMenu).toContain('Rename');
  expect(rowMenu).toContain('Archive');
  // The row's menu wins over the partition's — the whole point of the nesting.
  expect(rowMenu).not.toContain('Repository Settings');
  expect(rowMenu).not.toContain('Add Repository');

  await pressEscape();
  expect(openMenuItems()).toEqual([]);

  const folderHeader = [...container.querySelectorAll('div')].find(
    (element) =>
      element.className.includes('group flex h-7') && element.textContent?.trim() === 'alpha'
  );
  expect(folderHeader, 'repository folder header is rendered').toBeTruthy();

  await rightClick(folderHeader as Element);
  const folderMenu = openMenuItems();
  expect(folderMenu).toContain('Repository Settings');
  expect(folderMenu).toContain('Remove repository');
  expect(folderMenu).not.toContain('Rename');
});

it('gives the temporary-chat partition its own menu', async () => {
  useChatSessionsStore.setState({
    sessions: [
      {
        id: 'scratch',
        projectId: '',
        workspaceId: '',
        title: 'Scratch chat',
        status: 'idle',
        updatedAt: Date.now(),
        unbound: { workspacePath: '/tmp/scratch' },
      },
    ],
  });
  await act(async () => root.render(createElement(LeftNav, { repositories: [REPO] as never })));

  const header = [...container.querySelectorAll('span')].find(
    (element) => element.textContent === 'Temporary chats'
  );
  expect(header, 'temporary-chat partition is rendered').toBeTruthy();

  await rightClick(header as Element);
  expect(openMenuItems()).toEqual(['New temporary chat']);
});

it('shows the unread marker until the conversation is opened', async () => {
  useChatSessionsStore.setState({ unreadSessionIds: ['session-a'] });
  await act(async () => root.render(createElement(LeftNav, { repositories: [REPO] as never })));

  // Recent and the folder tree both list this session, so the marker is on
  // both rows — the count is what proves neither list was missed.
  const markers = () =>
    container.querySelectorAll('[aria-label="Finished while you were away"]').length;
  expect(markers()).toBe(2);

  const row = [...container.querySelectorAll('[role="button"]')].find((element) =>
    element.textContent?.includes('Session A')
  );
  await act(async () => (row as HTMLElement).click());

  expect(useChatSessionsStore.getState().unreadSessionIds).toEqual([]);
  expect(markers()).toBe(0);
});

it('gives the projects partition menu on its title row', async () => {
  const onAddRepository = vi.fn();
  await act(async () =>
    root.render(
      createElement(LeftNav, {
        repositories: [REPO] as never,
        onAddRepository,
      })
    )
  );

  const title = [...container.querySelectorAll('p')].find(
    (element) => element.textContent === 'Repositories'
  );
  expect(title, 'partition title row is rendered').toBeTruthy();

  await rightClick(title as Element);
  expect(openMenuItems()).toEqual(['Add Repository']);

  await act(async () => {
    document.querySelector<HTMLElement>('[data-slot="menu-item"]')?.click();
  });
  expect(onAddRepository).toHaveBeenCalled();
});
