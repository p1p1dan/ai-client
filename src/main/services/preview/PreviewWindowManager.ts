/**
 * P5-2-3 — the preview surface `browser_preview` asks for.
 *
 * One window per file, reused across calls, reloading by itself when the file
 * changes on disk. The whole thing is deliberately small; three decisions
 * carry it.
 *
 * **A separate window, not a panel.** The reference shows its preview in a
 * `WebContentsView` docked inside the main window. We open a plain
 * `BrowserWindow` instead, because the property the P5-2 contract actually
 * names is foreground ownership: a delegate working in the background must be
 * able to put a page on screen without pulling the user out of what they are
 * doing. `showInactive()` gives us exactly that in one call, where a docked
 * panel would have had to negotiate for space in the layout the user is using.
 *
 * **Watch the directory, not the file.** Editors do not write files, they
 * write a temp file and rename it over the target — which breaks an inode-level
 * `fs.watch` on the file itself after the first save, silently, so the preview
 * would stop reloading exactly once the user started working. Watching the
 * parent directory survives that.
 *
 * **No renderer, no preload, no node.** The window loads a workspace file the
 * session was already allowed to read, over `file://`, in a sandboxed context
 * with no preload script and no node integration. The page being previewed is
 * generated content, and generated content does not get an IPC channel into
 * this app.
 */

import { type FSWatcher, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { BrowserWindow } from 'electron';

/** Coalesce a burst of writes into one reload. */
const RELOAD_DEBOUNCE_MS = 150;

const PREVIEW_MIN_WIDTH = 420;
const PREVIEW_MIN_HEIGHT = 320;
const PREVIEW_DEFAULT_WIDTH = 960;
const PREVIEW_DEFAULT_HEIGHT = 720;

export interface PreviewShowRequest {
  /** Absolute, canonical path. The runtime gated it before asking. */
  path: string;
  /** Bring it to the front. False is the background delegate's case. */
  focus: boolean;
}

interface PreviewEntry {
  window: BrowserWindow;
  watcher: FSWatcher | null;
  reloadTimer: NodeJS.Timeout | null;
}

/** Injectable so the tests never open a real window. */
export interface PreviewWindowDeps {
  createWindow?: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow;
  watchDirectory?: (directory: string, onChange: (filename: string | null) => void) => FSWatcher;
}

export class PreviewWindowManager {
  private readonly entries = new Map<string, PreviewEntry>();
  private readonly deps: PreviewWindowDeps;

  constructor(deps: PreviewWindowDeps = {}) {
    this.deps = deps;
  }

  /**
   * Show a file, resolving once it is on screen.
   *
   * Rejecting is how the host says "I have a preview surface but this did not
   * work"; the reason travels back to the model as the tool's error, so it can
   * stop retrying something that cannot succeed here.
   */
  async show(request: PreviewShowRequest): Promise<void> {
    const existing = this.entries.get(request.path);
    if (existing && !existing.window.isDestroyed()) {
      // Already open: reload so a caller that edited between calls sees the
      // current file, and only raise it if this call asked to.
      existing.window.webContents.reload();
      this.surface(existing.window, request.focus);
      return;
    }
    if (existing) this.forget(request.path);

    const window = this.openWindow();
    const entry: PreviewEntry = { window, watcher: null, reloadTimer: null };
    this.entries.set(request.path, entry);

    window.on('closed', () => {
      // The user closing the preview is a decision, not a fault: drop the
      // watcher with it so an edited file does not resurrect a dead window.
      this.forget(request.path);
    });

    try {
      await window.loadFile(request.path);
    } catch (cause) {
      this.forget(request.path);
      throw new Error(
        `the preview window could not load ${basename(request.path)}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      );
    }
    entry.watcher = this.watch(request.path, entry);
    this.surface(window, request.focus);
  }

  /** Close everything. Called on app shutdown. */
  disposeAll(): void {
    for (const path of [...this.entries.keys()]) {
      const entry = this.entries.get(path);
      this.forget(path);
      if (entry && !entry.window.isDestroyed()) entry.window.destroy();
    }
  }

  /** Open windows, for tests and for the shutdown check. */
  get openCount(): number {
    return this.entries.size;
  }

  /**
   * Is this one of ours?
   *
   * T065 — a preview is an ordinary `BrowserWindow`, so `getAllWindows()` counts
   * it as a place the app "keeps running", which it is not: closing the last app
   * window disposes every preview and quits. Asked by the close-confirmation
   * dialog, which would otherwise promise the user a window that is about to
   * close with the app.
   */
  isPreviewWindow(window: BrowserWindow): boolean {
    for (const entry of this.entries.values()) {
      if (entry.window === window) return true;
    }
    return false;
  }

  private openWindow(): BrowserWindow {
    const options: Electron.BrowserWindowConstructorOptions = {
      width: PREVIEW_DEFAULT_WIDTH,
      height: PREVIEW_DEFAULT_HEIGHT,
      minWidth: PREVIEW_MIN_WIDTH,
      minHeight: PREVIEW_MIN_HEIGHT,
      // Built hidden so the first paint is not a white flash, then shown by
      // `surface` in the mode the caller asked for.
      show: false,
      webPreferences: {
        // See the module note: previewed pages are generated content.
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
      },
    };
    return this.deps.createWindow ? this.deps.createWindow(options) : new BrowserWindow(options);
  }

  /**
   * Put the window on screen.
   *
   * `showInactive` is the contract's "后台不抢前台" in one call: the window
   * appears, the user keeps their focus. An already-visible window is left
   * exactly where it is unless the caller asked for the front.
   */
  private surface(window: BrowserWindow, focus: boolean): void {
    if (focus) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return;
    }
    if (!window.isVisible()) window.showInactive();
  }

  private watch(path: string, entry: PreviewEntry): FSWatcher | null {
    const directory = dirname(path);
    const name = basename(path);
    const onChange = (filename: string | null) => {
      // A rename event reports the temp name too; anything in this directory
      // that is not our file is somebody else's business.
      if (filename !== null && filename !== name) return;
      if (entry.reloadTimer) clearTimeout(entry.reloadTimer);
      entry.reloadTimer = setTimeout(() => {
        entry.reloadTimer = null;
        if (!entry.window.isDestroyed()) entry.window.webContents.reload();
      }, RELOAD_DEBOUNCE_MS);
    };
    try {
      return this.deps.watchDirectory
        ? this.deps.watchDirectory(directory, onChange)
        : watch(directory, (_event, filename) => onChange(filename ? String(filename) : null));
    } catch {
      // A directory we cannot watch costs auto-reload, not the preview. The
      // page is already on screen and `browser_preview` can be called again.
      return null;
    }
  }

  private forget(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.entries.delete(path);
    if (entry.reloadTimer) clearTimeout(entry.reloadTimer);
    entry.watcher?.close();
  }
}

export const previewWindowManager = new PreviewWindowManager();
