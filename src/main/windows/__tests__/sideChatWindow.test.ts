import { EventEmitter } from 'node:events';
import {
  SIDE_CHAT_WINDOW_DEFAULT_SIZE,
  SIDE_CHAT_WINDOW_MARGIN,
  SIDE_CHAT_WINDOW_MIN_SIZE,
  SIDE_CHAT_WINDOW_NAME,
} from '@shared/sideChatWindow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Decision 209 §3: Main's half of the side chat's own window — only its
 * frame name gets through, as a frameless window owned by the main window,
 * at its remembered place while that is still on a screen.
 */
const state = vi.hoisted(() => ({
  saved: null as string | null,
  written: [] as string[],
  displays: [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
  openExternal: vi.fn(async (_url: string) => undefined),
}));

vi.mock('node:fs', () => ({
  readFileSync: () => {
    if (state.saved === null) throw new Error('ENOENT');
    return state.saved;
  },
  writeFileSync: (_path: string, data: string) => state.written.push(data),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/user-data' },
  screen: { getAllDisplays: () => state.displays },
  shell: { openExternal: state.openExternal },
}));

const {
  appWindowOf,
  isReachable,
  isSideChatWindow,
  resolveSideChatBounds,
  sideChatWindowOpenResponse,
  watchSideChatWindows,
} = await import('../sideChatWindow');

class FakeContents extends EventEmitter {
  windowOpenHandler: ((details: { url: string }) => unknown) | null = null;
  setWindowOpenHandler(handler: (details: { url: string }) => unknown) {
    this.windowOpenHandler = handler;
  }
}

class FakeWindow extends EventEmitter {
  webContents = new FakeContents();
  destroyed = false;
  menuRemoved = false;
  bounds = { x: 100, y: 100, width: 1400, height: 900 };
  parent: FakeWindow | null = null;
  getBounds() {
    return this.bounds;
  }
  getBackgroundColor() {
    return '#faf9f5';
  }
  getParentWindow() {
    return this.parent;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return false;
  }
  removeMenu() {
    this.menuRemoved = true;
  }
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
}

beforeEach(() => {
  state.saved = null;
  state.written = [];
  state.openExternal.mockClear();
});

const SCREEN = { x: 0, y: 0, width: 1920, height: 1040 };

describe('resolveSideChatBounds', () => {
  const parent = { x: 100, y: 100, width: 1400, height: 900 };

  it('first time: the main window’s bottom-right corner, 16px in, at the default size', () => {
    expect(resolveSideChatBounds({ saved: null, workAreas: [SCREEN], parent })).toEqual({
      x: 100 + 1400 - SIDE_CHAT_WINDOW_DEFAULT_SIZE.width - SIDE_CHAT_WINDOW_MARGIN,
      y: 100 + 900 - SIDE_CHAT_WINDOW_DEFAULT_SIZE.height - SIDE_CHAT_WINDOW_MARGIN,
      ...SIDE_CHAT_WINDOW_DEFAULT_SIZE,
    });
  });

  it('the remembered place, even on another screen, while its top strip is on one', () => {
    const second = { x: 1920, y: 0, width: 1280, height: 1024 };
    const saved = { x: 2400, y: 300, width: 500, height: 600 };
    expect(resolveSideChatBounds({ saved, workAreas: [SCREEN, second], parent })).toEqual(saved);
  });

  it('a place on no screen any more (the monitor was unplugged) falls back', () => {
    const saved = { x: 2400, y: 300, width: 500, height: 600 };
    expect(resolveSideChatBounds({ saved, workAreas: [SCREEN], parent }).x).toBe(
      100 + 1400 - SIDE_CHAT_WINDOW_DEFAULT_SIZE.width - SIDE_CHAT_WINDOW_MARGIN
    );
  });

  it('never smaller than the minimum; kept on the main window’s screen', () => {
    const tiny = { x: 10, y: 10, width: 100, height: 100 };
    expect(resolveSideChatBounds({ saved: tiny, workAreas: [SCREEN], parent })).toMatchObject(
      SIDE_CHAT_WINDOW_MIN_SIZE
    );
    // A main window hanging off the left edge: the corner is pulled back on screen.
    const off = { x: -1200, y: 0, width: 1300, height: 600 };
    const placed = resolveSideChatBounds({ saved: null, workAreas: [SCREEN], parent: off });
    expect(placed.x).toBe(0);
  });

  it('reachable means its top strip can still be grabbed', () => {
    expect(isReachable({ x: 1900, y: 10, width: 400, height: 400 }, [SCREEN])).toBe(false);
    expect(isReachable({ x: 1800, y: 10, width: 400, height: 400 }, [SCREEN])).toBe(true);
    expect(isReachable({ x: 100, y: -30, width: 400, height: 400 }, [SCREEN])).toBe(false);
  });
});

describe('sideChatWindowOpenResponse', () => {
  it('not the side chat: not ours (the usual rule applies)', () => {
    const parent = new FakeWindow();
    expect(
      sideChatWindowOpenResponse({ url: 'https://x.test', frameName: '' }, parent as never)
    ).toBeNull();
  });

  it('the side chat’s name with anything but about:blank is refused', () => {
    const parent = new FakeWindow();
    expect(
      sideChatWindowOpenResponse(
        { url: 'https://x.test', frameName: SIDE_CHAT_WINDOW_NAME },
        parent as never
      )
    ).toEqual({ action: 'deny' });
  });

  it('let through as a frameless window owned by the main one, no taskbar entry', () => {
    const parent = new FakeWindow();
    state.saved = JSON.stringify({ x: 300, y: 200, width: 420, height: 500 });
    const response = sideChatWindowOpenResponse(
      { url: 'about:blank', frameName: SIDE_CHAT_WINDOW_NAME },
      parent as never
    );
    expect(response).toMatchObject({
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent,
        frame: false,
        skipTaskbar: true,
        resizable: true,
        x: 300,
        y: 200,
        width: 420,
        height: 500,
        minWidth: SIDE_CHAT_WINDOW_MIN_SIZE.width,
        minHeight: SIDE_CHAT_WINDOW_MIN_SIZE.height,
        backgroundColor: '#faf9f5',
      },
    });
  });

  it('a remembered place that cannot be read is no place', () => {
    const parent = new FakeWindow();
    state.saved = '{"x": "left"}';
    const response = sideChatWindowOpenResponse(
      { url: 'about:blank', frameName: SIDE_CHAT_WINDOW_NAME },
      parent as never
    ) as { overrideBrowserWindowOptions: { width: number } };
    expect(response.overrideBrowserWindowOptions.width).toBe(SIDE_CHAT_WINDOW_DEFAULT_SIZE.width);
  });
});

