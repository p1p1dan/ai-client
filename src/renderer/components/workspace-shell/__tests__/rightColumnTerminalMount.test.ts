// @vitest-environment happy-dom
/**
 * dsh-rebase P1-11 (decisions 109, 126, 128; prototype scene G), rendered: the
 * session bar's terminal button and the shell it opens in the right column.
 *
 * What only a mounted shell can show:
 *  - the button is disabled, with the reason, when the conversation has no
 *    folder (decision 126 rule 2), and opening never falls back to $HOME;
 *  - the terminal takes the files' place and closing it brings the same file
 *    tabs back (decision 126 rule 1);
 *  - it and the session review never show together, and each one closing
 *    reveals what was under it;
 *  - hiding (the toggle, a file opening) keeps the shell mounted — only the
 *    tab's ✕, the shell exiting, or its folder going away unmounts it, and an
 *    unmount is what ends a local shell;
 *  - switching conversations shows each folder's own shell.
 *
 * Everything the column does not need is stubbed: the chat column, the dock,
 * the editor (a marker div — its wrapper's classes are what is under test),
 * the review panel (two buttons), and the shell itself (records its mounts,
 * never spawns a pty).
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => {
  // Must be hoisted: the settings store rehydrates from `electronAPI` at
  // import time, and a stub installed in `beforeEach` arrives after that read.
  window.electronAPI = {
    env: { platform: 'linux', HOME: '/home/nobody' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined },
  } as unknown as typeof window.electronAPI;
  return {
    mounts: [] as string[],
    unmounts: [] as string[],
    exits: new Map<string, () => void>(),
  };
});

// The settings store's renderer logger never finishes loading outside
// Electron; every settings-store test stubs it the same way.
vi.mock('@/utils/logging', () => ({ updateRendererLogging: () => {} }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/components/chat/ChatWorkspace', async () => {
  const { createElement: h } = await import('react');
  return { ChatWorkspace: () => h('div', { 'data-testid': 'chat' }) };
});
vi.mock('@/components/chat/SessionTreeDialog', () => ({ SessionTreeDialog: () => null }));
vi.mock('@/components/search/GlobalSearchDialog', () => ({ GlobalSearchDialog: () => null }));
vi.mock('../LeftDock', () => ({ LeftDock: () => null }));
vi.mock('../useCapacityReclaimNotice', () => ({ useCapacityReclaimNotice: () => {} }));
vi.mock('../useEditorWorktreeSync', () => ({ useEditorWorktreeSync: () => {} }));
vi.mock('../useShellShortcuts', () => ({ useShellShortcuts: () => {} }));
vi.mock('../useSyncChatWorkspaceTree', () => ({ useSyncChatWorkspaceTree: () => {} }));
vi.mock('../useWorkspaceSearch', () => ({
  useWorkspaceSearch: () => ({
    request: null,
    openSearch: () => {},
    closeSearch: () => {},
    onOpenFile: () => {},
  }),
}));
vi.mock('../center/EditorColumn', async () => {
  const { createElement: h } = await import('react');
  return { EditorColumn: () => h('div', { 'data-testid': 'editor-column' }) };
});
vi.mock('../SessionReviewPanel', async () => {
  const { createElement: h } = await import('react');
  return {
    SessionReviewPanel: (props: { onClose: () => void; onShowFiles: () => void }) =>
      h(
        'section',
        { 'data-testid': 'review' },
        h('button', { type: 'button', 'aria-label': 'Close review', onClick: props.onClose }),
        h('button', { type: 'button', 'aria-label': 'Files', onClick: props.onShowFiles })
      ),
  };
});
vi.mock('@/components/terminal/ShellTerminal', async () => {
  const React = await import('react');
  return {
    ShellTerminal: (props: { cwd?: string; isActive?: boolean; onExit?: () => void }) => {
      const cwd = props.cwd ?? '';
      probe.exits.set(cwd, () => props.onExit?.());
      React.useEffect(() => {
        probe.mounts.push(cwd);
        return () => {
          probe.unmounts.push(cwd);
        };
      }, [cwd]);
      return React.createElement('div', {
        'data-testid': 'shell',
        'data-cwd': cwd,
        'data-active': String(Boolean(props.isActive)),
      });
    },
  };
});

const { WorkspaceShell } = await import('../WorkspaceShell');
const { useChatSessionsStore } = await import('@/stores/chatSessions');
const { useEditorStore } = await import('@/stores/editor');
const { useColumnTerminalStore } = await import('@/stores/columnTerminal');
const { useWorktreeActivityStore } = await import('@/stores/worktreeActivity');
const { readSignInLosses } = await import('@/stores/signInConfirm');

const ALPHA = '/repo/alpha';
const BETA = '/repo/beta';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function seed(activeSessionId: string) {
  useChatSessionsStore.setState({
    activeSessionId,
    projects: [
      { id: 'p1', name: 'repo' },
      { id: 'p0', name: '' },
    ],
    workspaces: [
      { id: 'w1', projectId: 'p1', name: 'Main', kind: 'main', path: ALPHA },
      { id: 'w2', projectId: 'p1', name: 'feature', kind: 'worktree', path: BETA },
      // The seeded placeholder an unbound chat sits on: no path.
      { id: 'w0', projectId: 'p0', name: '', kind: 'main', path: '' },
    ],
    sessions: [
      { id: 's1', projectId: 'p1', workspaceId: 'w1', title: 'one', status: 'idle', updatedAt: 0 },
      {
        id: 's1b',
        projectId: 'p1',
        workspaceId: 'w1',
        title: 'one-b',
        status: 'idle',
        updatedAt: 0,
      },
      { id: 's2', projectId: 'p1', workspaceId: 'w2', title: 'two', status: 'idle', updatedAt: 0 },
      {
        id: 's0',
        projectId: 'p0',
        workspaceId: 'w0',
        title: 'scratch',
        status: 'idle',
        updatedAt: 0,
        // An unbound chat has a scratch directory; it is not a folder to open a shell in.
        unbound: { workspacePath: '/tmp/scratch' },
      },
    ],
    messages: {},
  });
}

async function select(sessionId: string) {
  await act(async () => useChatSessionsStore.setState({ activeSessionId: sessionId }));
}

function terminalButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[data-session-terminal]');
  if (!button) throw new Error('no terminal button on the session bar');
  return button;
}

async function click(element: Element | null) {
  if (!element) throw new Error('nothing to click');
  await act(async () => (element as HTMLElement).click());
}

/** The nearest column wrapper WorkspaceShell draws (they all animate width). */
function columnWrapperOf(testId: string): HTMLElement | null {
  let node = container.querySelector(`[data-testid="${testId}"]`)?.parentElement ?? null;
  while (node && !node.className.includes('transition-[width]')) node = node.parentElement;
  return node;
}

