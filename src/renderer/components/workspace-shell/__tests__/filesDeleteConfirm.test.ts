// @vitest-environment happy-dom
/**
 * T103: the files panel's delete action used to be a blocking, English-only
 * `window.confirm(...)` — invisible to `t()`, and a native prompt no CDP-based
 * point check can drive (batch I, D-1). It now goes through the app's own
 * `AlertDialog`, the same primitive the sidebar's "end conversation" flow uses.
 *
 * `FilesSurfaceView` is rendered for real here: `useFileTree` and `useEditor`
 * are the real hooks (react-query and the editor store), with only the IPC
 * boundary (`window.electronAPI`) and the workspace-root lookup stubbed.
 * `window.electronAPI` is stubbed in `vi.hoisted` because the AlertDialog's
 * `useTrafficLightsGuard` reads `electronAPI.env.platform` on mount — a stub
 * installed later (e.g. in `beforeEach`) loses that race, per the convention
 * pinned in `useFileTree.test.ts` and `signInConfirmFlow.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { translate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/stores/editor';
import { stripComments } from '../../chat/__tests__/stripComments';

const ROOT = '/repo';
const FILE_PATH = `${ROOT}/notes.md`;
const DIR_PATH = `${ROOT}/src`;

type FakeEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
};

const { fakeDisk, fileApi } = vi.hoisted(() => {
  /** Absolute path -> isDirectory. Stands in for the real filesystem. */
  const fakeDisk = new Map<string, boolean>();

  const listDirectory = (dirPath: string) => {
    const entries: FakeEntry[] = [];
    for (const [path, isDirectory] of fakeDisk) {
      if (path.slice(0, path.lastIndexOf('/')) !== dirPath) continue;
      entries.push({
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        isDirectory,
        size: 0,
        modifiedAt: 0,
      });
    }
    return entries.sort((a, b) =>
      a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1
    );
  };

  const fileApi = {
    list: vi.fn(async (dirPath: string) => listDirectory(dirPath)),
    delete: vi.fn(async (path: string) => {
      for (const key of [...fakeDisk.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) fakeDisk.delete(key);
      }
    }),
    watchStart: vi.fn(async () => undefined),
    watchStop: vi.fn(async () => undefined),
    onChange: vi.fn(() => () => {}),
  };

  return { fakeDisk, fileApi };
});

vi.stubGlobal('electronAPI', { file: fileApi, env: { platform: 'linux' } });

// Real interpolation at the zh locale, no settings-store dependency — proves
// the dialog actually reads the catalog instead of asserting on a mocked key.
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => translate('zh', key, params),
  }),
}));

// The active-session -> workspace -> path chain has its own hook and its own
// tests; standing up a full chatSessions fixture here would test a fact this
// suite is not about, so the root is pinned directly instead.
vi.mock('../useWorkspaceRootPath', () => ({
  useWorkspaceRootPath: () => ROOT,
}));

const { FilesSurfaceView } = await import('../surfaces/FilesSurfaceView');

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

/** Let react-query settle: one round is one macrotask plus its microtasks. */
async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(FilesSurfaceView, { surfaceId: 'editor' })
      )
    );
  });
  await flush();
}

async function unmount() {
  await act(async () => root.unmount());
  container.remove();
}

/** Right-click the tree row for `path`, then click its "Delete" menu item. */
async function requestDelete(path: string) {
  const row = document.querySelector(`[data-node-path="${path}"]`);
  if (!row) throw new Error(`no tree row for ${path}`);
  await act(async () => {
    row.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    );
  });
  const deleteMenuItem = [...document.querySelectorAll('[data-slot="menu-item"]')].find(
    (item) => item.textContent?.trim() === zh('Delete')
  );
  if (!deleteMenuItem) throw new Error('no Delete menu item on the tree row');
  await act(async () => {
    (deleteMenuItem as HTMLElement).click();
  });
}

/** The portalled AlertDialog lives on `document.body`, not inside `container`. */
function dialogButton(label: string): HTMLButtonElement {
  const popup = document.querySelector('[data-slot="alert-dialog-popup"]');
  const found = [...(popup?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!found) throw new Error(`no "${label}" button; popup: ${popup?.textContent ?? '(none)'}`);
  return found;
}

describe('T103: files-panel delete confirmation (rendered)', () => {
  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('electronAPI', { file: fileApi, env: { platform: 'linux' } });
    fakeDisk.clear();
    fakeDisk.set(FILE_PATH, false);
    fakeDisk.set(DIR_PATH, true);
    for (const mock of Object.values(fileApi)) mock.mockClear();
    useEditorStore.setState({
      tabs: [{ path: FILE_PATH, title: 'notes.md', content: '', isDirty: false }],
      activeTabPath: FILE_PATH,
    });
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    await mount();
  });

  afterEach(async () => {
    await unmount();
    client.clear();
    vi.unstubAllGlobals();
  });

  it('confirming deletes the path and closes its editor tab', async () => {
    await requestDelete(FILE_PATH);

    expect(document.querySelector('[data-slot="alert-dialog-title"]')?.textContent).toBe(
      zh('Delete file?')
    );
    expect(document.querySelector('[data-slot="alert-dialog-description"]')?.textContent).toContain(
      'notes.md'
    );

    await act(async () => {
      dialogButton(zh('Delete')).click();
    });
    await flush();

    expect(fileApi.delete).toHaveBeenCalledExactlyOnceWith(FILE_PATH);
    expect(useEditorStore.getState().tabs.some((tab) => tab.path === FILE_PATH)).toBe(false);
    expect(document.querySelector('[data-slot="alert-dialog-popup"]')).toBeNull();
  });

  it('cancelling leaves the file alone', async () => {
    await requestDelete(FILE_PATH);

    await act(async () => {
      dialogButton(zh('Cancel')).click();
    });

    expect(fileApi.delete).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs.some((tab) => tab.path === FILE_PATH)).toBe(true);
    expect(document.querySelector('[data-slot="alert-dialog-popup"]')).toBeNull();
  });

  it('titles the dialog for a folder differently than for a file', async () => {
    await requestDelete(DIR_PATH);

    expect(document.querySelector('[data-slot="alert-dialog-title"]')?.textContent).toBe(
      zh('Delete folder?')
    );

    // Leave the fixture untouched for the other tests in this file.
    await act(async () => {
      dialogButton(zh('Cancel')).click();
    });
  });
});

describe('T103: files-panel delete confirmation (static)', () => {
  const FILE = join(
    process.cwd(),
    'src/renderer/components/workspace-shell/surfaces/FilesSurfaceView.tsx'
  );
  const CODE = stripComments(readFileSync(FILE, 'utf8'), FILE);

  it('the delete action opens an alert dialog instead of window.confirm', () => {
    expect(CODE).not.toContain('window.confirm');
    expect(CODE).toContain('<AlertDialog');
    expect(CODE).toContain('setDeleteTarget');
  });
});
