// @vitest-environment happy-dom
/**
 * dsh-rebase P1-7e e3 (problem 15, decision 142): Ctrl+F in a focused
 * terminal. xterm handles the key before any window listener hears it and
 * sent ^F to the shell (point-check E6: the capture phase saw the chord, the
 * bubble phase did not, the pty answered with a bell). The terminal's own
 * key hook now opens the search and keeps the chord from the shell; every
 * other key — Esc for vim and less first — still reaches the shell.
 *
 * `useXterm` is stubbed: what is under test is the hook `ShellTerminal`
 * hands it (`onCustomKey`) and the search bar that answers.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => {
  const write = vi.fn();
  window.electronAPI = {
    env: { platform: 'linux' },
    session: { write },
    contextMenu: { show: async () => null },
  } as unknown as typeof window.electronAPI;
  return {
    write,
    onCustomKey: undefined as undefined | ((event: KeyboardEvent, ptyId: string) => boolean),
  };
});

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (state: { xtermKeybindings: object }) => unknown) =>
    select({ xtermKeybindings: {} }),
}));
vi.mock('@/hooks/useTerminalScrollToBottom', () => ({
  useTerminalScrollToBottom: () => ({ showScrollToBottom: false, handleScrollToBottom: () => {} }),
}));
vi.mock('@/hooks/useXterm', async () => {
  const { useRef } = await import('react');
  return {
    useXterm: (options: { onCustomKey?: (event: KeyboardEvent, ptyId: string) => boolean }) => {
      probe.onCustomKey = options.onCustomKey;
      return {
        containerRef: useRef(null),
        isLoading: false,
        runtimeState: 'live',
        settings: { theme: { background: '#000000', foreground: '#ffffff' } },
        findNext: () => false,
        findPrevious: () => false,
        clearSearch: () => {},
        terminal: null,
        clear: () => {},
        refreshRenderer: () => {},
      };
    },
  };
});

const { ShellTerminal, isTerminalSearchShortcut } = await import('../ShellTerminal');

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  probe.write.mockClear();
  probe.onCustomKey = undefined;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ShellTerminal, { isActive: true })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function key(type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent(type, { cancelable: true, bubbles: true, ...init });
}

async function press(event: KeyboardEvent): Promise<boolean> {
  let passed = true;
  await act(async () => {
    passed = probe.onCustomKey?.(event, 'pty-1') ?? true;
  });
  return passed;
}

describe('the terminal search chord (P1-7e problem 15)', () => {
  it('[E3-15-CHORD] Ctrl+F on Linux and Windows, Cmd+F on macOS, with nothing else held', () => {
    const f = { key: 'f', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(isTerminalSearchShortcut({ ...f, ctrlKey: true }, 'linux')).toBe(true);
    expect(isTerminalSearchShortcut({ ...f, ctrlKey: true }, 'win32')).toBe(true);
    expect(isTerminalSearchShortcut({ ...f, key: 'F', ctrlKey: true }, 'linux')).toBe(true);
    expect(isTerminalSearchShortcut({ ...f, ctrlKey: true, shiftKey: true }, 'linux')).toBe(false);
    expect(isTerminalSearchShortcut({ ...f, ctrlKey: true, altKey: true }, 'linux')).toBe(false);
    expect(isTerminalSearchShortcut({ ...f, metaKey: true }, 'linux')).toBe(false);
    expect(isTerminalSearchShortcut({ ...f, metaKey: true }, 'darwin')).toBe(true);
    // Ctrl+F on macOS is readline's forward-char: the shell's.
    expect(isTerminalSearchShortcut({ ...f, ctrlKey: true }, 'darwin')).toBe(false);
    expect(isTerminalSearchShortcut({ ...f, key: 'Escape' }, 'linux')).toBe(false);
  });

  it('[E3-15-OPEN] a focused terminal opens its search on Ctrl+F and keeps ^F from the shell', async () => {
    expect(container.querySelector('input')).toBeNull();
    const down = key('keydown', { key: 'f', ctrlKey: true });
    expect(await press(down)).toBe(false);
    expect(down.defaultPrevented).toBe(true);
    expect(container.querySelector('input')).not.toBeNull();
    // The release is swallowed too, and does not toggle anything.
    expect(await press(key('keyup', { key: 'f', ctrlKey: true }))).toBe(false);
    expect(container.querySelector('input')).not.toBeNull();
    expect(probe.write).not.toHaveBeenCalled();
  });

  it('[E3-15-SHELL] Esc and other keys still reach the shell; Shift+Enter still sends a newline', async () => {
    expect(await press(key('keydown', { key: 'Escape' }))).toBe(true);
    expect(await press(key('keydown', { key: 'f', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(await press(key('keydown', { key: 'a', ctrlKey: true }))).toBe(true);
    expect(container.querySelector('input')).toBeNull();
    expect(await press(key('keydown', { key: 'Enter', shiftKey: true }))).toBe(false);
    expect(probe.write).toHaveBeenCalledWith('pty-1', '\n');
  });
});
