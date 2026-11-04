/**
 * Decision 209 §3: the side chat's own window, Main's half.
 *
 * The renderer opens it with `window.open('about:blank', SIDE_CHAT_WINDOW_NAME)`
 * and draws the side chat into it through a React portal, so the side chat's
 * state — its questions, their answers, the send — stays in the main window's
 * one copy and nothing is synced between windows. Main's part is the window:
 *
 *  - only this frame name, and only `about:blank`, is let through the main
 *    window's window-open handler; everything else keeps today's rule;
 *  - it is a frameless window OWNED by the main window (ruling 3): always on
 *    top of it, minimized with it, no taskbar entry of its own;
 *  - its place and size are remembered on this machine; a remembered place
 *    that is on no screen any more falls back to the main window's
 *    bottom-right corner;
 *  - it never navigates: links go to the system browser;
 *  - it closes with the main window (on Linux an owner's close does not take
 *    its owned windows with it).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SIDE_CHAT_WINDOW_DEFAULT_SIZE,
  SIDE_CHAT_WINDOW_MARGIN,
  SIDE_CHAT_WINDOW_MIN_SIZE,
  SIDE_CHAT_WINDOW_NAME,
} from '@shared/sideChatWindow';
import { app, type BrowserWindow, screen, shell } from 'electron';

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The part of the window's top strip that must be on a screen to drag it back. */
const REACHABLE_STRIP = { width: 80, height: 24 };
const SAVE_DEBOUNCE_MS = 300;

function isFiniteRect(value: unknown): value is WindowRect {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof rect[key] === 'number' && Number.isFinite(rect[key])
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Whether the window's top strip — where it is dragged from — lies on some screen. */
export function isReachable(rect: WindowRect, workAreas: readonly WindowRect[]): boolean {
  const strip = Math.min(REACHABLE_STRIP.width, rect.width);
  return workAreas.some((area) => {
    const across = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
    const down =
      Math.min(rect.y + REACHABLE_STRIP.height, area.y + area.height) - Math.max(rect.y, area.y);
    return across >= strip && down >= REACHABLE_STRIP.height;
  });
}

/**
 * Where the window opens: the remembered place while it is still reachable,
 * else the main window's bottom-right corner (`SIDE_CHAT_WINDOW_MARGIN` in),
 * kept on the main window's screen.
 */
export function resolveSideChatBounds(input: {
  saved: WindowRect | null;
  workAreas: readonly WindowRect[];
  parent: WindowRect;
}): WindowRect {
  const { saved, workAreas, parent } = input;
  if (saved && isReachable(saved, workAreas)) {
    return {
      x: Math.round(saved.x),
      y: Math.round(saved.y),
      width: Math.round(Math.max(SIDE_CHAT_WINDOW_MIN_SIZE.width, saved.width)),
      height: Math.round(Math.max(SIDE_CHAT_WINDOW_MIN_SIZE.height, saved.height)),
    };
  }
  const { width, height } = SIDE_CHAT_WINDOW_DEFAULT_SIZE;
  let x = parent.x + parent.width - width - SIDE_CHAT_WINDOW_MARGIN;
  let y = parent.y + parent.height - height - SIDE_CHAT_WINDOW_MARGIN;
  const centerX = parent.x + parent.width / 2;
  const centerY = parent.y + parent.height / 2;
  const area =
    workAreas.find(
      (entry) =>
        centerX >= entry.x &&
        centerX < entry.x + entry.width &&
        centerY >= entry.y &&
        centerY < entry.y + entry.height
    ) ?? workAreas[0];
  if (area) {
    x = clamp(x, area.x, area.x + area.width - width);
    y = clamp(y, area.y, area.y + area.height - height);
  }
  return { x: Math.round(x), y: Math.round(y), width, height };
}

function boundsPath(): string {
  return join(app.getPath('userData'), 'side-chat-window.json');
}

function loadSavedBounds(): WindowRect | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(boundsPath(), 'utf8'));
    return isFiniteRect(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveBounds(rect: WindowRect): void {
  try {
    writeFileSync(boundsPath(), JSON.stringify(rect));
  } catch {
    // Not remembering a place is not worth a failure.
  }
}

/** The window's options: owned, frameless, no taskbar entry, the main window's backdrop. */
export function sideChatWindowOptions(
  parent: BrowserWindow,
  bounds: WindowRect
): Electron.BrowserWindowConstructorOptions {
  return {
    ...bounds,
    minWidth: SIDE_CHAT_WINDOW_MIN_SIZE.width,
    minHeight: SIDE_CHAT_WINDOW_MIN_SIZE.height,
    parent,
    frame: false,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: parent.getBackgroundColor(),
  };
}

/**
 * The main window's window-open handler asks this first: the side chat's
 * window gets its answer here; null means "not ours, apply the usual rule".
 */
export function sideChatWindowOpenResponse(
  details: { url: string; frameName: string },
  parent: BrowserWindow
): Electron.WindowOpenHandlerResponse | null {
  if (details.frameName !== SIDE_CHAT_WINDOW_NAME) return null;
  if (details.url !== 'about:blank') return { action: 'deny' };
  const bounds = resolveSideChatBounds({
    saved: loadSavedBounds(),
    workAreas: screen.getAllDisplays().map((display) => display.workArea),
    parent: parent.getBounds(),
  });
  return { action: 'allow', overrideBrowserWindowOptions: sideChatWindowOptions(parent, bounds) };
}

const sideChatWindows = new WeakSet<BrowserWindow>();

function openExternalLink(url: string): void {
  if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url);
}

/** Wire the side chat windows `parent` opens: links, menu, place, lifetime. */
export function watchSideChatWindows(parent: BrowserWindow): void {
  parent.webContents.on('did-create-window', (child, details) => {
    if (details.frameName !== SIDE_CHAT_WINDOW_NAME) return;
    sideChatWindows.add(child);
    // The app menu's accelerators (reload in dev, zoom, devtools) act on the
    // focused window; none of them means anything for this one.
    child.removeMenu();
    child.webContents.setWindowOpenHandler(({ url }) => {
      openExternalLink(url);
      return { action: 'deny' };
    });
    child.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      openExternalLink(url);
    });

    let saveTimer: NodeJS.Timeout | null = null;
    const save = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      if (!child.isDestroyed() && !child.isMinimized()) saveBounds(child.getBounds());
    };
    const saveSoon = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
    };
    child.on('move', saveSoon);
    child.on('resize', saveSoon);
    child.on('close', save);

    const closeWithParent = () => {
      if (!child.isDestroyed()) child.destroy();
    };
    parent.once('closed', closeWithParent);
    child.once('closed', () => {
      if (saveTimer) clearTimeout(saveTimer);
      sideChatWindows.delete(child);
      if (!parent.isDestroyed()) parent.removeListener('closed', closeWithParent);
    });
  });
}

export function isSideChatWindow(window: BrowserWindow): boolean {
  return sideChatWindows.has(window);
}

/**
 * The app window a window belongs to: the side chat's window answers for its
 * owner, so "the focused window" in menus and second-instance focus means
 * the main window.
 */
export function appWindowOf(window: BrowserWindow | null): BrowserWindow | null {
  if (!window || !isSideChatWindow(window)) return window;
  return window.getParentWindow() ?? window;
}
