// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Decision 174 (GitHub issue #6, second wave; user rulings 2026-10-10), the
 * composer's work bar rendered for real:
 *
 * - on the home page it is always there — repository dropdown (「未选仓库」
 *   with none), the branch the next conversation will start on, run location —
 *   and a branch pick is a draft: nothing is checked out;
 * - with a conversation running in that checkout the branch is locked, and the
 *   lock names the repository;
 * - a temporary chat's bar says 「临时对话」 where the repository would be, so
 *   its card sits at the same height as every other conversation's.
 */

const api = vi.hoisted(() => {
  const git = {
    getBranches: vi.fn(async () => [
      { name: 'main', current: true },
      { name: 'feature/home', current: false },
    ]),
    checkout: vi.fn(async () => undefined),
  };
  window.electronAPI = {
    env: { platform: 'linux', HOME: '/home/test' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    window: { getRepositoryRuntimeContext: async () => ({ kind: 'local' }) },
    remote: { listProfiles: async () => [] },
    worktree: { list: async () => [] },
    git,
  } as unknown as typeof window.electronAPI;
  return { git };
});

vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));
vi.mock('@/stores/settings', () => {
  const state = { defaultTemporaryPath: '', temporaryWorkspaceEnabled: false };
  return {
    useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});

import { type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';
import { resetHomeDraftForTests, useHomeDraftStore } from '@/stores/homeDraft';
import { ComposerTargetBar } from '../ComposerTargetBar';
import { targetRowClass } from '../middleColumnLayout';

let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;

function chat(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: 'p-alpha',
    workspaceId: 'ws-alpha',
    title: id,
    status: 'idle',
    updatedAt: 1,
    ...extra,
  };
}

function setStore(input: {
  sessions: ChatSession[];
  activeSessionId: string | null;
  repos?: boolean;
}) {
  const repos = input.repos ?? true;
  useChatSessionsStore.setState({
    activeSessionId: input.activeSessionId,
    sessions: input.sessions,
    projects: repos ? [{ id: 'p-alpha', name: 'alpha' }] : [],
    workspaces: repos
      ? [
          {
            id: 'ws-alpha',
            projectId: 'p-alpha',
            name: 'Main',
            kind: 'main',
            path: '/repo/alpha',
            branch: 'main',
            gitEnabled: true,
          },
        ]
      : [],
    messages: {},
    hostBoundSessionIds: [],
  } as never);
}

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ComposerTargetBar, { mode: 'session', sending: false })
      )
    )
  );
  await settle();
}

/** Let the queries (run location, branch list) answer. */
async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const row = () => container.firstElementChild as HTMLElement | null;
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('button')];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetHomeDraftForTests();
  api.git.checkout.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  client.clear();
  vi.unstubAllGlobals();
});

describe('the work bar on the home page', () => {
  it('shows the draft repository as a dropdown, its branch and the run location', async () => {
    setStore({ sessions: [chat('a')], activeSessionId: null });
    await mount();
    expect(row()?.className).toBe(targetRowClass('session'));
    expect(buttons()[0]?.textContent).toContain('alpha');
    expect(buttons()[0]?.title).toBe('/repo/alpha');
    expect(container.textContent).toContain('main');
    expect(container.textContent).toContain('This PC');
    // A dropdown, not the conversation's locked label.
    expect(container.querySelector('[role="note"]')).toBeNull();
  });

  it('is there with no repository too: 「未选仓库」, no branch', async () => {
    setStore({ sessions: [], activeSessionId: null, repos: false });
    await mount();
    expect(row()?.className).toBe(targetRowClass('session'));
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0]?.textContent).toContain('No repository chosen');
  });

  it('a branch pick is recorded for the send, not checked out', async () => {
    setStore({ sessions: [chat('a')], activeSessionId: null });
    await mount();
    // The open-then-pick sequence the other Base UI select tests use: the
    // keydown arms the popup, the click commits, the timeout lets it settle.
    const press = async (element: HTMLElement) => {
      await act(async () => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      await act(async () => element.click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
    };
    const branchTrigger = container.querySelector<HTMLElement>('[data-slot="select-trigger"]');
    expect(branchTrigger?.textContent).toContain('main');
    await press(branchTrigger as HTMLElement);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
      node.textContent?.includes('feature/home')
    );
    expect(option).toBeDefined();
    await press(option as HTMLElement);

    expect(api.git.checkout).not.toHaveBeenCalled();
    expect(useHomeDraftStore.getState().branch).toEqual({
      workdir: '/repo/alpha',
      name: 'feature/home',
      create: false,
    });
    expect(branchTrigger?.textContent).toContain('feature/home');
  });

  it('locks the branch while a conversation runs in that checkout, naming the repository', async () => {
    setStore({ sessions: [chat('a', { status: 'running' })], activeSessionId: null });
    await mount();
    const lock = container.querySelector('[role="status"][aria-label*="has a chat running"]');
    expect(lock?.getAttribute('aria-label')).toBe(
      'alpha has a chat running — the branch can be switched once it ends'
    );
  });
});

describe('the work bar of a temporary chat', () => {
  it('says 「临时对话」 where the repository would be', async () => {
    setStore({
      sessions: [chat('t', { projectId: '', workspaceId: '' })],
      activeSessionId: 't',
    });
    await mount();
    expect(row()?.className).toBe(targetRowClass('session'));
    expect(container.querySelector('[role="note"]')?.getAttribute('aria-label')).toBe(
      'Temporary chat'
    );
  });
});
