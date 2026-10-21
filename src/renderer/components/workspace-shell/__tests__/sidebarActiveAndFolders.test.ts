// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRuntimeEvents, type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';
import { useHomeDraftStore } from '@/stores/homeDraft';
import { TEMP_PROJECT_ID } from '../deriveChatWorkspaceTree';
import {
  ESCAPE_OWNING_POPUP_SELECTOR,
  SURFACE_ESCAPE_HOLD_ATTR,
  shouldCloseOnEscape,
} from '../shellLayoutModel';
import { UNBOUND_FOLDER_ID } from '../sidebarTree';

/**
 * Decision 137 (user ruling, sidebar) and decision 138 (P1-7e e1), rendered
 * for real: a group header that only folds, groups capped at 8 rows, the
 * rename editor keeping its focus (point-check issue 26) and the 1.0.x branch
 * suffix kept whole (issue 32). Decision 167 (GitHub issue #3): the three-line
 * row tooltip. Decision 170 (GitHub issue #6): groups ordered by activity,
 * held while the pointer or keyboard focus is in the list. Decision 183: one
 * list with no 「正在活动」 region and no region titles, Temporary chats
 * pinned first, the grey group label with its chevron and folded summary, the
 * faint ring of a chat not started, hover actions floating over the row, no
 * 「新建对话」 row in an empty group, and the collapse / expand all toggle.
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
/**
 * Issue #15: `addedAt` is what 「按工作目录」 orders repositories by, newest
 * first. Beta was added SECOND, so beta heads the list — the opposite of what
 * decision 170's activity order produced here.
 */
