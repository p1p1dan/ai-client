// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';
import { resetHomeDraftForTests, useHomeDraftStore } from '@/stores/homeDraft';
import { HOME_AREA_CLASS, HOME_TOP_SPACER_CLASS } from '../homeViewModel';

/**
 * Decision 174 (GitHub issue #6, second wave; user rulings 2026-10-10), the
 * home page rendered for real: three things only — the title naming the work
 * bar's repository, 「最近对话」 (five rows and 「查看更多（N）」), and the
 * composer, which `ChatWorkspace` docks under it (not part of this view).
 */

const mocks = vi.hoisted(() => {
  // Must be hoisted: stores rehydrate from `electronAPI` at import time.
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
  } as unknown as typeof window.electronAPI;
  return { activate: vi.fn() };
});

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name])) : key,
    locale: 'en',
  }),
}));
vi.mock('@/components/workspace-shell/useActivateSession', () => ({
  useActivateSession: () => (sessionId: string) => mocks.activate(sessionId),
}));

const { HomeView } = await import('../HomeView');

const ALPHA = 'project:/repo/alpha';
const BETA = 'project:/repo/beta';
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

function setStore(sessions: ChatSession[], withRepositories = true) {
  useChatSessionsStore.setState({
    projects: withRepositories
      ? [
          { id: ALPHA, name: 'alpha' },
          { id: BETA, name: 'beta' },
        ]
      : [],
    workspaces: withRepositories
      ? [
          {
            id: 'ws-alpha',
            projectId: ALPHA,
            name: 'Main',
            kind: 'main',
            path: '/repo/alpha',
            branch: 'main',
          },
          {
            id: 'ws-beta',
            projectId: BETA,
            name: 'Main',
            kind: 'main',
            path: '/repo/beta',
            branch: 'develop',
          },
        ]
      : [],
    sessions,
    messages: {},
    activeSessionId: null,
    hostBoundSessionIds: [],
    unreadSessionIds: [],
    pendingPermissions: [],
  });
}

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(HomeView)));
}

const title = () => container.querySelector('[data-home-title]') as HTMLElement;
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-home-row]')];
const buttonByText = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text
  );

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.activate.mockClear();
  resetHomeDraftForTests();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('the title', () => {
  it('names the most recently active repository by default, emphasised', async () => {
    setStore([
      chat('old', { updatedAt: NOW - 60_000 }),
      chat('beta-new', { projectId: BETA, workspaceId: 'ws-beta', updatedAt: NOW }),
    ]);
    await mount();
    expect(title().textContent).toBe('Create with PiLab in beta');
    const name = container.querySelector('[data-home-workspace]') as HTMLElement;
    expect(name.textContent).toBe('beta');
    expect(name.className).toContain('font-semibold');
    expect(name.className).toContain('text-foreground');
    expect(name.className).toContain('max-w-[14em]');
    expect(name.title).toBe('beta');
    // The sentence itself is quiet: 26px, 400, the secondary ink.
    expect(title().className).toContain('text-display');
    expect(title().className).toContain('font-normal');
    expect(title().className).toContain('text-muted-foreground');
    expect(container.querySelector('[data-home-subline]')).toBeNull();
  });

  it('follows the repository picked on the work bar', async () => {
    setStore([chat('a')]);
    await mount();
    expect(title().textContent).toBe('Create with PiLab in alpha');
    await act(async () =>
      useHomeDraftStore.getState().setPick({ kind: 'path', path: '/repo/beta' })
    );
    expect(title().textContent).toBe('Create with PiLab in beta');
  });

  it('「不选仓库」: emphasises PiLab and says where the chat runs', async () => {
    setStore([chat('a')]);
    useHomeDraftStore.getState().setPick({ kind: 'unbound' });
    await mount();
    expect(title().textContent).toBe('Create with PiLab');
    expect(container.querySelector('[data-home-workspace]')).toBeNull();
    expect(title().querySelector('span')?.textContent).toBe('PiLab');
    expect(container.querySelector('[data-home-subline]')?.textContent).toBe(
      'This chat is not bound to a repository; it runs in a private temporary folder.'
    );
  });

  it('with no repository at all, two deliberate lines under the title', async () => {
    setStore([], false);
    await mount();
    expect(title().textContent).toBe('Create with PiLab');
    const subline = container.querySelector('[data-home-subline]') as HTMLElement;
    expect(subline.querySelector('br')).not.toBeNull();
    expect(subline.textContent).toBe(
      'No repository added yet; this chat runs in a private temporary folder.You can add a repository from the bar below.'
    );
  });
});

describe('最近对话', () => {
  const twelve = () =>
    Array.from({ length: 12 }, (_, index) => chat(`c${index}`, { updatedAt: NOW - index * 1000 }));

  it('five rows, then 「查看更多（N）」 — and no 「新建对话」 / 「添加仓库」 buttons', async () => {
    setStore(twelve());
    await mount();
    expect(rows().map((row) => row.dataset.homeRow)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(buttonByText('View more (7)')).toBeDefined();
    expect(buttonByText('Show less')).toBeUndefined();
    expect(container.textContent).toContain('Recent conversations');
    expect(container.querySelector('[data-home-group]')).toBeNull();
    for (const removed of ['New chat', 'Add Repository']) {
      expect(buttonByText(removed)).toBeUndefined();
    }
  });

  it('「查看更多」 lists the rest, grouped by day, ending in 「收起」', async () => {
    setStore(twelve());
    await mount();
    await act(async () => buttonByText('View more (7)')?.click());
    expect(rows()).toHaveLength(12);
    expect(container.querySelector('[data-home-group="today"]')?.textContent).toBe('Today');
    await act(async () => buttonByText('Show less')?.click());
    expect(rows()).toHaveLength(5);
  });

  it('a row is 15px body ink, carries 「文件夹 · 分支」 and the sidebar tooltip, and opens on click', async () => {
    setStore([chat('a', { title: 'Fix login' })]);
    await mount();
    const row = rows()[0] as HTMLElement;
    expect(row.className).toContain('h-9');
    expect(row.className).toContain('text-ui');
    expect(row.textContent).toContain('Fix login');
    expect(row.textContent).toContain('alpha · main');
    expect(row.title.split('\n').slice(0, 2)).toEqual(['Fix login', 'alpha · main']);
    await act(async () => row.click());
    expect(mocks.activate).toHaveBeenCalledWith('a');
  });

  it('a temporary chat says so where the folder would be', async () => {
    setStore([chat('t', { projectId: '', workspaceId: '', title: 'Scratch idea' })]);
    await mount();
    expect(rows()[0]?.textContent).toContain('Temporary chats');
  });

  it('with no conversation there is no list at all, only the title', async () => {
    setStore([]);
    await mount();
    expect(container.textContent).not.toContain('Recent conversations');
  });
});

describe('layout (prototype v4)', () => {
  it('anchors the title at the golden section of the room above the composer, in CSS', async () => {
    setStore([chat('a')]);
    await mount();
    const area = container.querySelector('[data-home-view]') as HTMLElement;
    expect(area.className).toBe(HOME_AREA_CLASS);
    expect(HOME_AREA_CLASS).toContain('@container-[size]');
    expect(HOME_TOP_SPACER_CLASS).toContain('h-[calc(38.2cqh_-_var(--text-display)*0.65)]');
    expect(HOME_TOP_SPACER_CLASS).toContain('min-h-12');
    expect(area.querySelector(`[class="${HOME_TOP_SPACER_CLASS}"]`)).not.toBeNull();
  });
});