describe('watchSideChatWindows', () => {
  function open() {
    const parent = new FakeWindow();
    watchSideChatWindows(parent as never);
    const child = new FakeWindow();
    child.parent = parent;
    child.bounds = { x: 5, y: 6, width: 400, height: 450 };
    parent.webContents.emit('did-create-window', child, { frameName: SIDE_CHAT_WINDOW_NAME });
    return { parent, child };
  }

  it('it is known as the side chat, and answers for its owner', () => {
    const { parent, child } = open();
    expect(isSideChatWindow(child as never)).toBe(true);
    expect(isSideChatWindow(parent as never)).toBe(false);
    expect(appWindowOf(child as never)).toBe(parent);
    expect(appWindowOf(parent as never)).toBe(parent);
    expect(child.menuRemoved).toBe(true);
  });

  it('never navigates: links go to the system browser', () => {
    const { child } = open();
    expect(child.webContents.windowOpenHandler?.({ url: 'https://a.test' })).toEqual({
      action: 'deny',
    });
    const event = { preventDefault: vi.fn() };
    child.webContents.emit('will-navigate', event, 'https://b.test');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(state.openExternal.mock.calls.map(([url]) => url)).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
  });

  it('remembers its place when it closes', () => {
    const { child } = open();
    child.emit('close');
    expect(state.written.map((data) => JSON.parse(data))).toEqual([
      { x: 5, y: 6, width: 400, height: 450 },
    ]);
  });

  it('closes with the main window', () => {
    const { parent, child } = open();
    parent.emit('closed');
    expect(child.destroyed).toBe(true);
    expect(isSideChatWindow(child as never)).toBe(false);
  });

  it('other windows the page opens are left alone', () => {
    const parent = new FakeWindow();
    watchSideChatWindows(parent as never);
    const other = new FakeWindow();
    parent.webContents.emit('did-create-window', other, { frameName: 'something-else' });
    expect(isSideChatWindow(other as never)).toBe(false);
    expect(other.menuRemoved).toBe(false);
  });
});