const REPOS = [
  { id: ALPHA, path: '/repo/alpha', name: 'alpha', addedAt: 1_800_000_000_000 },
  { id: BETA, path: '/repo/beta', name: 'beta', addedAt: 1_800_000_060_000 },
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

/** A temporary (unbound) chat. */
function scratch(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: '',
    workspaceId: '',
    title: `Scratch ${id}`,
    status: 'idle',
    updatedAt: NOW,
    unbound: { workspacePath: `/tmp/${id}` },
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

/**
 * Issue #15: a test may bring its own repository list — `addedAt` is what
 * 「按工作目录」 orders by, and a fixture that cannot state it cannot state the
 * order under test.
 */
async function render(repos: unknown = REPOS): Promise<void> {
  await act(async () => root.render(createElement(LeftNav, { repositories: repos as never })));
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

/** A group's `<section>`, by its id (a project id, or `UNBOUND_FOLDER_ID`). */
function group(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-sidebar-group="${id}"]`);
}

/** Every group on screen, top to bottom, by id. */
function groupOrder(): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-sidebar-group]')].map(
    (node) => node.dataset.sidebarGroup ?? ''
  );
}

/** The repository group names, top to bottom. */
function folderOrder(): string[] {
  return [...container.querySelectorAll('[data-slot="sidebar-folder-name"]')].map(
    (node) => node.textContent ?? ''
  );
}

/** A repository group header's toggle, found by the name's own slot. */
function folderHeader(name: string): HTMLButtonElement {
  const slot = [...container.querySelectorAll('[data-slot="sidebar-folder-name"]')].find(
    (node) => node.textContent === name
  );
  const button = slot?.closest('button');
  if (!button) throw new Error(`folder header ${name} not rendered`);
  return button;
}

/** The Temporary chats header's toggle. */
function temporaryHeader(): HTMLButtonElement {
  const button = container.querySelector('[data-slot="sidebar-temporary-name"]')?.closest('button');
  if (!button) throw new Error('temporary chats header not rendered');
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

function buttonLabelled(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('one list, no 「正在活动」 (decision 183 §1.1, §1.10)', () => {
  it('has no region titles and no Active now; a started chat is listed once, in its folder', async () => {
    useChatSessionsStore.setState({
      sessions: [chat('bound'), chat('fresh', { updatedAt: NOW - 1000 })],
      hostBoundSessionIds: ['bound'],
      activeSessionId: 'bound',
    });
    await render();
    for (const gone of ['Active now', 'Repositories', 'Recent']) {
      expect(container.textContent).not.toContain(gone);
    }
    // No L1 title paragraphs, no divider between groups.
    expect(container.querySelector('section p')).toBeNull();
    expect(container.querySelector('section.border-t')).toBeNull();
    expect(rows('Chat bound')).toHaveLength(1);
    // Design system v2 §7.12: the selected step of the ghost fill.
    expect(rows('Chat bound')[0]?.className).toContain('bg-fill-ghost-selected');
    expect(rows('Chat fresh')).toHaveLength(1);
  });

  it('marks running vs waiting in the row s own slot', async () => {
    useChatSessionsStore.setState({
      sessions: [
        chat('running', { status: 'running' }),
        chat('waiting', { status: 'waiting_question' }),
        chat('idle-bound'),
      ],
      hostBoundSessionIds: ['running', 'waiting', 'idle-bound'],
    });
    await render();
    const [running] = rows('Chat running');
    const [waiting] = rows('Chat waiting');
    const [idle] = rows('Chat idle-bound');
    // Design system v2 §6: both drawn by StatusIcon, told apart by its state.
    expect(running?.querySelector('[data-status="running"][aria-label="Running"]')).toBeTruthy();
    expect(
      waiting?.querySelector(
        '[role="img"][data-status="waiting"][aria-label="Waiting for an answer"]'
      )
    ).toBeTruthy();
    expect(waiting?.querySelector('[data-status="running"]')).toBeNull();
    expect(idle?.querySelector('[title="Running in the background"]')).toBeTruthy();
  });

  it('gives a chat not started the faint ring, one step quieter than the background ring', async () => {
    useChatSessionsStore.setState({
      sessions: [chat('bound'), chat('cold', { updatedAt: NOW - 1000 })],
      hostBoundSessionIds: ['bound'],
    });
    await render();
    const bound = rows('Chat bound')[0]?.querySelector('[title="Running in the background"]');
    const cold = rows('Chat cold')[0]?.querySelector('[title="Not started"]');
    // Issue #16: filled vs. outline, not outline vs. outline. The two used to
    // be rings one colour step apart, which read as the same mark.
    expect(bound?.className).toContain('bg-muted-foreground');
    expect(bound?.className).not.toContain('border-muted-foreground-faint');
    expect(bound?.className).not.toContain('border-muted-foreground');
    expect(cold?.className).toContain('border-muted-foreground-faint');
    expect(cold?.className).toContain('rounded-full');
    // Every row has a mark in its slot (decision 183 §1.7).
    for (const row of allRows()) {
      expect(row.firstElementChild?.childElementCount).toBe(1);
    }
  });

  it('E6-37: a chat the engine let go of (a plugin switch, the idle sweep) drops to the faint ring', async () => {
    useChatSessionsStore.setState({
      sessions: [chat('a'), chat('b')],
      hostBoundSessionIds: ['a', 'b'],
    });
    await render();
    expect(container.querySelectorAll('[title="Running in the background"]')).toHaveLength(2);

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
    // Still in their folder, only no longer marked as running in the background.
    expect(rows('Chat a')).toHaveLength(1);
    expect(rows('Chat a')[0]?.querySelector('[title="Running in the background"]')).toBeNull();
    expect(rows('Chat a')[0]?.querySelector('[title="Not started"]')).toBeTruthy();
  });
});

describe('rows (decision 183 §1.4, §1.5)', () => {
  it('shows no time, and floats the actions over the row in its own fill', async () => {
    useChatSessionsStore.setState({
      sessions: [chat('open'), chat('other', { updatedAt: NOW - 1000 })],
      activeSessionId: 'open',
    });
    await render();
    const [open] = rows('Chat open');
    const [other] = rows('Chat other');
    // No relative-age box: the row's text is its title alone.
    expect(open?.textContent).toBe('Chat open');
    // The absolute time stays in the tooltip.
    expect(open?.getAttribute('title')?.split('\n')[2]).toMatch(/^Updated \d{4}-\d{2}-\d{2}/);
    for (const [row, fill] of [
      // Design system v2 §7.12: the two steps of the ghost fill.
      [open, 'bg-fill-ghost-selected'],
      [other, 'bg-fill-ghost-hover'],
    ] as const) {
      expect(row?.className).toContain('relative');
      const actions = row?.querySelector<HTMLElement>('[data-slot="sidebar-row-actions"]');
      expect(actions?.className).toContain('absolute');
      expect(actions?.className).toContain('hidden');
      expect(actions?.className).toContain('group-hover:flex');
      // Keyboard focus reveals them (Tab reaches them); a click's focus does not.
      expect(actions?.className).toContain('group-focus-visible:flex');
      expect(actions?.className).toContain('group-has-focus-visible:flex');
      expect(actions?.className).not.toContain('focus-within');
      expect(actions?.className).toContain(fill);
      expect(actions?.querySelector('[aria-label="Archive session"]')).toBeTruthy();
      expect(actions?.querySelector('[aria-label="Remove from the list"]')).toBeTruthy();
    }
  });

  it('does not float the actions in selection mode', async () => {
    await render();
    await act(async () => buttonLabelled('Select sessions to archive')?.click());
    expect(container.querySelector('[data-slot="sidebar-row-actions"]')).toBeNull();
    expect(buttonText('Cancel')).toBeTruthy();
  });

  it('an empty repository shows its header only — no 「新建对话」 row', async () => {
    await render();
    // beta has no chats.
    const beta = group(BETA) as HTMLElement;
    expect(beta.querySelectorAll('button')).toHaveLength(3); // toggle, more, 「＋」
    expect(beta.textContent).not.toContain('New chat');
    expect(allRows(beta)).toHaveLength(0);
    expect(beta.querySelector('[aria-label="New chat"]')).toBeTruthy();
  });

  it('rows are not indented: no pl-3 wrapper under a header', async () => {
    await render();
    const [row] = rows('Chat a');
    expect(row?.parentElement?.className).not.toContain('pl-3');
  });
});

describe('the group header (decision 183 §1.3, §1.6)', () => {
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
    });
  });

  it('names the repository only — the main branch is in its tooltip', async () => {
    await render();
    const header = folderHeader('alpha');
    expect(header.textContent).toBe('alpha');
    expect(header.getAttribute('title')).toBe('alpha\nMain branch: main');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    // Design system v2 §7.12: the group label is `text-small`, 500, the faint
    // ink, the soft ink on hover, no folder icon — a step below the rows
    // (issue #14, decision 186).
    expect(header.className).toContain('text-small');
    expect(header.className).toContain('font-medium');
    expect(header.className).toContain('text-foreground-faint');
    expect(header.className).toContain('group-hover:text-foreground-soft');
    expect(header.className).not.toContain('font-semibold');
    expect(header.querySelector('.text-folder')).toBeNull();
    // No hover fill on the header row.
    expect(header.parentElement?.className).not.toContain('hover:bg-fill-ghost-hover');
  });

  it('shows ▾ only on hover while open, and ▸ always while folded', async () => {
    await render();
    const chevron = () =>
      folderHeader('alpha').querySelector<HTMLElement>('[data-slot="sidebar-group-chevron"]');
    expect(chevron()?.className).toContain('opacity-0');
    expect(chevron()?.className).toContain('group-hover:opacity-100');
    await act(async () => folderHeader('alpha').click());
    expect(folderHeader('alpha').getAttribute('aria-expanded')).toBe('false');
    expect(chevron()?.className).not.toContain('opacity-0');
  });

  it('shows a worktree row s branch as its last segment, in the folder', async () => {
    await render();
    const [inFolder] = rows('Chat worktree-row');
    const branch = inFolder?.querySelector('[title="feature/sidebar-redesign"]');
    expect(branch?.textContent).toBe('sidebar-redesign');
    expect(branch?.className).toContain('max-w-24');
    const [mainRow] = rows('Chat main-row');
    expect(mainRow?.querySelector('[title="main"]')).toBeNull();
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

describe('a folded group summarises its rows (decision 183 §2.2)', () => {
  it('spinner with a count, the waiting dot, red over green — and nothing while open', async () => {
    useChatSessionsStore.setState({
      sessions: [
        chat('r1', { status: 'running' }),
        chat('r2', { status: 'running' }),
        chat('w', { status: 'waiting_permission' }),
        chat('done'),
        chat('bad', { status: 'failed' }),
      ],
      unreadSessionIds: ['done', 'bad'],
    });
    await render();
    const summary = () =>
      group(ALPHA)?.querySelector<HTMLElement>('[data-slot="sidebar-group-summary"]');
    // Open: the rows carry their own marks.
    expect(summary()).toBeNull();

    await act(async () => folderHeader('alpha').click());
    const marks = summary() as HTMLElement;
    expect(marks, 'the folded header summarises').toBeTruthy();
    // Design system v2 §6: the run marks are StatusIcon's running spinner
    // and its clay waiting dot.
    expect(
      marks.querySelector('[data-status="running"][aria-label="2 chats running"]')
    ).toBeTruthy();
    expect(marks.textContent).toBe('2');
    expect(
      marks.querySelector('[aria-label="A chat is waiting for you"]')?.getAttribute('data-status')
    ).toBe('waiting');
    expect(
      marks.querySelector('[aria-label="A chat failed while you were away"]')?.className
    ).toContain('bg-destructive');
    expect(marks.querySelector('[aria-label="A chat finished while you were away"]')).toBeNull();
  });

  it('one running chat spins without a number; a folded idle group shows nothing', async () => {
    useChatSessionsStore.setState({
      sessions: [
        chat('r', { status: 'running' }),
        chat('b', { projectId: BETA, workspaceId: 'ws-beta' }),
      ],
    });
    await render();
    await act(async () => folderHeader('alpha').click());
    await act(async () => folderHeader('beta').click());
    const alpha = group(ALPHA)?.querySelector('[data-slot="sidebar-group-summary"]');
    expect(alpha?.querySelector('[aria-label="1 chats running"]')).toBeTruthy();
    expect(alpha?.textContent).toBe('');
    expect(group(BETA)?.querySelector('[data-slot="sidebar-group-summary"]')).toBeNull();
  });
});

describe('Temporary chats is its own group, last on the list (decision 183 §2.9, issue #13)', () => {
  beforeEach(() => {
    useChatSessionsStore.setState({
      sessions: [
        chat('a', { updatedAt: NOW + 60_000 }),
        chat('b', { projectId: BETA, workspaceId: 'ws-beta', updatedAt: NOW + 120_000 }),
        scratch('old', { updatedAt: NOW - 3_600_000 }),
      ],
    });
  });

  it('sits below every repository, however new its chats are', async () => {
    await render();
    // Issue #13 (decision 186): decision 183 §1.2 pinned it above them; the
    // user reversed that ruling on 2026-10-12.
    expect(groupOrder()).toEqual([BETA, ALPHA, UNBOUND_FOLDER_ID]);
    // And stays there when its chats get the newest activity — order is by add
    // time now, so nothing a chat does can move a folder.
    await act(async () => {
      useChatSessionsStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === 'b' ? { ...session, updatedAt: NOW - 7_200_000 } : session
        ),
      }));
    });
    expect(groupOrder()).toEqual([BETA, ALPHA, UNBOUND_FOLDER_ID]);
  });

  it('uses the same grey header as a repository, folds from it, and its 「＋」 opens the home page unbound', async () => {
    await render();
    const header = temporaryHeader();
    expect(header.textContent).toBe('Temporary chats');
    expect(header.className).toBe(folderHeader('alpha').className);
    expect(header.getAttribute('title')).toBe('Chats that belong to no repository');
    const [row] = rows('Scratch old', group(UNBOUND_FOLDER_ID) as HTMLElement);
    expect(row?.textContent).not.toContain('Temporary');
    expect(row?.getAttribute('title')?.split('\n')[1]).toBe('Temporary chats');

    await act(async () => header.click());
    expect(rows('Scratch old')).toHaveLength(0);
    expect(temporaryHeader().getAttribute('aria-expanded')).toBe('false');

    await act(async () => useChatSessionsStore.setState({ activeSessionId: 'a' }));
    await act(async () =>
      group(UNBOUND_FOLDER_ID)
        ?.querySelector<HTMLButtonElement>('[aria-label="New temporary chat"]')
        ?.click()
    );
    expect(useChatSessionsStore.getState().activeSessionId).toBeNull();
    expect(useHomeDraftStore.getState().pick).toEqual({ kind: 'unbound' });
  });

  it('is not rendered when there are no temporary chats', async () => {
    useChatSessionsStore.setState({ sessions: [chat('a')] });
    await render();
    expect(group(UNBOUND_FOLDER_ID)).toBeNull();
    expect(container.textContent).not.toContain('Temporary chats');
  });
});

describe('a group header only folds (decision 137 §3)', () => {
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

describe('groups list 8 rows (decision 137 §4)', () => {
  const eleven = Array.from({ length: 11 }, (_, i) =>
    chat(`n${String(i).padStart(2, '0')}`, { updatedAt: NOW - i * 1000 })
  );

  it('hides the rest behind "View more (N)", keeping the selected chat visible', async () => {
    useChatSessionsStore.setState({ sessions: eleven, activeSessionId: 'n10' });
    await render();

    // 8 newest + the selected one (the oldest).
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

  it('E6-40: Temporary chats says "View more (N)" like a folder, h-8 with the title column', async () => {
    const tenScratch = Array.from({ length: 10 }, (_, i) =>
      scratch(`s${i}`, { updatedAt: NOW - i * 1000 })
    );
    useChatSessionsStore.setState({ sessions: [...eleven.slice(0, 10), ...tenScratch] });
    await render();
    const more = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (node) => node.textContent?.trim() === 'View more (2)'
    );
    expect(more).toHaveLength(2);
    // Issue #13: the temporary group is the last one on the list, so its
    // "View more" is the second of the two.
    expect(group(UNBOUND_FOLDER_ID)?.contains(more[1] as Node)).toBe(true);
    expect(container.textContent).not.toContain('Show more');
    for (const button of more) {
      expect(button.className).toContain('h-8');
      // The empty w-4 slot puts the text in the title column.
      expect(button.firstElementChild?.className).toContain('w-4');
    }
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

describe('the top of the panel (decision 183 §1.10, §2.1)', () => {
  it('a vertical nav, then the search box always shown beside the toggle and bulk archive', async () => {
    await render();
    const newChat = buttonText('New chat');
    const addRepository = buttonText('Add Repository');
    expect(newChat?.title).toBe('New chat (opens the home page)');
    expect(newChat?.className).toContain('h-8');
    expect(addRepository?.className).toBe(newChat?.className);
    const search = container.querySelector('input[placeholder="Search sessions"]');
    expect(search).toBeTruthy();
    // No filter toggle: the search box cannot be hidden.
    expect(buttonLabelled('Filter sessions')).toBeNull();
    expect(buttonLabelled('Collapse all groups')).toBeTruthy();
    expect(buttonLabelled('Select sessions to archive')).toBeTruthy();
    // Nav above the tool row, the tool row above the list.
    expect(
      (newChat as Node).compareDocumentPosition(search as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      (search as Node).compareDocumentPosition(group(ALPHA) as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('the search box drops coss InputGroup s default chrome for the prototype s (user ruling)', async () => {
    // Asserted on the RENDERED className — what `cn()` actually merged the
    // primitive's base classes and LeftNav's overrides into — because an
    // override only wins if tailwind-merge drops the base class (same variant
    // stack) or the CSS outranks it; a class merely present proves neither.
    await render();
    const groupNode = container.querySelector<HTMLElement>('[data-slot="input-group"]');
    const classes = new Set(groupNode?.className.split(/\s+/));
    const FOCUS = 'has-[input:focus-visible,textarea:focus-visible]';
    // Design system v2 §7.12: resting, a FILLED field — --fill-neutral in light
    // and dark, a transparent line, no shadow, no inner shade (the ::before
    // carrying it is removed), rounded-sm, h-8 (decision 188).
    for (const present of [
      'h-8',
      'rounded-sm',
      'border',
      'border-transparent',
      'bg-fill-neutral',
      'dark:bg-fill-neutral',
      'shadow-none',
      'before:hidden',
      // Focused: the strong border line, no ring.
      `${FOCUS}:border-border-strong`,
      `${FOCUS}:ring-0`,
      '[&_input]:placeholder:text-muted-foreground',
    ]) {
      expect(classes.has(present), present).toBe(true);
    }
    for (const dropped of [
      'rounded-lg',
      'border-input',
      'bg-background',
      'dark:bg-input/32',
      'shadow-xs',
      `${FOCUS}:border-ring`,
      `${FOCUS}:ring-2`,
    ]) {
      expect(classes.has(dropped), dropped).toBe(false);
    }
    // The magnifier: 14px, full muted ink (opted out of the addon's 80% fade).
    const icon = groupNode?.querySelector('[data-slot="input-group-addon"] svg');
    expect(icon?.getAttribute('class')).toContain('size-3.5');
    expect(icon?.getAttribute('class')).toContain('text-muted-foreground');
    expect(icon?.getAttribute('class')).toContain('opacity-100');
  });
});

describe('Collapse all is a toggle (decision 183 §1.8)', () => {
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
        scratch('x'),
      ],
    });
  });

  const toggle = () => buttonLabelled('Collapse all groups') ?? buttonLabelled('Expand all groups');

  it('folds every group, Temporary chats included, then turns into Expand all', async () => {
    await render();
    expect(allRows()).toHaveLength(4);
    expect(toggle()?.getAttribute('aria-label')).toBe('Collapse all groups');
    expect(toggle()?.title).toBe('Collapse all groups');

    await act(async () => toggle()?.click());
    expect(allRows()).toHaveLength(0);
    // The headers stay, closed.
    expect(folderOrder()).toEqual(['beta', 'alpha', 'Temporary workspaces']);
    expect(temporaryHeader().getAttribute('aria-expanded')).toBe('false');
    expect(toggle()?.getAttribute('aria-label')).toBe('Expand all groups');
    expect(toggle()?.title).toBe('Expand all groups');

    await act(async () => toggle()?.click());
    expect(allRows()).toHaveLength(4);
    expect(toggle()?.getAttribute('aria-label')).toBe('Collapse all groups');
  });

  it('any open group makes it fold: one opened by hand turns it back into Collapse all', async () => {
    await render();
    await act(async () => toggle()?.click());
    await act(async () => folderHeader('alpha').click());
    expect(rows('Chat a')).toHaveLength(1);
    expect(toggle()?.getAttribute('aria-label')).toBe('Collapse all groups');
    await act(async () => toggle()?.click());
    expect(allRows()).toHaveLength(0);
  });

  const search = (text: string) => {
    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search sessions"]'
    ) as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    return act(async () => {
      setValue?.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  /**
   * alpha and Temporary chats hold a `Draft …` chat — the only matches for
   * 「draft」; beta's `Draw diagram` also matches the prefix 「dra」; the
   * temporary workspaces match neither.
   */
  const withDrafts = () =>
    useChatSessionsStore.setState({
      sessions: [
        chat('a', { title: 'Draft notes' }),
        chat('b', { projectId: BETA, workspaceId: 'ws-beta', title: 'Draw diagram' }),
        chat('t', { projectId: TEMP_PROJECT_ID, workspaceId: 'ws-temp' }),
        scratch('x', { title: 'Draft idea' }),
      ],
    });

  it('a search opens every group with matches, and the last query s groups stay open after clearing', async () => {
    withDrafts();
    await render();
    // Fold every group by hand.
    for (const name of ['alpha', 'beta', 'Temporary workspaces']) {
      await act(async () => folderHeader(name).click());
    }
    await act(async () => temporaryHeader().click());
    expect(allRows()).toHaveLength(0);

    // Typing passes through a prefix that also matches beta.
    await search('dra');
    expect(groupOrder()).toEqual([BETA, ALPHA, UNBOUND_FOLDER_ID]);
    expect(rows('Draw diagram')).toHaveLength(1);

    await search('draft');
    // Only the groups with matches are listed — and they are open.
    expect(groupOrder()).toEqual([ALPHA, UNBOUND_FOLDER_ID]);
    expect(rows('Draft notes')).toHaveLength(1);
    expect(rows('Draft idea')).toHaveLength(1);
    expect(folderHeader('alpha').getAttribute('aria-expanded')).toBe('true');
    expect(temporaryHeader().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-slot="sidebar-group-summary"]')).toBeNull();
    // A header click folds nothing while a search is typed.
    await act(async () => folderHeader('alpha').click());
    expect(rows('Draft notes')).toHaveLength(1);

    await search('');
    // The final query's groups stay open...
    expect(rows('Draft notes')).toHaveLength(1);
    expect(rows('Draft idea')).toHaveLength(1);
    expect(folderHeader('alpha').getAttribute('aria-expanded')).toBe('true');
    expect(temporaryHeader().getAttribute('aria-expanded')).toBe('true');
    // ...a group matched only by the intermediate 「dra」 keeps its fold...
    expect(rows('Draw diagram')).toHaveLength(0);
    expect(folderHeader('beta').getAttribute('aria-expanded')).toBe('false');
    // ...and so does one the search never matched.
    expect(rows('Chat t')).toHaveLength(0);
    expect(folderHeader('Temporary workspaces').getAttribute('aria-expanded')).toBe('false');
  });

  it('is disabled while a search is typed, and keeps its label', async () => {
    withDrafts();
    await render();
    await act(async () => toggle()?.click());
    expect(allRows()).toHaveLength(0);
    expect(toggle()?.getAttribute('aria-label')).toBe('Expand all groups');
    expect(toggle()?.disabled).toBe(false);

    await search('draft');
    // Every group with matches is open, but the toggle neither flips its
    // label (it speaks for the stored folds) nor can be pressed.
    expect(allRows()).toHaveLength(2);
    expect(toggle()?.getAttribute('aria-label')).toBe('Expand all groups');
    expect(toggle()?.title).toBe('Expand all groups');
    expect(toggle()?.disabled).toBe(true);

    // Cleared: the matched groups stay open, so it is Collapse all again.
    await search('');
    expect(allRows()).toHaveLength(2);
    expect(toggle()?.disabled).toBe(false);
    expect(toggle()?.getAttribute('aria-label')).toBe('Collapse all groups');
  });
});

describe('repositories by add time (issue #15, decision 186)', () => {
  const GAMMA = 'project:/repo/gamma';
  const ALPHA_ADDED = 1_800_000_000_000;
  const GAMMA_ADDED = 1_800_000_060_000;
  const BETA_ADDED = 1_800_000_120_000;

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

  /**
   * The three repositories with their stamps. Beta was added LAST, so it heads
   * the list — while its chats are also the newest, which is what makes the
   * point: under decision 170 the two facts could not be told apart.
   */
  const repos = [
    { id: ALPHA, path: '/repo/alpha', name: 'alpha', addedAt: ALPHA_ADDED },
    { id: GAMMA, path: '/repo/gamma', name: 'gamma', addedAt: GAMMA_ADDED },
    { id: BETA, path: '/repo/beta', name: 'beta', addedAt: BETA_ADDED },
  ];

  /** A turn in chat `id` ends: its folder's activity moves to `updatedAt`. */
  const touch = (id: string, updatedAt: number) =>
    act(async () => {
      useChatSessionsStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === id ? { ...session, updatedAt } : session
        ),
      }));
    });

  it('newest-added first, temporary workspaces last — BETA added last, so it leads', async () => {
    await render(repos);
    expect(folderOrder()).toEqual(['beta', 'gamma', 'alpha', 'Temporary workspaces']);
  });

  it('a chat finishing a turn does NOT move its folder', async () => {
    await render(repos);
    // Alpha's chat becomes the most recently active thing in the app.
    await touch('a', NOW + 120_000);
    expect(folderOrder()).toEqual(['beta', 'gamma', 'alpha', 'Temporary workspaces']);
  });

  it('repositories with no stamp fall back to their stored position, which IS the add order', async () => {
    // A build without `addedAt` (or a hand-edited store). Only gamma carries a
    // stamp; alpha and beta fall back to where they sit in the list, and a
    // repository is appended when it is added — so a later position means added
    // later, which is exactly the fact this order wants. That puts beta
    // (position 2) ahead of alpha (position 0).
    await render([{ id: GAMMA, path: '/repo/gamma', name: 'gamma', addedAt: GAMMA_ADDED }]);
    expect(folderOrder()).toEqual(['gamma', 'beta', 'alpha', 'Temporary workspaces']);
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

  // Decision 193 rule 5 (decision 156 doubt ②): Enter commits and, like Escape,
  // hands focus back to the row; a click elsewhere keeps focus where it went.
  it('E193-5: Enter commits the new name and hands focus back to the row', async () => {
    await render();
    await act(async () => {
      rows('Chat a')[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const input = editor() as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    await typeInto(input, 'Kept name');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(mocks.rename).toHaveBeenCalledWith('a', 'Kept name');
    expect(editor()).toBeNull();
    const row = rows('Chat a')[0];
    expect(row, 'the row is back').toBeTruthy();
    expect(document.activeElement).toBe(row);
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
