// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRuntimeEvents, type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';
import { TEMP_PROJECT_ID } from '../deriveChatWorkspaceTree';
import {
  ESCAPE_OWNING_POPUP_SELECTOR,
  SURFACE_ESCAPE_HOLD_ATTR,
  shouldCloseOnEscape,
} from '../shellLayoutModel';

/**
 * Decision 137 (user ruling, sidebar) and decision 138 (P1-7e e1), rendered
 * for real: "Active now", a folder header that only folds, folders capped at 8
 * rows, the rename editor keeping its focus (point-check issue 26) and the
 * 1.0.x branch suffix kept whole (issue 32). Decision 167 (GitHub issue #3):
 * the branch on the folder row and the three-line row tooltip. Decision 170
 * (GitHub issue #6): the three regions — Active now capped at 5 and gone while
 * empty, Recent retired — Collapse all, and folders ordered by activity, held
 * while the pointer or keyboard focus is in the list.
 *
 * Stubbed like the other LeftNav mount tests: the persisted index (IPC),
 * session activation (starts a worker) and the diff-stats poller.
 */

const mocks = vi.hoisted(() => {
  // Must be hoisted: stores rehydrate from `electronAPI` at import time.
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
  } as unknown as typeof window.electronAPI;
  return {
    rename: vi.fn(async (_sessionId: string, _title: string) => true),
    activate: vi.fn(),
  };
});

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name])) : key,
    locale: 'en',
  }),
}));
vi.mock('@/components/chat/sessionIndex/useSessionIndex', () => ({
  useSessionIndex: () => ({ refresh: async () => {}, loading: false, error: null }),
  useSessionIndexMutations: () => ({
    rename: mocks.rename,
    archive: async () => true,
    archiveMany: async () => 0,
    close: async () => true,
  }),
}));
vi.mock('@/components/workspace-shell/useActivateSession', () => ({
  useActivateSession: () => (sessionId: string) => {
    mocks.activate(sessionId);
    useChatSessionsStore.getState().selectSession(sessionId);
  },
}));
vi.mock('@/components/workspace-shell/useFolderDiffStats', () => ({
  useFolderDiffStatsPolling: () => {},
}));

const { LeftNav } = await import('../LeftNav');

const ALPHA = 'project:/repo/alpha';
const BETA = 'project:/repo/beta';
const REPOS = [
  { id: ALPHA, path: '/repo/alpha', name: 'alpha' },
  { id: BETA, path: '/repo/beta', name: 'beta' },
];
const NOW = Date.now();

function chat(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: ALPHA,
    workspaceId: 'ws-alpha',
    title: `Chat ${id}`,
    status: 'idle',
    updatedAt: NOW,
    ...extra,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.rename.mockClear();
  mocks.activate.mockClear();
  useChatSessionsStore.setState({
    projects: [
      { id: ALPHA, name: 'alpha' },
      { id: BETA, name: 'beta' },
    ],
    workspaces: [
      { id: 'ws-alpha', projectId: ALPHA, name: 'Main', kind: 'main', path: '/repo/alpha' },
      { id: 'ws-beta', projectId: BETA, name: 'Main', kind: 'main', path: '/repo/beta' },
    ],
    sessions: [chat('a')],
    messages: {},
    activeSessionId: null,
    hostBoundSessionIds: [],
    unreadSessionIds: [],
    pendingPermissions: [],
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  for (const node of document.querySelectorAll('textarea[data-test-composer]')) node.remove();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => root.render(createElement(LeftNav, { repositories: REPOS as never })));
}

/** Session rows (the row trigger is `role="button"`) whose text includes `title`. */
function rows(title: string, scope: ParentNode = container): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('[role="button"]')].filter((node) =>
    node.textContent?.includes(title)
  );
}

function allRows(scope: ParentNode = container): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('[role="button"]')];
}

/** A region, by its L1 title (a `<p>` in the region's first grid row). */
function sectionTitled(label: string): HTMLElement | null {
  const heading = [...container.querySelectorAll('p')].find((node) => node.textContent === label);
  return heading?.closest('section') ?? null;
}

