// @vitest-environment happy-dom
import type { ChatSearchQuery, ChatSearchResult, ChatSearchSessionResult } from '@shared/types';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';

/**
 * Chat search (stage 3): the dialog's 「对话」 tab, mounted for real against a
 * mocked `chatSearch.query` and the real session store.
 */

const mocks = vi.hoisted(() => {
  // Stores rehydrate from `electronAPI` at import time.
  const query = vi.fn<(query: ChatSearchQuery) => Promise<ChatSearchResult>>();
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined },
    chatSearch: { query },
    search: { files: vi.fn(), content: vi.fn() },
  } as unknown as typeof window.electronAPI;
  return { query };
});

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name])) : key,
    locale: 'en',
  }),
}));
vi.mock('../SearchPreviewPanel', () => ({ SearchPreviewPanel: () => null }));

const { GlobalSearchDialog } = await import('../GlobalSearchDialog');
const { INDEXING_REQUERY_MS, RECENT_CHAT_LIMIT } = await import('../useChatSearch');

const NOW = Date.now();

function chat(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: 'project:/repo/alpha',
    workspaceId: 'ws-alpha',
    title: `Chat ${id}`,
    status: 'idle',
    updatedAt: NOW,
    ...extra,
  };
}

function hit(id: string, extra: Partial<ChatSearchSessionResult> = {}): ChatSearchSessionResult {
  return {
    sessionId: id,
    title: `Chat ${id}`,
    workspacePath: '/repo/alpha',
    updatedAt: NOW,
    titleMatch: false,
    snippet: { role: 'user', text: '…lot 8GE21E15 yield', matchStart: 5, matchLength: 8 },
    hitCount: 3,
    messageKeys: ['h:1', 'h:2', 'h:3'],
    ...extra,
  };
}

function result(
  sessions: ChatSearchSessionResult[],
  indexing = null as ChatSearchResult['indexing']
) {
  return { sessions, truncated: false, indexing } satisfies ChatSearchResult;
}

let container: HTMLDivElement;
let root: Root;
const onOpenChange = vi.fn();
const onOpenChat = vi.fn();

function setStore(sessions: ChatSession[]) {
  useChatSessionsStore.setState({
    workspaces: [
      {
        id: 'ws-alpha',
        projectId: 'project:/repo/alpha',
        name: 'Main',
        kind: 'main',
        path: '/repo/alpha',
      },
      {
        id: 'ws-beta',
        projectId: 'project:/repo/beta',
        name: 'Main',
        kind: 'main',
        path: '/repo/beta',
      },
    ],
    sessions,
    messages: {},
    activeSessionId: null,
  });
}

async function mount(rootPath: string | null) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(GlobalSearchDialog, {
        open: true,
        onOpenChange,
        rootPath,
        onOpenFile: vi.fn(),
        onOpenChat,
      })
    )
  );
}

const input = () =>
  document.querySelector<HTMLInputElement>('input[type="text"]') as HTMLInputElement;
const tab = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) =>
    button.textContent?.includes(label)
  ) as HTMLButtonElement;
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-chat-search-row]')];
const status = () => document.querySelector('[data-chat-search-status]');
const toggle = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-slot="toggle-group"] button')].find(
    (button) => button.textContent === label
  ) as HTMLButtonElement;

async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Past both debounces (the file hook's 300 ms and the chat hook's 200 ms).
  await act(() => vi.advanceTimersByTimeAsync(350));
}

