// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';
import { resetHomeDraftForTests, useHomeDraftStore } from '@/stores/homeDraft';

/**
 * Decision 174 (GitHub issue #6, second wave; user ruling 2026-10-10, ruling
 * 7): the sidebar's 「＋新建」, a folder's 「＋」 and an empty folder's
 * 「新建对话」 open the home page with the corresponding repository picked,
 * and make no conversation — the first send on the home page does.
 *
 * Stubbed like the other LeftNav mount tests: the persisted index (IPC),
 * session activation and the diff-stats poller.
 */

vi.hoisted(() => {
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
  useActivateSession: () => (sessionId: string) =>
    useChatSessionsStore.getState().selectSession(sessionId),
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

function chat(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: ALPHA,
    workspaceId: 'ws-alpha',
    title: `Chat ${id}`,
    status: 'running',
    updatedAt: Date.now(),
    ...extra,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetHomeDraftForTests();
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
    activeSessionId: 'a',
    hostBoundSessionIds: [],
    unreadSessionIds: [],
    pendingPermissions: [],
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(LeftNav, { repositories: REPOS as never })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const sessionIds = () => useChatSessionsStore.getState().sessions.map((session) => session.id);
const button = (predicate: (node: HTMLButtonElement) => boolean) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(predicate);
  if (!found) throw new Error('button not rendered');
  return found;
};

describe('「新建」 opens the home page (decision 174)', () => {
  it('「＋新建」: the home page, with the open conversation’s repository picked; the running chat keeps running', async () => {
    const newButton = button((node) => node.textContent?.trim() === 'New');
    expect(newButton.title).toBe('New chat (opens the home page)');
    await act(async () => newButton.click());

    const state = useChatSessionsStore.getState();
    expect(state.activeSessionId).toBeNull();
    expect(sessionIds()).toEqual(['a']);
    expect(state.sessions[0]?.status).toBe('running');
    expect(useHomeDraftStore.getState().pick).toEqual({ kind: 'path', path: '/repo/alpha' });
  });

  it('「＋新建」 on the home page leaves the user’s own pick alone', async () => {
    await act(async () => useChatSessionsStore.getState().selectSession(null));
    useHomeDraftStore.getState().setPick({ kind: 'unbound' });
    await act(async () => button((node) => node.textContent?.trim() === 'New').click());
    expect(useHomeDraftStore.getState().pick).toEqual({ kind: 'unbound' });
    expect(sessionIds()).toEqual(['a']);
  });

  it('a folder’s 「＋」: the home page with that repository picked, and no blank chat', async () => {
    const plus = button((node) => node.title === 'New session in beta');
    await act(async () => plus.click());
    expect(useChatSessionsStore.getState().activeSessionId).toBeNull();
    expect(useHomeDraftStore.getState().pick).toEqual({ kind: 'path', path: '/repo/beta' });
    expect(sessionIds()).toEqual(['a']);
  });

  it('an empty folder’s 「新建对话」 row does the same', async () => {
    const row = button((node) => node.textContent?.trim() === 'New chat');
    await act(async () => row.click());
    expect(useChatSessionsStore.getState().activeSessionId).toBeNull();
    expect(useHomeDraftStore.getState().pick).toEqual({ kind: 'path', path: '/repo/beta' });
    expect(sessionIds()).toEqual(['a']);
  });
});
