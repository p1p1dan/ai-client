// @vitest-environment happy-dom
/**
 * dsh-rebase P1-11 (decisions 109, 126, 128; prototype scene G), rendered: the
 * title bar's terminal button and the shell it opens — since layout 5d, in
 * the terminal pane card beside the others.
 *
 * What only a mounted shell can show:
 *  - the button is disabled, with the reason, when the conversation has no
 *    folder (decision 126 rule 2), and opening never falls back to $HOME;
 *  - no pane is open until asked for (ruling L3);
 *  - the terminal is its own card: opening it leaves the file tabs and the
 *    review where they are (decision 126 rule 1 holds trivially now);
 *  - hiding (the toggle, the card's ✕, Escape) keeps the shell mounted —
 *    only ending it, the shell exiting, or its folder going away unmounts it,
 *    and an unmount is what ends a local shell;
 *  - switching conversations shows each folder's own shell;
 *  - up to four cards by open order, and ⤢ gives one card the row.
 *
 * Everything the panes do not need is stubbed: the chat column, the sidebar,
 * the editor (a marker div), the review (one button), the tasks pane, and
 * the shell itself (records its mounts, never spawns a pty).
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
    SessionReviewPanel: (props: { onOpenDiff: () => void }) =>
      h(
        'section',
        { 'data-testid': 'review' },
        h('button', { type: 'button', 'aria-label': 'Open diff', onClick: props.onOpenDiff })
      ),
  };
});
vi.mock('../panes/BackgroundTasksPane', async () => {
  const { createElement: h } = await import('react');
  return { BackgroundTasksPane: () => h('div', { 'data-testid': 'tasks' }) };
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

/** `closed`, or the panes on screen in slot order. */
function areaShows(): string | null {
  return container.querySelector('[data-pane-area]')?.getAttribute('data-pane-area') ?? null;
}

