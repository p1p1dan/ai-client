// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';
import { useSidebarArchiveStore } from '@/stores/sidebarArchive';

/**
 * Layout 5b (ruling L2), rendered for real: the grouping is switched from the
 * menu a group heading carries, the choice is stored, and 「按状态」 /
 * 「按时间」 list derived buckets beside the user's groups (which stay
 * untouched). Stubbed like the other LeftNav mount tests.
 */
vi.hoisted(() => {
  // Must be hoisted: stores rehydrate from `electronAPI` at import time.
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
  } as unknown as typeof window.electronAPI;
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
    rename: async () => true,
    archive: async () => true,
    archiveMany: async () => 0,
    close: async () => true,
  }),
}));
vi.mock('@/components/workspace-shell/useActivateSession', () => ({
  useActivateSession: () => (sessionId: string) => {
    useChatSessionsStore.getState().selectSession(sessionId);
  },
}));
vi.mock('@/components/workspace-shell/useFolderDiffStats', () => ({
  useFolderDiffStatsPolling: () => {},
}));

const { LeftNav } = await import('../LeftNav');

const ALPHA = 'project:/repo/alpha';
const REPOS = [{ id: ALPHA, path: '/repo/alpha', name: 'alpha', addedAt: 1_800_000_000_000 }];
const NOW = Date.now();
const DAY = 86_400_000;

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
  useChatSessionsStore.setState({
    projects: [{ id: ALPHA, name: 'alpha' }],
    workspaces: [
      { id: 'ws-alpha', projectId: ALPHA, name: 'Main', kind: 'main', path: '/repo/alpha' },
    ],
    sessions: [
      chat('run', { status: 'running' }),
      chat('ask', { status: 'waiting_question', updatedAt: NOW - 1000 }),
      chat('approve', { updatedAt: NOW - 2000 }),
      chat('old', { updatedAt: NOW - 40 * DAY }),
    ],
    messages: {},
    activeSessionId: null,
    hostBoundSessionIds: [],
    unreadSessionIds: [],
    pendingPermissions: [{ requestId: 'p1', sessionId: 'approve' } as never],
  });
  useSidebarArchiveStore.setState({
    archiveMode: 'workspace',
    groups: [{ id: 'g-work', name: 'Work', createdAt: 1 }],
    assignments: { old: 'g-work' },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => root.render(createElement(LeftNav, { repositories: REPOS as never })));
}

function headings(): string[] {
  return [...container.querySelectorAll('[data-slot="sidebar-bucket-name"]')].map(
    (node) => node.textContent ?? ''
  );
}

function bucketTitles(bucketId: string): string[] {
  const section = container.querySelector(`[data-sidebar-group="${bucketId}"]`);
  return [...(section?.querySelectorAll('[data-sidebar-nav="row"]') ?? [])].map(
    (node) => node.firstElementChild?.textContent ?? ''
  );
}

async function pickGrouping(label: string): Promise<void> {
  const trigger = container.querySelector<HTMLElement>('[aria-label="Group and filter chats"]');
  expect(trigger, 'the list menu sits on a heading').toBeTruthy();
  await act(async () => trigger?.click());
  const item = [...document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')].find(
    (node) => node.textContent?.trim() === label
  );
  expect(item, label).toBeTruthy();
  await act(async () => item?.click());
}

describe('the grouping switcher (layout 5b, ruling L2)', () => {
  it('offers the four groupings with the current one checked, and stores the pick', async () => {
    await render();
    const trigger = container.querySelector<HTMLElement>('[aria-label="Group and filter chats"]');
    await act(async () => trigger?.click());
    const radios = [...document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')];
    expect(radios.map((node) => node.textContent?.trim())).toEqual([
      'By repository',
      'By my groups',
      'By status',
      'By date',
    ]);
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true');
    await act(async () => radios[2]?.click());
    expect(useSidebarArchiveStore.getState().archiveMode).toBe('status');
  });

  it('by status: 运行中, 等你处理 (a pending approval counts), 最近完成', async () => {
    await render();
    await pickGrouping('By status');
    expect(headings()).toEqual(['Running', 'Waiting for you', 'Recently finished']);
    expect(bucketTitles('status:running')).toEqual(['Chat run']);
    expect(bucketTitles('status:waiting')).toEqual(['Chat ask', 'Chat approve']);
    expect(bucketTitles('status:done')).toEqual(['Chat old']);
    // The rows name their repository, as no repository heading does here.
    expect(
      container.querySelector('[data-sidebar-group="status:done"] [title="alpha"]')
    ).toBeTruthy();
    // Nothing is filed: the user's group assignment is untouched.
    expect(useSidebarArchiveStore.getState().assignments).toEqual({ old: 'g-work' });
  });

  it('by date: today and earlier, empty buckets left out; back to repositories', async () => {
    await render();
    await pickGrouping('By date');
    expect(headings()).toEqual(['Today', 'Earlier']);
    expect(bucketTitles('date:earlier')).toEqual(['Chat old']);
    await pickGrouping('By repository');
    expect(headings()).toEqual([]);
    expect(container.querySelector(`[data-sidebar-group="${ALPHA}"]`)).toBeTruthy();
  });

  it('the list right-click also switches it, so no heading is needed', async () => {
    useChatSessionsStore.setState({ sessions: [] });
    useSidebarArchiveStore.setState({ archiveMode: 'status' });
    await render();
    expect(container.querySelector('[aria-label="Group and filter chats"]')).toBeNull();
    const list = container.querySelector('[data-slot="sidebar-list"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
      );
    });
    const sub = [...document.querySelectorAll<HTMLElement>('[data-slot="menu-sub-trigger"]')].find(
      (node) => node.textContent?.trim() === 'Group chats'
    );
    expect(sub).toBeTruthy();
  });
});
