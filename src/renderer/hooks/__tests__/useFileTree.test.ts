// @vitest-environment happy-dom
/**
 * T094 / T095 regression: the file panel must show the result of its own
 * writes, and a rename must cross IPC as a full path.
 *
 * Why these assertions and not a screenshot: every bug in this area was
 * invisible to the code that caused it. The CRUD helpers called
 * `invalidateQueries` on a subdirectory key that has no observer, so nothing
 * refetched and nothing failed — the panel simply did not move. Each test here
 * therefore drives the hook's own API and reads the tree it publishes, with
 * the file watcher deliberately silent (no `file:change` is emitted unless the
 * test is about the watcher).
 */

import type { FileEntry } from '@shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeNode } from '../useFileTree';
import { useFileTree } from '../useFileTree';

const ROOT = '/repo';

type FileChangeEvent = { type: 'create' | 'update' | 'delete'; path: string };

// The electronAPI stub is hoisted so it exists before the hook module is
// evaluated, per the renderer-mount-test convention in this repo.
const { fakeDisk, changeListeners, fileApi } = vi.hoisted(() => {
  /** Absolute path -> isDirectory. Stands in for the real filesystem. */
  const fakeDisk = new Map<string, boolean>();
  const changeListeners = new Set<(event: FileChangeEvent) => void>();

  const listDirectory = (dirPath: string) => {
    const entries: FileEntry[] = [];
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

  const removeSubtree = (path: string) => {
    for (const key of [...fakeDisk.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) fakeDisk.delete(key);
    }
  };

  const fileApi = {
    list: vi.fn(async (dirPath: string) => {
      if (!fakeDisk.has(dirPath) && dirPath !== ROOT) {
        throw new Error(`ENOENT: no such file or directory, scandir '${dirPath}'`);
      }
      return listDirectory(dirPath);
    }),
    createFile: vi.fn(async (path: string) => {
      fakeDisk.set(path, false);
    }),
    createDirectory: vi.fn(async (path: string) => {
      fakeDisk.set(path, true);
    }),
    rename: vi.fn(async (fromPath: string, toPath: string) => {
      const isDirectory = fakeDisk.get(fromPath);
      if (isDirectory === undefined) throw new Error(`ENOENT: ${fromPath}`);
      for (const key of [...fakeDisk.keys()]) {
        if (key === fromPath || key.startsWith(`${fromPath}/`)) {
          const value = fakeDisk.get(key) as boolean;
          fakeDisk.delete(key);
          fakeDisk.set(`${toPath}${key.slice(fromPath.length)}`, value);
        }
      }
    }),
    delete: vi.fn(async (path: string) => {
      removeSubtree(path);
    }),
    watchStart: vi.fn(async () => undefined),
    watchStop: vi.fn(async () => undefined),
    onChange: vi.fn((callback: (event: FileChangeEvent) => void) => {
      changeListeners.add(callback);
      return () => changeListeners.delete(callback);
    }),
  };

  return { fakeDisk, changeListeners, fileApi };
});

vi.stubGlobal('electronAPI', { file: fileApi });

let hook: ReturnType<typeof useFileTree>;
let client: QueryClient;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe() {
  hook = useFileTree({ rootPath: ROOT, enabled: true, isActive: true });
  return null;
}

/** Let react-query settle: each round is one macrotask plus its microtasks. */
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
    root?.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  await flush();
}

async function unmount() {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
}

function findNode(nodes: FileTreeNode[], path: string): FileTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const hit = node.children ? findNode(node.children, path) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