/** The folder names in Repositories, top to bottom. */
function folderOrder(): string[] {
  return [...container.querySelectorAll('[data-slot="sidebar-folder-name"]')].map(
    (node) => node.textContent ?? ''
  );
}

/**
 * React derives enter / leave from `pointerover` / `pointerout` and their
 * `relatedTarget`; `document.body` is outside the React root, so it reads as
 * coming from (or going to) nowhere in the tree.
 */
async function pointer(type: 'pointerover' | 'pointerout', target: Element): Promise<void> {
  const Pointer = (globalThis.PointerEvent ?? MouseEvent) as typeof MouseEvent;
  await act(async () => {
    target.dispatchEvent(
      new Pointer(type, { bubbles: true, cancelable: true, relatedTarget: document.body })
    );
  });
}

/**
 * The folder header's toggle, found by the name's own slot: since decision
 * 167 the button also holds the main branch, so its text is not the name.
 */
function folderHeader(name: string): HTMLButtonElement {
  const slot = [...container.querySelectorAll('[data-slot="sidebar-folder-name"]')].find(
    (node) => node.textContent === name
  );
  const button = slot?.closest('button');
  if (!button) throw new Error(`folder header ${name} not rendered`);
  return button;
}

/** The first line of a row's tooltip — its title (decision 167 §3). */
function tooltipTitle(node: Element | undefined): string | undefined {
  return node?.getAttribute('title')?.split('\n')[0];
}

