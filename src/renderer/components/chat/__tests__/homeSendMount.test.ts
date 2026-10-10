// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Decision 174 (GitHub issue #6, second wave; user rulings 2026-10-10), mounted
 * in the real `ChatComposer` with no conversation open — the home page:
 *
 * - the send makes the conversation, on the work bar's draft target, with the
 *   target's own directory (the old path took the render's empty `cwd`, and the
 *   chat landed in a scratch directory); picking makes nothing;
 * - a branch picked on the home page is switched to by the send, before the
 *   conversation exists — or, under the branch column's locks, not at all: the
 *   notice above the card asks, and its two buttons send on the current branch
 *   or cancel; a failed checkout leaves the message and makes nothing.
 *
 * The send is cut short at `createSession` (it rejects): what is under test is
 * everything up to it. The target bar and the chips are stubbed out.
 */

const mocks = vi.hoisted(() => {
  const api = {
    ensureHost: vi.fn(async () => undefined),
    createSession: vi.fn(async (_input: { sessionId: string; workspacePath: string }) => {
      throw new Error('createSession refused (test)');
    }),
    ensureScratchWorkspace: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      path: `/tmp/scratch/${sessionId}`,
    })),
    checkout: vi.fn(async (_workdir: string, _branch: string) => undefined),
    createBranch: vi.fn(async (_workdir: string, _name: string) => undefined),
  };
  window.electronAPI = {
    env: { platform: 'linux', HOME: '/home/test' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: {
      onRuntimeEvent: () => () => undefined,
      getSlashCommands: async () => ({ commands: [], truncated: false }),
      ensureHost: api.ensureHost,
      createSession: api.createSession,
      ensureScratchWorkspace: api.ensureScratchWorkspace,
    },
    git: { checkout: api.checkout, createBranch: api.createBranch },
  } as unknown as typeof window.electronAPI;
  return { api, toast: vi.fn() };
});

vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));
vi.mock('@/stores/settings', () => {
  const state = { chatAgentDefaults: undefined, showToolDiff: false };
  return {
    useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/components/ui/toast', () => ({ toastManager: { add: mocks.toast } }));
vi.mock('@/stores/runtimeEventBus', () => ({ subscribeRuntimeEvent: () => () => undefined }));
vi.mock('../ComposerTargetBar', () => ({ ComposerTargetBar: () => null }));
vi.mock('../ComposerModelTrigger', () => ({ ComposerModelTrigger: () => null }));
vi.mock('../ComposerPermissionTrigger', () => ({ ComposerPermissionTrigger: () => null }));
vi.mock('../ComposerUsageChip', () => ({ ComposerUsageChip: () => null }));
vi.mock('../ComposerAttachMenu', () => ({ ComposerAttachMenu: () => null }));
vi.mock('../PiModelSyncNotice', () => ({ PiModelSyncNotice: () => null }));
vi.mock('../ModelMissingNotice', () => ({ ModelMissingNotice: () => null }));
vi.mock('../QueuedMessageStrip', () => ({ QueuedMessageStrip: () => null }));
vi.mock('../useQueueRelease', () => ({ useQueueRelease: () => undefined }));
vi.mock('../usePiModelCatalog', () => ({ usePiModelCatalog: () => ({ catalog: null }) }));
vi.mock('../useHostStatus', () => {
  const snapshot = { status: { state: 'ready' }, retry: async () => undefined };
  return { useHostStatus: () => snapshot };
});

import { type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';
import { resetComposerDraftsForTests } from '@/stores/composerDrafts';
import { resetHomeDraftForTests, useHomeDraftStore } from '@/stores/homeDraft';
import { ChatComposer } from '../ChatComposer';

let root: Root | undefined;
let container: HTMLDivElement;

const ALPHA = 'p-alpha';

function chat(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: ALPHA,
    workspaceId: 'ws-alpha',
    title: id,
    status: 'idle',
    updatedAt: 1,
    ...extra,
  };
}

function setStore(sessions: ChatSession[]) {
  useChatSessionsStore.setState({
    activeSessionId: null,
    sessions,
    projects: [
      { id: ALPHA, name: 'alpha' },
      { id: 'p-beta', name: 'beta' },
    ],
    workspaces: [
      {
        id: 'ws-alpha',
        projectId: ALPHA,
        name: 'Main',
        kind: 'main',
        path: '/repo/alpha',
        branch: 'main',
        gitEnabled: true,
      },
      {
        id: 'ws-beta',
        projectId: 'p-beta',
        name: 'Main',
        kind: 'main',
        path: '/repo/beta',
        branch: 'develop',
        gitEnabled: true,
      },
    ],
    messages: {},
    hostBoundSessionIds: [],
    historyErrors: {},
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  } as never);
}

async function mountComposer() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(ChatComposer, { mode: 'session' })));
}

