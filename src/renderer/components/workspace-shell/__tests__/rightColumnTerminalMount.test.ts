// @vitest-environment happy-dom
/**
 * dsh-rebase P1-11 (decisions 109, 126, 128; prototype scene G), rendered: the
 * title bar's terminal button and the shell it opens — since design system v2
 * / layout 5a, in the work panel's 终端 tab.
 *
 * What only a mounted shell can show:
 *  - the button is disabled, with the reason, when the conversation has no
 *    folder (decision 126 rule 2), and opening never falls back to $HOME;
 *  - the panel is closed until asked for (ruling L3);
 *  - closing the terminal brings the same file tabs back (decision 126 rule
 *    1) — the panel falls back to the tab shown before it;
 *  - it and the session review are tabs of one panel, never shown together;
 *  - hiding (the toggle, a file opening, another tab) keeps the shell mounted
 *    — only the ✕, the shell exiting, or its folder going away unmounts it,
 *    and an unmount is what ends a local shell;
 *  - switching conversations shows each folder's own shell.
 *
 * Everything the panel does not need is stubbed: the chat column, the
 * sidebar, the editor (a marker div — its layer's classes are what is under
 * test), the review panel (two buttons), the git dot, and the shell itself
 * (records its mounts, never spawns a pty).
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
vi.mock('../useGitChangeCount', () => ({ useGitChangeCount: () => 0 }));
// The registry surfaces (files, git, …) are not under test: one marker view.
vi.mock('../surfaceViews', async () => {
  const { createElement: h } = await import('react');
  const view = (props: { surfaceId: string; active: boolean }) =>
    h('div', { 'data-testid': `surface-${props.surfaceId}`, 'data-active': String(props.active) });
  return {
    SURFACE_VIEWS: {
      editor: { component: view, mountPolicy: 'active' },
      git: { component: view, mountPolicy: 'active' },
      context: { component: view, mountPolicy: 'active' },
      run: { component: view, mountPolicy: 'active' },
      terminal: { component: view, mountPolicy: 'keep-alive' },
    },
  };
});
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
const { useShellLayoutStore } = await import('@/stores/shellLayout');
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
  if (!button) throw new Error('no terminal button on the title bar');
  return button;
}

async function click(element: Element | null) {
  if (!element) throw new Error('nothing to click');
  await act(async () => (element as HTMLElement).click());
}

function classes(element: Element | null | undefined): string[] {
  return element?.className.split(/\s+/) ?? [];
}

/** `closed`, or the tab the work panel shows. */
function panelShows(): string | null {
  return container.querySelector('[data-work-panel]')?.getAttribute('data-work-panel') ?? null;
}

/** Files show: the panel is on its editor tab and the editor layer has a box. */
function editorShowing(): boolean {
  const layer = container.querySelector('[data-panel-layer="editor"]');
  return panelShows() === 'editor' && layer !== null && !classes(layer).includes('hidden');
}

/** The terminal shows: the panel is on its terminal tab and the layer is visible. */
function terminalShowing(): boolean {
  const layer = container.querySelector('[data-panel-layer="terminal"]');
  return panelShows() === 'terminal' && layer !== null && !classes(layer).includes('invisible');
}

function shells(): { cwd: string | null; active: string | null; shown: boolean }[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="shell"]')].map((shell) => ({
    cwd: shell.getAttribute('data-cwd'),
    active: shell.getAttribute('data-active'),
    shown: !classes(shell.parentElement).includes('invisible'),
  }));
}

const changesButton = () => container.querySelector('button[data-panel-toggle="changes"]');
const stripTab = (tab: string) => container.querySelector(`button[data-panel-tab="${tab}"]`);

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
  useShellLayoutStore.setState({
    workPanelOpen: false,
    workPanelTab: 'files',
    workPanelHistory: [],
    expanded: false,
  });
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

describe('the title bar terminal button', () => {
  it('is disabled, and says why, for a conversation with no folder', async () => {
    await select('s0');
    const button = terminalButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-session-terminal')).toBe('unavailable');
    const reason = 'This conversation has no folder to open a terminal in';
    expect(button.getAttribute('aria-label')).toBe(reason);
    // The reason stays reachable on hover even though the button takes no events.
    expect(button.parentElement?.getAttribute('title')).toBe(reason);
    await click(button);
    expect(useColumnTerminalStore.getState().terminals).toEqual({});
    expect(container.querySelector('[data-testid="terminal-column"]')).toBeNull();
    expect(probe.mounts).toEqual([]);
  });

  it('sits before the changes and files buttons; background work only shows while it runs', () => {
    const bar = container.querySelector('[data-session-bar]');
    const order = [
      ...(bar?.querySelectorAll(
        'button[data-session-terminal], button[data-panel-toggle], button[data-subwindow]'
      ) ?? []),
    ].map(
      (button) =>
        button.getAttribute('data-session-terminal') ??
        button.getAttribute('data-panel-toggle') ??
        button.getAttribute('data-subwindow')
    );
    expect(order).toEqual(['closed', 'changes', 'files']);
  });
});

