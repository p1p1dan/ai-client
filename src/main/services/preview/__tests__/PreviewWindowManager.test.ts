/**
 * P5-2-3 gate — SA20's host half: the preview window's own behaviour.
 *
 * Electron is not started here. `BrowserWindow` and `fs.watch` are both
 * injected, which is the point: what needs proving is the POLICY — reuse one
 * window per file, reload when the file changes, never steal the front unless
 * asked — and that policy is ours, not Chromium's.
 *
 * The foreground rule is the one with teeth. A subagent runs in the background
 * while the user is typing somewhere else; a preview that called `focus()`
 * would yank them out of it. `showInactive` is the whole difference, so it is
 * asserted directly rather than through "the window is visible".
 */

import { describe, expect, it, vi } from 'vitest';
import { PreviewWindowManager } from '../PreviewWindowManager';

type Handler = () => void;

function fakeWindow() {
  const handlers = new Map<string, Handler>();
  const window = {
    destroyed: false,
    visible: false,
    minimized: false,
    shown: [] as ('show' | 'showInactive' | 'focus' | 'restore')[],
    loaded: [] as string[],
    reloads: 0,
    loadFile: vi.fn(async (path: string) => {
      window.loaded.push(path);
    }),
    webContents: {
      reload: () => {
        window.reloads += 1;
      },
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    isDestroyed: () => window.destroyed,
    isVisible: () => window.visible,
    isMinimized: () => window.minimized,
    show: () => {
      window.visible = true;
      window.shown.push('show');
    },
    showInactive: () => {
      window.visible = true;
      window.shown.push('showInactive');
    },
    focus: () => window.shown.push('focus'),
    restore: () => {
      window.minimized = false;
      window.shown.push('restore');
    },
    destroy: () => {
      window.destroyed = true;
      handlers.get('closed')?.();
    },
    close: () => {
      window.destroyed = true;
      handlers.get('closed')?.();
    },
  };
  return window;
}

type FakeWindow = ReturnType<typeof fakeWindow>;

function harness() {
  const windows: FakeWindow[] = [];
  const watchers: {
    directory: string;
    fire: (filename: string | null) => void;
    closed: boolean;
  }[] = [];
  const manager = new PreviewWindowManager({
    createWindow: () => {
      const window = fakeWindow();
      windows.push(window);
      return window as unknown as Electron.BrowserWindow;
    },
    watchDirectory: (directory, onChange) => {
      const watcher = { directory, fire: onChange, closed: false };
      watchers.push(watcher);
      return {
        close: () => {
          watcher.closed = true;
        },
      } as unknown as ReturnType<typeof import('node:fs').watch>;
    },
  });
  return { manager, windows, watchers };
}

describe('SA20 · the preview window', () => {
  it('opens the workspace page and shows it without taking the front', async () => {
    const { manager, windows } = harness();
    await manager.show({ path: '/work/demo/index.html', focus: false });

    expect(windows).toHaveLength(1);
    expect(windows[0].loaded).toEqual(['/work/demo/index.html']);
    expect(windows[0].shown).toEqual(['showInactive']);
    // Stated explicitly because this is the contract's "后台不抢前台": the
    // window appears, the user's focus does not move.
    expect(windows[0].shown).not.toContain('focus');
  });

  it('takes the front only when the caller asked for it', async () => {
    const { manager, windows } = harness();
    await manager.show({ path: '/work/page.html', focus: true });
    expect(windows[0].shown).toEqual(['show', 'focus']);
  });

  it('restores a minimized window when asked for the front', async () => {
    const { manager, windows } = harness();
    await manager.show({ path: '/work/page.html', focus: false });
    windows[0].minimized = true;
    await manager.show({ path: '/work/page.html', focus: true });
    expect(windows[0].shown).toEqual(['showInactive', 'restore', 'show', 'focus']);
  });

  it('reuses the same window for the same file, and opens a second for another', async () => {
    const { manager, windows } = harness();
    await manager.show({ path: '/work/a.html', focus: false });
    await manager.show({ path: '/work/a.html', focus: false });
    expect(windows).toHaveLength(1);
    // The second call reloads, so a caller that edited between calls is not
    // looking at a stale page.
    expect(windows[0].reloads).toBe(1);

    await manager.show({ path: '/work/b.html', focus: false });
    expect(windows).toHaveLength(2);
    expect(manager.openCount).toBe(2);
  });

  it('does not raise an already-open preview that was not asked to be raised', async () => {
    const { manager, windows } = harness();
    await manager.show({ path: '/work/a.html', focus: false });
    windows[0].shown.length = 0;
    await manager.show({ path: '/work/a.html', focus: false });
    // Already visible: nothing to do. Re-showing would pull it above whatever
    // the user has since put in front of it.
    expect(windows[0].shown).toEqual([]);
  });

  it('reloads by itself when the file changes, and coalesces a burst', async () => {
    vi.useFakeTimers();
    try {
      const { manager, windows, watchers } = harness();
      await manager.show({ path: '/work/demo/index.html', focus: false });
      expect(watchers[0].directory).toBe('/work/demo');

      watchers[0].fire('index.html');
      watchers[0].fire('index.html');
      watchers[0].fire('index.html');
      expect(windows[0].reloads).toBe(0);
      vi.advanceTimersByTime(200);
      // One reload for three writes: an editor saving is several events.
      expect(windows[0].reloads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores changes to other files in the same directory', async () => {
    vi.useFakeTimers();
    try {
      const { manager, windows, watchers } = harness();
      await manager.show({ path: '/work/demo/index.html', focus: false });
      watchers[0].fire('styles.css');
      vi.advanceTimersByTime(200);
      expect(windows[0].reloads).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads on an unnamed change event, which is what some platforms report', async () => {
    vi.useFakeTimers();
    try {
      const { manager, windows, watchers } = harness();
      await manager.show({ path: '/work/demo/index.html', focus: false });
      watchers[0].fire(null);
      vi.advanceTimersByTime(200);
      expect(windows[0].reloads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops watching when the user closes the preview, and opens a fresh one next time', async () => {
    const { manager, windows, watchers } = harness();
    await manager.show({ path: '/work/a.html', focus: false });
    windows[0].close();

    expect(watchers[0].closed).toBe(true);
    expect(manager.openCount).toBe(0);
    await manager.show({ path: '/work/a.html', focus: false });
    expect(windows).toHaveLength(2);
  });

  it('reports a load failure instead of leaving a dead window registered', async () => {
    const windows: FakeWindow[] = [];
    const manager = new PreviewWindowManager({
      createWindow: () => {
        const window = fakeWindow();
        window.loadFile = vi.fn(async () => {
          throw new Error('ERR_FILE_NOT_FOUND');
        });
        windows.push(window);
        return window as unknown as Electron.BrowserWindow;
      },
      watchDirectory: () =>
        ({ close: () => undefined }) as unknown as ReturnType<typeof import('node:fs').watch>,
    });

    await expect(manager.show({ path: '/work/gone.html', focus: false })).rejects.toThrow(
      /gone\.html.*ERR_FILE_NOT_FOUND/
    );
    // Not registered, so the next call retries rather than reusing a window
    // that never loaded anything.
    expect(manager.openCount).toBe(0);
  });

  it('survives a directory it cannot watch, minus the auto-reload', async () => {
    const windows: FakeWindow[] = [];
    const manager = new PreviewWindowManager({
      createWindow: () => {
        const window = fakeWindow();
        windows.push(window);
        return window as unknown as Electron.BrowserWindow;
      },
      watchDirectory: () => {
        throw new Error('EMFILE');
      },
    });
    // The page is on screen; only live reload is lost, and that is not worth
    // failing a preview the user can still refresh by calling the tool again.
    await expect(manager.show({ path: '/work/a.html', focus: false })).resolves.toBeUndefined();
    expect(windows[0].shown).toEqual(['showInactive']);
  });

  it('closes everything on shutdown', async () => {
    const { manager, windows, watchers } = harness();
    await manager.show({ path: '/work/a.html', focus: false });
    await manager.show({ path: '/work/b.html', focus: false });

    manager.disposeAll();
    expect(manager.openCount).toBe(0);
    expect(windows.every((window) => window.destroyed)).toBe(true);
    expect(watchers.every((watcher) => watcher.closed)).toBe(true);
  });
});