function classes(element: Element | null | undefined): string[] {
  return element?.className.split(/\s+/) ?? [];
}

/** Files show: the editor's wrapper exists and is not `hidden`. */
function editorShowing(): boolean {
  const wrapper = columnWrapperOf('editor-column');
  return wrapper !== null && !classes(wrapper).includes('hidden');
}

/** The terminal shows: its wrapper sits in the row rather than parked out of sight. */
function terminalShowing(): boolean {
  const wrapper = columnWrapperOf('terminal-column');
  return wrapper !== null && !classes(wrapper).includes('invisible');
}

function shells(): { cwd: string | null; active: string | null; shown: boolean }[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="shell"]')].map((shell) => ({
    cwd: shell.getAttribute('data-cwd'),
    active: shell.getAttribute('data-active'),
    shown: !classes(shell.parentElement).includes('invisible'),
  }));
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  if (typeof globalThis.ResizeObserver === 'undefined') {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  }
  probe.mounts.length = 0;
  probe.unmounts.length = 0;
  probe.exits.clear();
  useColumnTerminalStore.setState({ terminals: {} });
  useEditorStore.setState({
    tabs: [{ path: `${ALPHA}/a.ts`, title: 'a.ts', content: '', isDirty: false }],
    activeTabPath: `${ALPHA}/a.ts`,
    worktreeStates: {},
    currentWorktreePath: ALPHA,
  });
  seed('s1');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(WorkspaceShell, {})));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('the session bar terminal button', () => {
  it('is disabled, and says why, for a conversation with no folder', async () => {
    await select('s0');
    const button = terminalButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-session-terminal')).toBe('unavailable');
    expect(button.title).toBe('This conversation has no folder to open a terminal in');
    // The reason stays reachable on hover even though the button takes no events.
    expect(button.parentElement?.getAttribute('title')).toBe(button.title);
    await click(button);
    expect(useColumnTerminalStore.getState().terminals).toEqual({});
    expect(container.querySelector('[data-testid="terminal-column"]')).toBeNull();
    expect(probe.mounts).toEqual([]);
  });

  it('sits first in the group with the two sub-window toggles', () => {
    const group = terminalButton().closest('.border-l');
    const toggles = [...(group?.querySelectorAll('button') ?? [])].map(
      (button) =>
        button.getAttribute('data-session-terminal') ?? button.getAttribute('data-subwindow')
    );
    expect(toggles).toEqual(['closed', 'jobs', 'agents']);
  });
});