const box = () => container.querySelector('textarea') as HTMLTextAreaElement;

async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(box(), text);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Let the send's awaits (git, ensureHost, createSession) run out. */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function pressEnter() {
  await act(async () => {
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle();
}

const createdSessions = () =>
  useChatSessionsStore.getState().sessions.filter((session) => !session.id.startsWith('known-'));
const notice = () => container.querySelector('[data-home-send-blocked]');
const buttonByText = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text
  );

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetComposerDraftsForTests();
  resetHomeDraftForTests();
  for (const fn of Object.values(mocks.api)) fn.mockClear();
  mocks.toast.mockClear();
  localStorage.clear();
  setStore([chat('known-1', { updatedAt: 5 })]);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the home page makes the conversation at send time', () => {
  it('asks for the first message, and picking a repository makes nothing', async () => {
    await mountComposer();
    expect(box().placeholder).toBe('Send a message…');
    await act(async () =>
      useHomeDraftStore.getState().setPick({ kind: 'path', path: '/repo/beta' })
    );
    expect(createdSessions()).toEqual([]);
    expect(useChatSessionsStore.getState().activeSessionId).toBeNull();
  });

  it('sends on the draft target, in the target directory', async () => {
    useHomeDraftStore.getState().setPick({ kind: 'path', path: '/repo/beta' });
    await mountComposer();
    await type('hello beta');
    await pressEnter();

    const [made] = createdSessions();
    expect(made?.workspaceId).toBe('ws-beta');
    expect(made?.projectId).toBe('p-beta');
    expect(useChatSessionsStore.getState().activeSessionId).toBe(made?.id);
    expect(mocks.api.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.api.createSession.mock.calls[0]?.[0]).toMatchObject({
      sessionId: made?.id,
      workspacePath: '/repo/beta',
    });
    // Never a scratch directory for a chat that has a repository.
    expect(mocks.api.ensureScratchWorkspace).not.toHaveBeenCalled();
    expect(mocks.api.checkout).not.toHaveBeenCalled();
  });

  it('by default sends on the most recently active repository', async () => {
    await mountComposer();
    await type('hello');
    await pressEnter();
    expect(createdSessions()[0]?.workspaceId).toBe('ws-alpha');
    expect(mocks.api.createSession.mock.calls[0]?.[0]).toMatchObject({
      workspacePath: '/repo/alpha',
    });
  });

  it('「不选仓库」 makes a temporary chat in its own private directory', async () => {
    useHomeDraftStore.getState().setPick({ kind: 'unbound' });
    await mountComposer();
    await type('scratch this');
    await pressEnter();

    const [made] = createdSessions();
    expect(made?.workspaceId).toBe('');
    expect(mocks.api.ensureScratchWorkspace).toHaveBeenCalledWith({ sessionId: made?.id });
    expect(mocks.api.createSession.mock.calls[0]?.[0]).toMatchObject({
      workspacePath: `/tmp/scratch/${made?.id}`,
    });
  });
});