/** Names of a directory's children AS THE PANEL WOULD DRAW THEM. */
function childNames(path: string): string[] {
  if (path === ROOT) return hook.tree.map((node) => node.name);
  return (findNode(hook.tree, path)?.children ?? []).map((node) => node.name);
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Re-applied every test: `unstubAllGlobals` in afterEach drops the one set at
  // module scope, and the hook reads `window.electronAPI` lazily.
  vi.stubGlobal('electronAPI', { file: fileApi });
  localStorage.clear();
  fakeDisk.clear();
  fakeDisk.set('/repo/src', true);
  fakeDisk.set('/repo/src/a.ts', false);
  fakeDisk.set('/repo/src/b.ts', false);
  fakeDisk.set('/repo/README.md', false);
  changeListeners.clear();
  for (const mock of Object.values(fileApi)) mock.mockClear();
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

describe('T094 — file panel writes are visible without the watcher', () => {
  it('drops a deleted file from an expanded subdirectory immediately', async () => {
    await act(async () => {
      await hook.toggleExpand('/repo/src');
    });
    expect(childNames('/repo/src')).toEqual(['a.ts', 'b.ts']);

    await act(async () => {
      await hook.deleteItem('/repo/src/a.ts');
    });

    expect(fileApi.delete).toHaveBeenCalledExactlyOnceWith('/repo/src/a.ts');
    expect(childNames('/repo/src')).toEqual(['b.ts']);
    // Nothing was delivered on the watcher channel: the update came from the
    // mutation path alone, which is the property that was missing.
    expect(changeListeners.size).toBe(1);
  });

  it('shows a file created inside an expanded subdirectory immediately', async () => {
    await act(async () => {
      await hook.toggleExpand('/repo/src');
    });

    await act(async () => {
      await hook.createFile('/repo/src/c.ts');
    });

    expect(childNames('/repo/src')).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('shows a directory created inside an expanded subdirectory immediately', async () => {
    await act(async () => {
      await hook.toggleExpand('/repo/src');
    });

    await act(async () => {
      await hook.createDirectory('/repo/src/nested');
    });

    // Directories sort first, as `file:list` orders them.
    expect(childNames('/repo/src')).toEqual(['nested', 'a.ts', 'b.ts']);
  });

  it('re-reads a subdirectory from disk after the surface is remounted', async () => {
    await act(async () => {
      await hook.toggleExpand('/repo/src');
    });
    await unmount();

    // Something outside the app touched the workspace while the panel was gone.
    fakeDisk.set('/repo/src/offline.ts', false);
    fileApi.list.mockClear();

    await mount();

    expect(fileApi.list.mock.calls.map((call) => call[0])).toContain('/repo/src');
    expect(childNames('/repo/src')).toContain('offline.ts');
  });

  it('re-reads the parent directory when a file:change event arrives', async () => {
    await act(async () => {
      await hook.toggleExpand('/repo/src');
    });

    fakeDisk.set('/repo/src/watched.ts', false);
    await act(async () => {
      for (const listener of changeListeners) {
        listener({ type: 'create', path: '/repo/src/watched.ts' });
      }
    });
    await flush();

    expect(childNames('/repo/src')).toContain('watched.ts');
  });

  it('forgets a deleted directory instead of keeping it in expandedPaths', async () => {
    await act(async () => {
      await hook.toggleExpand('/repo/src');
    });
    expect(hook.expandedPaths.has('/repo/src')).toBe(true);

    await act(async () => {
      await hook.deleteItem('/repo/src');
    });

    expect(hook.expandedPaths.has('/repo/src')).toBe(false);
    expect(childNames(ROOT)).toEqual(['README.md']);
    // The persisted copy has to agree, or the ghost returns on the next switch.
    expect(JSON.stringify([...hook.expandedPaths])).not.toContain('/repo/src');
  });
});

describe('T095 — rename sends a destination path, not a bare name', () => {
  it('joins the bare name from the inline editor onto the source directory', async () => {
    await act(async () => {
      await hook.toggleExpand('/repo/src');
    });

    await act(async () => {
      await hook.renameItem('/repo/src/a.ts', 'renamed.ts');
    });

    expect(fileApi.rename).toHaveBeenCalledExactlyOnceWith(
      '/repo/src/a.ts',
      '/repo/src/renamed.ts'
    );
    expect(childNames('/repo/src')).toEqual(['b.ts', 'renamed.ts']);
  });

  it('passes an already-absolute destination through unchanged', async () => {
    await act(async () => {
      await hook.renameItem('/repo/README.md', '/repo/NOTES.md');
    });

    expect(fileApi.rename).toHaveBeenCalledExactlyOnceWith('/repo/README.md', '/repo/NOTES.md');
  });
});