function buttonText(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === text
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('Active now (decision 137 §1; the top region since decision 170)', () => {
  it('is not rendered at all while nothing is started, so Repositories comes first', async () => {
    await render();
    expect(sectionTitled('Active now')).toBeNull();
    expect(container.textContent).not.toContain('Active now');
    // Decision 170 retired Recent: no other cross-folder list takes its place.
    expect(container.textContent).not.toContain('Recent');
    expect(rows('Chat a')).toHaveLength(1);
    // The first region opens right under the toolbar, with no divider of its own.
    expect(sectionTitled('Repositories')?.className).not.toContain('border-t');
  });

  it('lists started chats with running turns first, and marks running vs waiting', async () => {
    useChatSessionsStore.setState({
      sessions: [
        chat('idle-bound', { updatedAt: NOW }),
        chat('running', { status: 'running', updatedAt: NOW - 50_000 }),
        chat('waiting', { status: 'waiting_question', updatedAt: NOW - 90_000 }),
        chat('previewed', { runtimeIdentity: '/p.dsh.json', updatedAt: NOW }),
      ],
      hostBoundSessionIds: ['idle-bound', 'running', 'waiting'],
    });
    await render();

    const region = sectionTitled('Active now');
    expect(region, 'the region renders').toBeTruthy();
    expect(region?.className).toContain('max-h-[33%]');
    // Above Repositories, which then opens with the divider between them.
    expect(sectionTitled('Repositories')?.className).toContain('border-t');
    // The row's tooltip starts with its title.
    const listed = allRows(region as HTMLElement).map((node) => tooltipTitle(node));
    // Running turns first (by last activity among them), then the rest.
    expect(listed).toEqual(['Chat running', 'Chat waiting', 'Chat idle-bound']);

    const [running, waiting, idle] = allRows(region as HTMLElement);
    expect(running?.querySelector('[role="status"][aria-label="Running"]')).toBeTruthy();
    expect(waiting?.querySelector('[role="img"][aria-label="Waiting for an answer"]')).toBeTruthy();
    expect(waiting?.querySelector('[role="status"]')).toBeNull();
    expect(idle?.querySelector('[role="status"]')).toBeNull();
  });

  it('drops a chat when the pool reclaims it, and disappears when the last one goes', async () => {
    useChatSessionsStore.setState({
      sessions: [chat('a')],
      hostBoundSessionIds: ['a'],
    });
    await render();
    expect(sectionTitled('Active now')).toBeTruthy();

    await act(async () => {
      useChatSessionsStore.setState({ hostBoundSessionIds: [] });
    });
    expect(sectionTitled('Active now')).toBeNull();
  });

  it('E6-37: chats the engine let go of (a plugin switch, the idle sweep) leave the region', async () => {
    useChatSessionsStore.setState({
      sessions: [chat('a'), chat('b')],
      hostBoundSessionIds: ['a', 'b'],
    });
    await render();
    expect(allRows(sectionTitled('Active now') as HTMLElement)).toHaveLength(2);

    // What Main sends for each session `invalidateAll` retires (decision 145).
    await act(async () => {
      useChatSessionsStore.setState((state) =>
        applyRuntimeEvents(
          state,
          ['a', 'b'].map((sessionId, index) => ({
            type: 'session.status' as const,
            seq: index + 1,
            sessionId,
            timestamp: NOW,
            payload: { status: 'disconnected' as const, disconnectReason: 'released' as const },
          }))
        )
      );
    });
    expect(sectionTitled('Active now')).toBeNull();
    // Still in their folder, only no longer marked as running in the background.
    expect(rows('Chat a')).toHaveLength(1);
    expect(rows('Chat a')[0]?.querySelector('[title="Running in the background"]')).toBeNull();
  });

  it('lists a chat once, and again in its folder — both rows carry the selection', async () => {
    useChatSessionsStore.setState({
      sessions: [chat('bound', { updatedAt: NOW }), chat('fresh', { updatedAt: NOW - 1000 })],
      hostBoundSessionIds: ['bound'],
      activeSessionId: 'bound',
    });
    await render();

    const region = sectionTitled('Active now') as HTMLElement;
    expect(allRows(region).map((node) => tooltipTitle(node))).toEqual(['Chat bound']);
    expect(rows('Chat bound')).toHaveLength(2);
    for (const row of rows('Chat bound')) expect(row.className).toContain('bg-selection');
    // A chat that is merely recent is listed in its folder only (decision 170).
    expect(rows('Chat fresh')).toHaveLength(1);
  });

  it('lists 5 rows, the rest behind "View more (N)", and "Show less" folds them back', async () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      chat(`n${String(i).padStart(2, '0')}`, { updatedAt: NOW - i * 1000 })
    );
    useChatSessionsStore.setState({
      sessions: seven,
      hostBoundSessionIds: seven.map((session) => session.id),
    });
    await render();
    const region = () => sectionTitled('Active now') as HTMLElement;
    expect(allRows(region())).toHaveLength(5);
    expect(rows('Chat n05', region())).toHaveLength(0);
    const more = [...region().querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === 'View more (2)'
    );
    expect(more, 'the region ends in View more (2)').toBeTruthy();

    await act(async () => more?.click());
    expect(allRows(region())).toHaveLength(7);
    const less = [...region().querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === 'Show less'
    );
    expect(less).toBeTruthy();

    await act(async () => less?.click());
    expect(allRows(region())).toHaveLength(5);
  });

  it('its chevron folds the whole list, in memory only, open by default', async () => {
    useChatSessionsStore.setState({ sessions: [chat('a')], hostBoundSessionIds: ['a'] });
    const storedBefore = localStorage.length;
    await render();
    const region = () => sectionTitled('Active now') as HTMLElement;
    expect(allRows(region())).toHaveLength(1);

    await act(async () =>
      region().querySelector<HTMLButtonElement>('[aria-label="Collapse active chats"]')?.click()
    );
    // The title stays; the whole list folds.
    expect(region()).toBeTruthy();
    expect(allRows(region())).toHaveLength(0);
    expect(region().querySelector('[aria-label="Expand active chats"]')).toBeTruthy();
    // The folder still lists it.
    expect(rows('Chat a')).toHaveLength(1);
    // Nothing is written: a restart opens it again.
    expect(localStorage.length).toBe(storedBefore);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(allRows(region())).toHaveLength(1);
  });
});