describe('a branch picked on the home page is switched to at send time', () => {
  beforeEach(() => {
    useHomeDraftStore.getState().setPick({ kind: 'path', path: '/repo/alpha' });
    useHomeDraftStore
      .getState()
      .setBranch({ workdir: '/repo/alpha', name: 'feature/home', create: false });
  });

  it('checks it out first, then makes the conversation; the pick is spent', async () => {
    await mountComposer();
    await type('on the feature branch');
    await pressEnter();

    expect(mocks.api.checkout).toHaveBeenCalledWith('/repo/alpha', 'feature/home');
    expect(mocks.api.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.api.checkout.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.api.createSession.mock.invocationCallOrder[0] as number
    );
    expect(createdSessions()[0]?.workspaceId).toBe('ws-alpha');
    expect(useHomeDraftStore.getState().branch).toBeNull();
  });

  it('a branch picked through 「创建新分支...」 is created at send time', async () => {
    useHomeDraftStore
      .getState()
      .setBranch({ workdir: '/repo/alpha', name: 'feature/new', create: true });
    await mountComposer();
    await type('new branch please');
    await pressEnter();
    expect(mocks.api.createBranch).toHaveBeenCalledWith('/repo/alpha', 'feature/new');
    expect(mocks.api.checkout).not.toHaveBeenCalled();
  });

  it('a failed checkout is reported, the message stays, and nothing is made', async () => {
    mocks.api.checkout.mockRejectedValueOnce(new Error('local changes would be overwritten'));
    await mountComposer();
    await type('keep me');
    await pressEnter();

    expect(createdSessions()).toEqual([]);
    expect(mocks.api.createSession).not.toHaveBeenCalled();
    expect(useChatSessionsStore.getState().activeSessionId).toBeNull();
    expect(box().value).toBe('keep me');
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title: 'Could not switch to feature/home; the message was not sent',
        description: 'local changes would be overwritten',
      })
    );
    // The pick stands, for another try.
    expect(useHomeDraftStore.getState().branch?.name).toBe('feature/home');
  });

  describe('a conversation runs in that checkout by the time of the send', () => {
    beforeEach(() => {
      setStore([chat('known-1', { updatedAt: 5 }), chat('known-busy', { status: 'running' })]);
    });

    it('sends nothing, switches nothing, and asks', async () => {
      await mountComposer();
      await type('wait for it');
      await pressEnter();

      expect(mocks.api.checkout).not.toHaveBeenCalled();
      expect(mocks.api.createSession).not.toHaveBeenCalled();
      expect(createdSessions()).toEqual([]);
      expect(box().value).toBe('wait for it');
      expect(notice()?.textContent).toContain(
        'alpha has a chat running — it cannot switch to feature/home now'
      );
      expect(buttonByText('Send on main instead')).toBeDefined();
      expect(buttonByText('Cancel')).toBeDefined();
    });

    it('「改在 <当前分支> 上发送」 sends on the branch the checkout is on', async () => {
      await mountComposer();
      await type('fine, on main');
      await pressEnter();
      await act(async () => buttonByText('Send on main instead')?.click());
      await settle();

      expect(notice()).toBeNull();
      expect(mocks.api.checkout).not.toHaveBeenCalled();
      expect(useHomeDraftStore.getState().branch).toBeNull();
      expect(mocks.api.createSession).toHaveBeenCalledTimes(1);
      expect(mocks.api.createSession.mock.calls[0]?.[0]).toMatchObject({
        workspacePath: '/repo/alpha',
      });
    });

    it('「取消」 closes the notice and leaves the message in the box', async () => {
      await mountComposer();
      await type('later');
      await pressEnter();
      await act(async () => buttonByText('Cancel')?.click());

      expect(notice()).toBeNull();
      expect(box().value).toBe('later');
      expect(mocks.api.createSession).not.toHaveBeenCalled();
      expect(useHomeDraftStore.getState().branch?.name).toBe('feature/home');
    });

    it('without a picked branch the lock is no obstacle: it sends on the current branch', async () => {
      useHomeDraftStore.getState().setBranch(null);
      await mountComposer();
      await type('on main is fine');
      await pressEnter();
      expect(notice()).toBeNull();
      expect(mocks.api.createSession).toHaveBeenCalledTimes(1);
    });
  });
});

describe('the composer docks the same on the home page and in a conversation', () => {
  it('two resting lines on the home page, the same textarea class in a conversation', async () => {
    await mountComposer();
    const homeClass = box().parentElement?.className ?? '';
    expect(homeClass).toContain('[&_textarea]:min-h-[calc(var(--text-chat-body)*1.5*2)]');
    await act(async () => useChatSessionsStore.getState().selectSession('known-1'));
    expect(box().parentElement?.className).toBe(homeClass);
  });

  it('the send hands the same textarea — and the keyboard — to the new conversation', async () => {
    await mountComposer();
    const homeBox = box();
    await act(async () => homeBox.focus());
    await type('first message');
    await pressEnter();
    expect(createdSessions()).toHaveLength(1);
    // Not remounted: the home page and the conversation dock one composer.
    expect(box()).toBe(homeBox);
    expect(document.activeElement).toBe(homeBox);
  });
});