describe('the terminal in the right column', () => {
  it('takes the files’ place, and closing it brings the same file tabs back', async () => {
    const tabsBefore = useEditorStore.getState().tabs;
    expect(editorShowing()).toBe(true);

    await click(terminalButton());
    expect(terminalShowing()).toBe(true);
    expect(editorShowing()).toBe(false);
    expect(terminalButton().getAttribute('aria-pressed')).toBe('true');
    expect(shells()).toEqual([{ cwd: ALPHA, active: 'true', shown: true }]);
    // The column names the folder under its tab (prototype scene G).
    const column = container.querySelector('[data-testid="terminal-column"]');
    expect(column?.textContent).toContain('Session directory');
    expect(column?.textContent).toContain(ALPHA);

    await click(container.querySelector('button[aria-label="Close terminal"]'));
    expect(container.querySelector('[data-testid="terminal-column"]')).toBeNull();
    expect(probe.unmounts).toEqual([ALPHA]);
    expect(editorShowing()).toBe(true);
    expect(useEditorStore.getState().tabs).toBe(tabsBefore);
    expect(terminalButton().getAttribute('data-session-terminal')).toBe('closed');
  });

  it('opens with no file open too, and the toggle hides it without ending the shell', async () => {
    await act(async () => useEditorStore.setState({ tabs: [], activeTabPath: null }));
    await click(terminalButton());
    expect(terminalShowing()).toBe(true);

    await click(terminalButton());
    expect(terminalShowing()).toBe(false);
    expect(probe.unmounts).toEqual([]);
    expect(shells()).toEqual([{ cwd: ALPHA, active: 'false', shown: true }]);
    // Running out of sight is marked, and a click brings the same shell back.
    expect(terminalButton().getAttribute('data-session-terminal')).toBe('hidden');
    expect(terminalButton().title).toBe('Terminal (still running)');
    await click(terminalButton());
    expect(terminalShowing()).toBe(true);
    expect(probe.mounts).toEqual([ALPHA]);
  });

  it('never shows together with the review; each closing reveals what was under it', async () => {
    await click(terminalButton());
    await click(container.querySelector('button[title="Session review"]'));
    // The review goes on top; the terminal waits under it, still running.
    expect(container.querySelector('[data-testid="review"]')).not.toBeNull();
    expect(terminalShowing()).toBe(false);
    expect(editorShowing()).toBe(false);
    expect(terminalButton().getAttribute('data-session-terminal')).toBe('hidden');
    await click(container.querySelector('button[aria-label="Close review"]'));
    expect(terminalShowing()).toBe(true);

    // Opening the terminal closes the review.
    await click(container.querySelector('button[title="Session review"]'));
    await click(terminalButton());
    expect(container.querySelector('[data-testid="review"]')).toBeNull();
    expect(terminalShowing()).toBe(true);

    // The review's Files button means the files, not the terminal under it.
    await click(container.querySelector('button[title="Session review"]'));
    await click(container.querySelector('[data-testid="review"] button[aria-label="Files"]'));
    expect(container.querySelector('[data-testid="review"]')).toBeNull();
    expect(editorShowing()).toBe(true);
    expect(terminalShowing()).toBe(false);
    expect(probe.unmounts).toEqual([]);
  });

  it('steps behind a file being opened, and its own Files button does the same', async () => {
    await click(terminalButton());
    await act(async () =>
      useEditorStore.setState({
        tabs: [
          ...useEditorStore.getState().tabs,
          { path: `${ALPHA}/b.ts`, title: 'b.ts', content: '', isDirty: false },
        ],
        activeTabPath: `${ALPHA}/b.ts`,
      })
    );
    expect(editorShowing()).toBe(true);
    expect(terminalShowing()).toBe(false);

    await click(terminalButton());
    await click(
      container.querySelector('[data-testid="terminal-column"] button[aria-label="Files"]')
    );
    expect(editorShowing()).toBe(true);
    expect(terminalShowing()).toBe(false);
    expect(probe.unmounts).toEqual([]);
  });

  it('[E3-21-REVEAL] steps behind a request for the file that is already the active tab (P1-7e problem 21)', async () => {
    await click(terminalButton());
    expect(terminalShowing()).toBe(true);
    const before = useEditorStore.getState();
    // The file tree's click on `a.ts`, already active: no tab changes, only the request.
    await act(async () => useEditorStore.getState().requestReveal());
    expect(useEditorStore.getState().activeTabPath).toBe(before.activeTabPath);
    expect(useEditorStore.getState().tabs).toBe(before.tabs);
    expect(editorShowing()).toBe(true);
    expect(terminalShowing()).toBe(false);
    // Still running behind the files.
    expect(probe.unmounts).toEqual([]);
    expect(terminalButton().getAttribute('data-session-terminal')).toBe('hidden');

    // The same for the diff that is already showing (the git panel's click).
    const target = { kind: 'workdir' as const, path: 'a.ts', staged: false };
    await act(async () => useEditorStore.getState().openDiffTab(target));
    await click(terminalButton());
    expect(terminalShowing()).toBe(true);
    await act(async () => useEditorStore.getState().openDiffTab(target));
    expect(terminalShowing()).toBe(false);
  });

  it('keeps one shell per folder across conversation switches', async () => {
    await click(terminalButton());
    // Another chat in the same folder shares the shell.
    await select('s1b');
    expect(terminalShowing()).toBe(true);
    expect(shells()).toEqual([{ cwd: ALPHA, active: 'true', shown: true }]);

    // Another folder: its own state (no shell yet), alpha's keeps running.
    await select('s2');
    expect(terminalShowing()).toBe(false);
    expect(terminalButton().getAttribute('data-session-terminal')).toBe('closed');
    await click(terminalButton());
    expect(shells()).toEqual([
      { cwd: ALPHA, active: 'false', shown: false },
      { cwd: BETA, active: 'true', shown: true },
    ]);

    // A chat with no folder shows neither and cannot open one.
    await select('s0');
    expect(terminalShowing()).toBe(false);
    expect(terminalButton().disabled).toBe(true);

    await select('s1');
    expect(terminalShowing()).toBe(true);
    expect(shells().find((shell) => shell.shown)?.cwd).toBe(ALPHA);
    expect(probe.unmounts).toEqual([]);
    // Both count as terminals the sign-in confirmation will close.
    expect(readSignInLosses().shellTerminals).toBe(2);
  });

  it('ends when the shell exits or its workspace is deleted', async () => {
    await click(terminalButton());
    await select('s2');
    await click(terminalButton());

    await act(async () => probe.exits.get(BETA)?.());
    expect(probe.unmounts).toEqual([BETA]);
    expect(terminalShowing()).toBe(false);

    await act(async () => useWorktreeActivityStore.getState().closeTerminalSessions(ALPHA));
    expect(probe.unmounts).toEqual([BETA, ALPHA]);
    expect(container.querySelector('[data-testid="terminal-column"]')).toBeNull();
    expect(useColumnTerminalStore.getState().terminals).toEqual({});
  });

  it('forgets its shells when the shell view unmounts (they end with it)', async () => {
    await click(terminalButton());
    await act(async () => root.unmount());
    expect(probe.unmounts).toEqual([ALPHA]);
    expect(useColumnTerminalStore.getState().terminals).toEqual({});
    // Re-created for afterEach's unmount.
    root = createRoot(container);
  });
});
