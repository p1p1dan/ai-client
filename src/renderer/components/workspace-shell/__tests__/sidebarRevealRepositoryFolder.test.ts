// @vitest-environment happy-dom

import { toRemoteVirtualPath } from '@shared/utils/remotePath';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@/App/storage';
import { useChatSessionsStore } from '@/stores/chatSessions';

/**
 * "Reveal in Finder / Explorer" on the repository row's context menu — opens
 * the repository directory itself through `shell.openPath` (the same preload
 * call the file tree's root-folder menu already uses to open a path, distinct
 * from `file.revealInFileManager`'s "select inside the parent" semantics).
 *
 * Rendered for real, same harness as `sidebarContextMenuInteraction.test.ts`:
 * everything LeftNav pulls in besides the sidebar itself is stubbed (the
 * persisted session index, session activation, the diff-stats poller), and
 * `window.electronAPI` is stubbed via `vi.hoisted` so the mount race described
 * in `filesDeleteConfirm.test.ts` cannot apply here either.
 */

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name])) : key,
  }),
}));
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

const toasts: { type?: string; title: string }[] = [];
vi.mock('@/components/ui/toast', () => ({
  toastManager: { add: (toast: { type?: string; title: string }) => toasts.push(toast) },
}));

const { openPath } = vi.hoisted(() => ({ openPath: vi.fn(async (_path: string) => '') }));
vi.stubGlobal('electronAPI', { shell: { openPath } });

const { LeftNav } = await import('../LeftNav');

const PROJECT_ID = 'project:/repo/alpha';
const REPO = { id: PROJECT_ID, path: '/repo/alpha', name: 'alpha' };

const REMOTE_PROJECT_ID = 'project:remote-1';
const REMOTE_REPO = {
  id: REMOTE_PROJECT_ID,
  path: toRemoteVirtualPath('conn-1', '/srv/remote-repo'),
  name: 'remote-repo',
  kind: 'remote' as const,
  connectionId: 'conn-1',
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.setItem(STORAGE_KEYS.SIDEBAR_RECENT_COLLAPSED, 'false');
  openPath.mockClear();
  openPath.mockImplementation(async () => '');
  toasts.length = 0;
  useChatSessionsStore.setState({
    projects: [
      { id: PROJECT_ID, name: 'alpha' },
      { id: REMOTE_PROJECT_ID, name: 'remote-repo' },
    ],
    workspaces: [
      { id: 'ws-1', projectId: PROJECT_ID, name: 'Main', kind: 'main', path: '/repo/alpha' },
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
  vi.unstubAllGlobals();
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

function findFolderHeader(name: string): Element | undefined {
  return [...container.querySelectorAll('div')].find(
    (element) =>
      element.className.includes('group flex h-7') && element.textContent?.trim() === name
  );
}

async function mount(repositories: unknown[]): Promise<void> {
  await act(async () =>
    root.render(createElement(LeftNav, { repositories: repositories as never }))
  );
}

describe('repository folder context menu — reveal in file manager', () => {
  it('offers the action on a local repository and opens the directory itself when clicked', async () => {
    await mount([REPO]);

    const folderHeader = findFolderHeader('alpha');
    expect(folderHeader, 'repository folder header is rendered').toBeTruthy();

    await rightClick(folderHeader as Element);
    const menu = openMenuItems();
    expect(menu).toContain('Reveal in Explorer');

    const item = [...document.querySelectorAll('[data-slot="menu-item"]')].find(
      (el) => el.textContent?.trim() === 'Reveal in Explorer'
    );
    expect(item, 'menu item element found').toBeTruthy();

    await act(async () => {
      (item as HTMLElement).click();
    });

    // `openPath` opens the directory itself (unlike `revealInFileManager`,
    // which selects the item inside its parent) — the repository's own path,
    // unmodified.
    expect(openPath).toHaveBeenCalledExactlyOnceWith('/repo/alpha');
  });

  it('hides the action for a remote repository, consistent with files.ts refusing remote reveal', async () => {
    await mount([REPO, REMOTE_REPO]);

    const folderHeader = findFolderHeader('remote-repo');
    expect(folderHeader, 'remote repository folder header is rendered').toBeTruthy();

    await rightClick(folderHeader as Element);
    const menu = openMenuItems();
    // The rest of the repository menu is still there — only the one action
    // tied to a local filesystem path is missing.
    expect(menu).toContain('Repository Settings');
    expect(menu).not.toContain('Reveal in Explorer');
    expect(menu).not.toContain('Reveal in Finder');
    expect(openPath).not.toHaveBeenCalled();
  });

  it('shows an error toast when the OS reports it could not open the path', async () => {
    openPath.mockImplementation(async () => 'ENOENT: no such file or directory');
    await mount([REPO]);

    const folderHeader = findFolderHeader('alpha');
    await rightClick(folderHeader as Element);
    const item = [...document.querySelectorAll('[data-slot="menu-item"]')].find(
      (el) => el.textContent?.trim() === 'Reveal in Explorer'
    );
    await act(async () => {
      (item as HTMLElement).click();
      await Promise.resolve();
    });

    expect(toasts.map((toast) => toast.title)).toEqual(['Could not open "/repo/alpha".']);
  });

  it('does not add the action to a session row s own context menu', async () => {
    await mount([REPO]);

    const row = [...container.querySelectorAll('[role="button"]')].find((element) =>
      element.textContent?.includes('Session A')
    );
    expect(row, 'session row is rendered').toBeTruthy();

    await rightClick(row as Element);
    const rowMenu = openMenuItems();
    expect(rowMenu).toContain('Rename');
    expect(rowMenu).toContain('Archive');
    expect(rowMenu).not.toContain('Reveal in Explorer');
    expect(rowMenu).not.toContain('Reveal in Finder');
    expect(openPath).not.toHaveBeenCalled();
  });
});