function card(kind: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-pane="${kind}"]`);
}

/** A card is on screen: placed in its slot, not the invisible keep-alive box. */
function paneShowing(kind: string): boolean {
  const element = card(kind);
  return (
    element?.getAttribute('data-pane-shown') === 'true' && !classes(element).includes('invisible')
  );
}

const editorShowing = () => paneShowing('editor');
const terminalShowing = () => paneShowing('terminal');

function shells(): { cwd: string | null; active: string | null; shown: boolean }[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="shell"]')].map((shell) => ({
    cwd: shell.getAttribute('data-cwd'),
    active: shell.getAttribute('data-active'),
    shown: !classes(shell.parentElement).includes('invisible'),
  }));
}

const changesButton = () => container.querySelector('button[data-panel-toggle="changes"]');
const filesButton = () => container.querySelector('button[data-panel-toggle="files"]');
const closeButton = (kind: string) => card(kind)?.querySelector('button[aria-label="Close pane"]');

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
  useShellLayoutStore.setState({ panes: [], paneFocus: [], expandedPane: null });
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

describe('the panes open on demand (ruling L3)', () => {
  it('none is open when a conversation opens, yet the editor stays mounted for file intents', () => {
    expect(areaShows()).toBe('closed');
    // Round-10 ⑥: the editor is the intent consumer; off screen means an
    // invisible card with a real box, never unmounted.
    expect(card('editor')).not.toBeNull();
    expect(editorShowing()).toBe(false);
    expect(classes(card('editor'))).toContain('invisible');
  });

  it('the files button toggles the files pane, which is told when it is on screen', async () => {
    await click(filesButton());
    expect(areaShows()).toBe('files');
    expect(filesButton()?.getAttribute('aria-pressed')).toBe('true');
    const tree = () => container.querySelector('[data-testid="surface-editor"]');
    expect(tree()?.getAttribute('data-active')).toBe('true');
    // One header: the card's. No tab strip anywhere.
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    await click(filesButton());
    expect(areaShows()).toBe('closed');
    expect(filesButton()?.getAttribute('aria-pressed')).toBe('false');
    // An 'active' surface lives as long as its pane (layout 5d).
    expect(tree()).toBeNull();
  });

  it('places up to four cards by open order; a fifth replaces the least recently focused', async () => {
    const store = useShellLayoutStore.getState();
    await act(async () => {
      store.openPane('changes');
      store.openPane('files');
      store.openPane('git');
      store.openPane('context');
    });
    expect(areaShows()).toBe('changes files git context');
    await act(async () =>
      card('changes')?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    );
    await act(async () => useShellLayoutStore.getState().openPane('run'));
    // Focus order was files, git, context, changes: files' slot goes to run.
    expect(areaShows()).toBe('changes run git context');
    expect(card('files')).toBeNull();
  });

  it('⤢ gives one card the whole row and toggles back; the others stay mounted', async () => {
    await click(filesButton());
    await click(changesButton());
    await click(card('files')?.querySelector('button[aria-label="Expand pane"]') ?? null);
    const area = container.querySelector('[data-pane-area]');
    expect(classes(area)).toEqual(expect.arrayContaining(['absolute', 'inset-0']));
    expect(paneShowing('files')).toBe(true);
    expect(paneShowing('changes')).toBe(false);
    expect(container.querySelector('[data-testid="review"]')).not.toBeNull();
    await click(card('files')?.querySelector('button[aria-label="Restore pane"]') ?? null);
    expect(paneShowing('changes')).toBe(true);
    expect(classes(container.querySelector('[data-pane-area]'))).not.toContain('inset-0');
  });

  it('Escape closes the pane it is pressed in, and only that one', async () => {
    await click(filesButton());
    await click(changesButton());
    const target = card('changes')?.querySelector('button') as HTMLElement;
    await act(async () =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(areaShows()).toBe('files');
  });
});

describe('the terminal pane', () => {
  it('opens beside the files, and ending it leaves the same file tabs', async () => {
    const tabsBefore = useEditorStore.getState().tabs;
    await act(async () => useShellLayoutStore.getState().openPane('editor'));
    expect(editorShowing()).toBe(true);

    await click(terminalButton());
    expect(terminalShowing()).toBe(true);
    expect(editorShowing()).toBe(true);
    expect(areaShows()).toBe('editor terminal');
    expect(terminalButton().getAttribute('aria-pressed')).toBe('true');
    expect(shells()).toEqual([{ cwd: ALPHA, active: 'true', shown: true }]);
    // The card's header names the folder (prototype scene G).
    expect(card('terminal')?.querySelector('header')?.textContent).toContain(ALPHA);

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
    expect(areaShows()).toBe('closed');
    expect(probe.unmounts).toEqual([]);
    expect(shells()).toEqual([{ cwd: ALPHA, active: 'false', shown: true }]);
    // Running out of sight is marked, and a click brings the same shell back.
    expect(terminalButton().getAttribute('data-session-terminal')).toBe('hidden');
    expect(terminalButton().getAttribute('aria-label')).toBe('Terminal (still running)');
    await click(terminalButton());
    expect(terminalShowing()).toBe(true);
    expect(probe.mounts).toEqual([ALPHA]);
  });

  it('sits beside the review as its own card; closing either leaves the other', async () => {
    await click(terminalButton());
    await click(changesButton());
    expect(container.querySelector('[data-testid="review"]')).not.toBeNull();
    expect(terminalShowing()).toBe(true);
    expect(paneShowing('changes')).toBe(true);

    // The review's diff opens the editor as a third card.
    await click(container.querySelector('[data-testid="review"] button[aria-label="Open diff"]'));
    expect(areaShows()).toBe('terminal changes editor');

    // The card's ✕ hides the terminal; the shell keeps running.
    await click(closeButton('terminal') ?? null);
    expect(terminalShowing()).toBe(false);
    expect(probe.unmounts).toEqual([]);
    expect(terminalButton().getAttribute('data-session-terminal')).toBe('hidden');
    await click(closeButton('changes') ?? null);
    expect(container.querySelector('[data-testid="review"]')).toBeNull();
    expect(areaShows()).toBe('editor');
  });

  it('a file being opened opens the editor beside it', async () => {
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
    expect(terminalShowing()).toBe(true);
    expect(probe.unmounts).toEqual([]);
  });

  it('[E3-21-REVEAL] a request for the file that is already the active tab opens the editor (P1-7e problem 21)', async () => {
    await click(terminalButton());
    expect(terminalShowing()).toBe(true);
    const before = useEditorStore.getState();
    // The file tree's click on `a.ts`, already active: no tab changes, only the request.
    await act(async () => useEditorStore.getState().requestReveal());
    expect(useEditorStore.getState().activeTabPath).toBe(before.activeTabPath);
    expect(useEditorStore.getState().tabs).toBe(before.tabs);
    expect(editorShowing()).toBe(true);
    expect(probe.unmounts).toEqual([]);

    // The same for the diff that is already showing (the git pane's click).
    const target = { kind: 'workdir' as const, path: 'a.ts', staged: false };
    await act(async () => useEditorStore.getState().openDiffTab(target));
    await click(closeButton('editor') ?? null);
    expect(editorShowing()).toBe(false);
    await act(async () => useEditorStore.getState().openDiffTab(target));
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

    // Back in alpha's folder the terminal pane is back, by itself.
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