describe('the branch lives on the folder row (decision 167 §2)', () => {
  beforeEach(() => {
    useChatSessionsStore.setState({
      workspaces: [
        {
          id: 'ws-alpha',
          projectId: ALPHA,
          name: 'Main',
          kind: 'main',
          path: '/repo/alpha',
          branch: 'main',
        },
        {
          id: 'ws-alpha-wt',
          projectId: ALPHA,
          name: 'feature/sidebar-redesign',
          kind: 'worktree',
          path: '/repo/alpha-wt',
          branch: 'feature/sidebar-redesign',
        },
        { id: 'ws-beta', projectId: BETA, name: 'Main', kind: 'main', path: '/repo/beta' },
      ],
      sessions: [
        chat('main-row', { updatedAt: NOW }),
        chat('worktree-row', { workspaceId: 'ws-alpha-wt', updatedAt: NOW - 1000 }),
      ],
      hostBoundSessionIds: ['worktree-row'],
    });
  });

  it('names the main branch once on the folder row, with the name in its own slot', async () => {
    await render();
    const header = folderHeader('alpha');
    expect(header.textContent).toBe('alphamain');
    expect(header.getAttribute('title')).toBe('alpha\nMain branch: main');
    // No row repeats it.
    const repos = sectionTitled('Repositories') as HTMLElement;
    const [mainRow] = rows('Chat main-row', repos);
    expect(mainRow?.textContent).not.toContain('main ');
    expect(mainRow?.querySelector('[title="main"]')).toBeNull();
  });

  it('shows a worktree row s branch as its last segment, in the folder only', async () => {
    await render();
    const repos = sectionTitled('Repositories') as HTMLElement;
    const [inFolder] = rows('Chat worktree-row', repos);
    const branch = inFolder?.querySelector('[title="feature/sidebar-redesign"]');
    expect(branch?.textContent).toBe('sidebar-redesign');
    expect(branch?.className).toContain('max-w-24');

    const active = sectionTitled('Active now') as HTMLElement;
    const [inActive] = rows('Chat worktree-row', active);
    expect(inActive, 'the row is in Active now too').toBeTruthy();
    expect(inActive?.textContent).not.toContain('sidebar-redesign');
  });

  it('gives every row the three-line tooltip: title / folder · branch / updated', async () => {
    await render();
    const [row] = rows('Chat worktree-row');
    const lines = row?.getAttribute('title')?.split('\n') ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Chat worktree-row');
    expect(lines[1]).toBe('alpha · feature/sidebar-redesign');
    expect(lines[2]).toMatch(/^Updated \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('Temporary chats is a section of its own (decision 167 §5)', () => {
  it('lists its rows directly under an L1 title, without the 「临时」 chip, and folds from the title', async () => {
    useChatSessionsStore.setState({
      sessions: [
        chat('a'),
        {
          id: 'scratch',
          projectId: '',
          workspaceId: '',
          title: 'Scratch chat',
          status: 'idle',
          updatedAt: NOW,
          unbound: { workspacePath: '/tmp/scratch' },
        },
      ],
    });
    await render();
    const section = sectionTitled('Temporary chats') as HTMLElement;
    expect(section, 'an L1 section titled Temporary chats').toBeTruthy();
    // Decision 170: a region of its own, capped at 25%, under Repositories.
    expect(section.className).toContain('max-h-[25%]');
    expect(
      (sectionTitled('Repositories') as HTMLElement).compareDocumentPosition(section) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // Not a folder inside Repositories, and no folder-style header of its own.
    expect(section.closest('section')).toBe(section);
    expect(sectionTitled('Repositories')?.contains(section)).toBe(false);
    expect(section.querySelector('[data-slot="sidebar-folder-name"]')).toBeNull();

    const [row] = rows('Scratch chat', section);
    expect(row?.textContent).not.toContain('Temporary');
    expect(row?.getAttribute('title')?.split('\n')[1]).toBe('Temporary chats');

    await act(async () =>
      section.querySelector<HTMLButtonElement>('[aria-label="Collapse temporary chats"]')?.click()
    );
    expect(rows('Scratch chat')).toHaveLength(0);
    expect(section.querySelector('[aria-label="Expand temporary chats"]')).toBeTruthy();
  });
});

describe('a folder header only folds (decision 137 §3)', () => {
  it('folds and unfolds without opening a chat or moving the selection', async () => {
    useChatSessionsStore.setState({
      sessions: [chat('a'), chat('b', { projectId: BETA, workspaceId: 'ws-beta' })],
      // The selected chat is in ANOTHER folder: under D29 this click would
      // have opened alpha's newest chat instead of folding it.
      activeSessionId: 'b',
    });
    await render();
    expect(rows('Chat a')).toHaveLength(1);

    await act(async () => folderHeader('alpha').click());
    expect(rows('Chat a')).toHaveLength(0);
    expect(useChatSessionsStore.getState().activeSessionId).toBe('b');
    expect(mocks.activate).not.toHaveBeenCalled();

    await act(async () => folderHeader('alpha').click());
    expect(rows('Chat a')).toHaveLength(1);
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});

describe('folders list 8 rows (decision 137 §4)', () => {
  const eleven = Array.from({ length: 11 }, (_, i) =>
    chat(`n${String(i).padStart(2, '0')}`, { updatedAt: NOW - i * 1000 })
  );

  it('hides the rest behind "View more (N)", keeping the selected chat visible', async () => {
    useChatSessionsStore.setState({ sessions: eleven, activeSessionId: 'n10' });
    await render();

    // 8 newest + the selected one (the oldest); nothing active.
    expect(allRows()).toHaveLength(9);
    expect(rows('Chat n10')).toHaveLength(1);
    expect(rows('Chat n08')).toHaveLength(0);
    expect(buttonText('View more (2)')).toBeTruthy();
  });

  it('expands to all rows ending in "Show less", and keeps that across a fold', async () => {
    useChatSessionsStore.setState({ sessions: eleven });
    await render();
    expect(allRows()).toHaveLength(8);

    await act(async () => buttonText('View more (3)')?.click());
    expect(allRows()).toHaveLength(11);
    expect(buttonText('Show less')).toBeTruthy();

    // Folding and unfolding the folder keeps it expanded (memory, this run).
    await act(async () => folderHeader('alpha').click());
    await act(async () => folderHeader('alpha').click());
    expect(allRows()).toHaveLength(11);

    // Switching conversations keeps it too.
    await act(async () => rows('Chat n09')[0]?.click());
    expect(allRows()).toHaveLength(11);

    await act(async () => buttonText('Show less')?.click());
    expect(allRows()).toHaveLength(9);
  });

  it('E6-40: Active now says "View more (N)" like a folder, not "Show more (N)"', async () => {
    const ten = eleven.slice(0, 10);
    useChatSessionsStore.setState({
      sessions: ten,
      hostBoundSessionIds: ten.map((session) => session.id),
    });
    await render();
    // Active now lists 5 (5 hidden), the folder lists 8 (2 hidden).
    expect(buttonText('View more (5)')).toBeTruthy();
    expect(buttonText('View more (2)')).toBeTruthy();
    expect(container.textContent).not.toContain('Show more');
  });

  it('lists every match while searching', async () => {
    useChatSessionsStore.setState({ sessions: eleven });
    await render();
    const input = [...container.querySelectorAll('input')].find(
      (node) => node.getAttribute('placeholder') === 'Search sessions'
    );
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(input, 'chat n');
      (input as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(allRows()).toHaveLength(11);
    expect(buttonText('View more (3)')).toBeUndefined();
  });
});

describe('Collapse all (decision 170, issue #6 ruling 7)', () => {
  beforeEach(() => {
    useChatSessionsStore.setState({
      projects: [
        { id: ALPHA, name: 'alpha' },
        { id: BETA, name: 'beta' },
        { id: TEMP_PROJECT_ID, name: 'Temp' },
      ],
      workspaces: [
        { id: 'ws-alpha', projectId: ALPHA, name: 'Main', kind: 'main', path: '/repo/alpha' },
        { id: 'ws-beta', projectId: BETA, name: 'Main', kind: 'main', path: '/repo/beta' },
        {
          id: 'ws-temp',
          projectId: TEMP_PROJECT_ID,
          name: 'Scratch',
          kind: 'temp',
          path: '/tmp/temp-session',
        },
      ],
      sessions: [
        chat('a'),
        chat('b', { projectId: BETA, workspaceId: 'ws-beta' }),
        chat('t', { projectId: TEMP_PROJECT_ID, workspaceId: 'ws-temp' }),
        {
          id: 'scratch',
          projectId: '',
          workspaceId: '',
          title: 'Scratch chat',
          status: 'idle',
          updatedAt: NOW,
          unbound: { workspacePath: '/tmp/scratch' },
        },
      ],
    });
  });

  function collapseAll(): HTMLButtonElement | null {
    return (sectionTitled('Repositories') as HTMLElement).querySelector<HTMLButtonElement>(
      '[aria-label="Collapse all repositories"]'
    );
  }

  it('folds every folder, the temporary workspaces included, and leaves Temporary chats open', async () => {
    await render();
    const repos = () => sectionTitled('Repositories') as HTMLElement;
    expect(allRows(repos())).toHaveLength(3);
    expect(collapseAll()?.getAttribute('title')).toBe('Collapse all repositories');

    await act(async () => collapseAll()?.click());
    expect(allRows(repos())).toHaveLength(0);
    // The folder rows stay, closed.
    expect(folderOrder()).toEqual(['alpha', 'beta', 'Temporary workspaces']);
    // The Temporary chats region keeps its own flag in the same map.
    expect(rows('Scratch chat', sectionTitled('Temporary chats') as HTMLElement)).toHaveLength(1);

    // A folder still opens on its own; pressing again only folds (no "expand all").
    await act(async () => folderHeader('alpha').click());
    expect(rows('Chat a')).toHaveLength(1);
    await act(async () => collapseAll()?.click());
    expect(allRows(repos())).toHaveLength(0);
  });

  it('folds the folders a search is hiding as well', async () => {
    await render();
    const input = [...container.querySelectorAll('input')].find(
      (node) => node.getAttribute('placeholder') === 'Search sessions'
    ) as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const search = (text: string) =>
      act(async () => {
        setValue?.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

    await search('Chat a');
    expect(folderOrder()).toEqual(['alpha']);
    await act(async () => collapseAll()?.click());
    await search('');
    expect(allRows(sectionTitled('Repositories') as HTMLElement)).toHaveLength(0);
  });
});

describe('folders by last activity (decision 170, issue #6 ruling 6)', () => {
  const GAMMA = 'project:/repo/gamma';

  beforeEach(() => {
    useChatSessionsStore.setState({
      // In the order they were added.
      projects: [
        { id: ALPHA, name: 'alpha' },
        { id: GAMMA, name: 'gamma' },
        { id: BETA, name: 'beta' },
        { id: TEMP_PROJECT_ID, name: 'Temp' },
      ],
      workspaces: [
        { id: 'ws-alpha', projectId: ALPHA, name: 'Main', kind: 'main', path: '/repo/alpha' },
        { id: 'ws-gamma', projectId: GAMMA, name: 'Main', kind: 'main', path: '/repo/gamma' },
        { id: 'ws-beta', projectId: BETA, name: 'Main', kind: 'main', path: '/repo/beta' },
        {
          id: 'ws-temp',
          projectId: TEMP_PROJECT_ID,
          name: 'Scratch',
          kind: 'temp',
          path: '/tmp/temp-session',
        },
      ],
      sessions: [
        chat('a', { updatedAt: NOW - 60_000 }),
        chat('b', { projectId: BETA, workspaceId: 'ws-beta', updatedAt: NOW }),
        // Newest of all, and still last.
        chat('t', { projectId: TEMP_PROJECT_ID, workspaceId: 'ws-temp', updatedAt: NOW + 60_000 }),
      ],
    });
  });

  /** A turn in chat `id` ends: its folder's activity moves to `updatedAt`. */
  const touch = (id: string, updatedAt: number) =>
    act(async () => {
      useChatSessionsStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === id ? { ...session, updatedAt } : session
        ),
      }));
    });

  it('newest activity first, folders without chats after them, temporary workspaces last', async () => {
    await render();
    expect(folderOrder()).toEqual(['beta', 'alpha', 'gamma', 'Temporary workspaces']);
  });

  it('holds the order while the pointer is in Repositories, and reorders once it leaves', async () => {
    await render();
    const inside = folderHeader('alpha');
    await pointer('pointerover', inside);
    await touch('a', NOW + 120_000);
    expect(folderOrder()).toEqual(['beta', 'alpha', 'gamma', 'Temporary workspaces']);

    await pointer('pointerout', inside);
    expect(folderOrder()).toEqual(['alpha', 'beta', 'gamma', 'Temporary workspaces']);
  });

  it('holds the order while keyboard focus is in Repositories', async () => {
    await render();
    await act(async () => folderHeader('gamma').focus());
    await touch('a', NOW + 120_000);
    expect(folderOrder()).toEqual(['beta', 'alpha', 'gamma', 'Temporary workspaces']);

    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    expect(folderOrder()).toEqual(['alpha', 'beta', 'gamma', 'Temporary workspaces']);
  });

  it('a chat started in an empty folder during the hold moves it up only after the hold', async () => {
    await render();
    const inside = folderHeader('gamma');
    await pointer('pointerover', inside);
    await act(async () => {
      useChatSessionsStore.setState((state) => ({
        sessions: [
          ...state.sessions,
          chat('g', { projectId: GAMMA, workspaceId: 'ws-gamma', updatedAt: NOW + 120_000 }),
        ],
      }));
    });
    expect(folderOrder()).toEqual(['beta', 'alpha', 'gamma', 'Temporary workspaces']);
    expect(rows('Chat g')).toHaveLength(1);

    await pointer('pointerout', inside);
    expect(folderOrder()).toEqual(['gamma', 'beta', 'alpha', 'Temporary workspaces']);
  });

  it('lets go when the focused row is removed, which sends no blur event', async () => {
    useChatSessionsStore.setState((state) => ({
      sessions: [...state.sessions, chat('a-old', { updatedAt: NOW - 120_000 })],
    }));
    await render();
    await act(async () => rows('Chat a-old')[0]?.focus());
    expect(document.activeElement?.textContent).toContain('Chat a-old');

    // The row goes (its ✕, an archive): focus falls back to <body> silently.
    await act(async () => {
      useChatSessionsStore.setState((state) => ({
        sessions: state.sessions.filter((session) => session.id !== 'a-old'),
      }));
    });
    await touch('a', NOW + 120_000);
    expect(folderOrder()).toEqual(['alpha', 'beta', 'gamma', 'Temporary workspaces']);
  });

  it('nothing outside Repositories holds it', async () => {
    useChatSessionsStore.setState({ hostBoundSessionIds: ['b'] });
    await render();
    const [activeRow] = rows('Chat b', sectionTitled('Active now') as HTMLElement);
    await pointer('pointerover', activeRow as HTMLElement);
    await touch('a', NOW + 120_000);
    expect(folderOrder()).toEqual(['alpha', 'beta', 'gamma', 'Temporary workspaces']);
  });
});

describe('the rename editor keeps its focus (point-check issue 26)', () => {
  /**
   * The field trace: focus reaches the editor, then 1 ms later the chat
   * composer takes it. The context menu, unmounting with the row it belonged
   * to, returned focus to the last connected element Base UI had recorded as
   * "previously focused" — the composer.
   */
  function composer(): HTMLTextAreaElement {
    const textarea = document.createElement('textarea');
    textarea.setAttribute('data-test-composer', '');
    document.body.append(textarea);
    return textarea;
  }

  function editor(): HTMLInputElement | null {
    return (
      [...container.querySelectorAll('input')].find(
        (node) => node.getAttribute('placeholder') !== 'Search sessions'
      ) ?? null
    );
  }

  async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('Rename from the context menu leaves focus in the editor, not the composer', async () => {
    const textarea = composer();
    let composerFocused = 0;
    await render();

    // The composer had focus when the menu opened, so Base UI records it.
    textarea.focus();
    textarea.addEventListener('focus', () => {
      composerFocused += 1;
    });
    await act(async () => {
      rows('Chat a')[0]?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
      );
    });
    const rename = [...document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')].find(
      (item) => item.textContent?.trim() === 'Rename'
    );
    expect(rename, 'the row menu offers Rename').toBeTruthy();
    await act(async () => rename?.click());
    await flush();
    await flush();

    const input = editor();
    expect(input, 'the editor is open').toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(composerFocused).toBe(0);

    await typeInto(input as HTMLInputElement, 'Renamed chat');
    await act(async () => {
      (input as HTMLInputElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    expect(mocks.rename).toHaveBeenCalledWith('a', 'Renamed chat');
  });

  it('a focus theft by code is undone; a click elsewhere commits what was typed', async () => {
    const textarea = composer();
    await render();
    await act(async () => {
      rows('Chat a')[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const input = editor() as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await typeInto(input, 'Typed name');

    // No pointer, no key: code moved focus. The edit stays open, nothing is
    // committed, and the editor takes focus back.
    await act(async () => textarea.focus());
    await flush();
    expect(editor()).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(mocks.rename).not.toHaveBeenCalled();

    // The user clicks the composer: that ends the edit with the typed name.
    await act(async () => {
      textarea.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      textarea.focus();
    });
    await flush();
    expect(mocks.rename).toHaveBeenCalledWith('a', 'Typed name');
    expect(editor()).toBeNull();
  });

  it('Escape cancels without renaming', async () => {
    await render();
    await act(async () => {
      rows('Chat a')[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const input = editor() as HTMLInputElement;
    await typeInto(input, 'Discarded');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();
    expect(editor()).toBeNull();
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  // Decision 156 (decision 145's finding 7): the keyboard user's next key goes
  // to the row they were renaming, not to <body>.
  it('E156-7: Escape hands focus back to the row it was renaming', async () => {
    await render();
    await act(async () => {
      rows('Chat a')[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const input = editor() as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await typeInto(input, 'Discarded');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();
    expect(editor()).toBeNull();
    const row = rows('Chat a')[0];
    expect(row, 'the row is back').toBeTruthy();
    expect(document.activeElement).toBe(row);
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it('E6-36: Escape inside the dock cancels the rename instead of folding the sidebar', async () => {
    // The dock's own capture-phase rule, as `LeftDock` applies it to the panel
    // that hosts this list (point-check issue 36: it took the key first).
    const folded = vi.fn();
    const dockCapture = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const holdsEscape = !!target?.closest?.(`[${SURFACE_ESCAPE_HOLD_ATTR}]`);
      const popupOpen = !!document.querySelector(ESCAPE_OWNING_POPUP_SELECTOR);
      if (!shouldCloseOnEscape({ key: event.key, isOpen: true, holdsEscape, popupOpen })) return;
      folded();
      event.stopPropagation();
    };
    container.addEventListener('keydown', dockCapture, true);
    try {
      await render();
      await act(async () => {
        rows('Chat a')[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      });
      const input = editor() as HTMLInputElement;
      await typeInto(input, 'Discarded');
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await flush();
      expect(folded).not.toHaveBeenCalled();
      expect(editor()).toBeNull();
      expect(mocks.rename).not.toHaveBeenCalled();

      // The rule is live: Escape on a plain row still folds the dock.
      await act(async () => {
        rows('Chat a')[0]?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
      expect(folded).toHaveBeenCalledTimes(1);
    } finally {
      container.removeEventListener('keydown', dockCapture, true);
    }
  });
});

describe('the 1.0.x branch suffix stays whole (point-check issue 32)', () => {
  it('cuts only the part before the suffix and keeps the full title as the tooltip', async () => {
    const title = '旧会话己：一直在被写，而且这个标题特别长（1.0.x 分支）';
    useChatSessionsStore.setState({ sessions: [chat('fork', { title })] });
    await render();

    const [row] = rows('（1.0.x 分支）');
    expect(tooltipTitle(row)).toBe(title);
    const suffix = [...(row?.querySelectorAll('span') ?? [])].find(
      (node) => node.textContent === '（1.0.x 分支）'
    );
    expect(suffix?.className).toContain('shrink-0');
    const base = suffix?.previousElementSibling;
    expect(base?.textContent).toBe('旧会话己：一直在被写，而且这个标题特别长');
    expect(base?.className).toContain('truncate');
  });
});