describe('the work panel opens on demand (ruling L3)', () => {
  it('is closed when a conversation opens, yet keeps the editor mounted for file intents', () => {
    expect(panelShows()).toBe('closed');
    // Round-10 ⑥: the editor is the intent consumer; closed means `hidden`.
    const layer = container.querySelector('[data-panel-layer="editor"]');
    expect(layer).not.toBeNull();
    expect(classes(layer)).toContain('hidden');
  });

  it('the files button toggles the files tab, which is told when it is on screen', async () => {
    await click(container.querySelector('button[data-panel-toggle="files"]'));
    expect(panelShows()).toBe('files');
    const tree = () => container.querySelector('[data-testid="surface-editor"]');
    expect(tree()?.getAttribute('data-active')).toBe('true');
    await click(container.querySelector('button[data-panel-toggle="files"]'));
    expect(panelShows()).toBe('closed');
    // Still mounted across the close (the dock's rule), but no longer active.
    expect(tree()?.getAttribute('data-active')).toBe('false');
  });
});

describe('the terminal in the work panel', () => {
  it('takes the files’ place, and closing it brings the same file tabs back', async () => {
    const tabsBefore = useEditorStore.getState().tabs;
    await act(async () => useShellLayoutStore.getState().openWorkPanel('editor'));
    expect(editorShowing()).toBe(true);

    await click(terminalButton());
    expect(terminalShowing()).toBe(true);
    expect(editorShowing()).toBe(false);
    expect(terminalButton().getAttribute('aria-pressed')).toBe('true');
    expect(shells()).toEqual([{ cwd: ALPHA, active: 'true', shown: true }]);
    // The column names the folder (prototype scene G).
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

  it('opens with no file open too, and the toggle closes it without ending the shell', async () => {
    await act(async () => useEditorStore.setState({ tabs: [], activeTabPath: null }));
    await click(terminalButton());
    expect(terminalShowing()).toBe(true);

    await click(terminalButton());
    expect(terminalShowing()).toBe(false);
    expect(panelShows()).toBe('closed');
    expect(probe.unmounts).toEqual([]);
    expect(shells()).toEqual([{ cwd: ALPHA, active: 'false', shown: true }]);
    // Running out of sight is marked, and a click brings the same shell back.
    expect(terminalButton().getAttribute('data-session-terminal')).toBe('hidden');
    expect(terminalButton().getAttribute('aria-label')).toBe('Terminal (still running)');
    await click(terminalButton());
    expect(terminalShowing()).toBe(true);
    expect(probe.mounts).toEqual([ALPHA]);
  });

  it('shares the panel with the review as tabs, never shown together', async () => {
    await click(terminalButton());
    await click(changesButton());
    // The review is on screen; the terminal waits behind it, still running.
    expect(container.querySelector('[data-testid="review"]')).not.toBeNull();
    expect(terminalShowing()).toBe(false);
    expect(editorShowing()).toBe(false);
    expect(terminalButton().getAttribute('data-session-terminal')).toBe('hidden');
    await click(stripTab('terminal'));
    expect(terminalShowing()).toBe(true);
    expect(container.querySelector('[data-testid="review"]')).toBeNull();

    // The review's Files button means the files, not the terminal behind it.
    await click(changesButton());
    await click(container.querySelector('[data-testid="review"] button[aria-label="Files"]'));
    expect(container.querySelector('[data-testid="review"]')).toBeNull();
    expect(editorShowing()).toBe(true);
    expect(terminalShowing()).toBe(false);

    // Closing the review closes the panel; the shell keeps running.
    await click(changesButton());
    await click(container.querySelector('button[aria-label="Close review"]'));
    expect(panelShows()).toBe('closed');
    expect(probe.unmounts).toEqual([]);
  });

  it('steps behind a file being opened, and the strip brings it back', async () => {
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

    await click(stripTab('terminal'));
    expect(terminalShowing()).toBe(true);
    await click(stripTab('editor'));
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
    expect(editorShowing()).toBe(true);
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

    // Back in alpha's folder the terminal tab is back, by itself.
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