async function key(name: string) {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.query.mockReset();
  onOpenChange.mockReset();
  onOpenChat.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the 「对话」 tab', () => {
  it('is the default tab, and without a workspace only the file tabs are disabled', async () => {
    setStore([chat('a')]);
    await mount(null);
    expect(tab('Chats').getAttribute('aria-selected')).toBe('true');
    expect(tab('Chats').disabled).toBe(false);
    expect(tab('Files').disabled).toBe(true);
    expect(tab('Content').disabled).toBe(true);
    expect(toggle('Current repository').hasAttribute('data-disabled')).toBe(true);
    expect(input().placeholder).toBe('Search chat titles and messages');
  });

  it('enables the file tabs with a workspace and leaves their behaviour alone', async () => {
    setStore([chat('a')]);
    await mount('/repo/alpha');
    expect(tab('Files').disabled).toBe(false);
    await act(async () => tab('Files').click());
    expect(tab('Files').getAttribute('aria-selected')).toBe('true');
    expect(input().placeholder).toBe('Search file name...');
    expect(rows()).toHaveLength(0);
  });

  it('lists recent chats newest first for an empty query, without asking Main', async () => {
    const many = Array.from({ length: RECENT_CHAT_LIMIT + 5 }, (_, index) =>
      chat(`c${index}`, { updatedAt: NOW - index * 60_000 })
    );
    setStore([...many].reverse());
    await mount(null);
    expect(rows()).toHaveLength(RECENT_CHAT_LIMIT);
    expect(rows()[0].dataset.chatSearchRow).toBe('c0');
    expect(rows()[1].dataset.chatSearchRow).toBe('c1');
    expect(document.body.textContent).toContain('Recent chats');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('renders a result row: title, repository chip, role, marked snippet, more matches', async () => {
    setStore([chat('a'), chat('b', { workspaceId: 'ws-beta', title: 'Yield notes' })]);
    mocks.query.mockResolvedValue(
      result([hit('b', { title: 'Yield notes', titleMatch: true, hitCount: 3 })])
    );
    await mount(null);
    await type(' yield ');
    expect(mocks.query).toHaveBeenCalledWith({ text: 'yield', scope: { kind: 'all' }, limit: 50 });
    expect(rows()).toHaveLength(1);
    const row = rows()[0];
    expect(row.textContent).toContain('beta');
    expect(row.textContent).toContain('You:');
    expect(row.textContent).toContain('2 more matches');
    const marks = [...row.querySelectorAll('mark')].map((mark) => mark.textContent);
    // The title marks the query; the snippet marks Main's range.
    expect(marks).toEqual(['Yield', '8GE21E15']);
  });

  it('asks again while the index is being built, then stops', async () => {
    setStore([chat('a'), chat('b')]);
    mocks.query
      .mockResolvedValueOnce(result([hit('a')], { done: 1, total: 4 }))
      .mockResolvedValueOnce(result([hit('a'), hit('b')]));
    await mount(null);
    await type('8GE21E15');
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(status()?.textContent).toBe('Building the search index… 1 / 4');
    expect(rows()).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(INDEXING_REQUERY_MS));
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(status()).toBeNull();
    expect(rows()).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(INDEXING_REQUERY_MS * 3));
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('drops results for chats the renderer does not list', async () => {
    setStore([chat('a')]);
    mocks.query.mockResolvedValue(result([hit('a'), hit('archived')]));
    await mount(null);
    await type('8GE21E15');
    expect(rows().map((row) => row.dataset.chatSearchRow)).toEqual(['a']);
  });

  it('moves with the arrows, opens with Enter and closes with Esc', async () => {
    setStore([chat('a'), chat('b')]);
    mocks.query.mockResolvedValue(result([hit('a'), hit('b')]));
    await mount(null);
    await type('8GE21E15');
    expect(rows()[0].getAttribute('aria-selected')).toBe('true');
    await key('ArrowDown');
    expect(rows()[1].getAttribute('aria-selected')).toBe('true');
    await key('ArrowDown');
    expect(rows()[1].getAttribute('aria-selected')).toBe('true');
    await key('Enter');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChat).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'b' }),
      '8GE21E15'
    );
    onOpenChange.mockReset();
    await key('Escape');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('narrows to the current repository, for recents and for queries', async () => {
    setStore([chat('a'), chat('b', { workspaceId: 'ws-beta', updatedAt: NOW + 1 })]);
    mocks.query.mockResolvedValue(result([hit('a')]));
    await mount('/repo/alpha');
    expect(rows().map((row) => row.dataset.chatSearchRow)).toEqual(['b', 'a']);
    await act(async () => toggle('Current repository').click());
    expect(rows().map((row) => row.dataset.chatSearchRow)).toEqual(['a']);
    await type('8GE21E15');
    expect(mocks.query).toHaveBeenLastCalledWith({
      text: '8GE21E15',
      scope: { kind: 'workspace', workspacePath: '/repo/alpha' },
      limit: 50,
    });
  });
});
