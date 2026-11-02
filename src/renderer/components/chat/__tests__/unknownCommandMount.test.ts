// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PiLab R2 (user ruling 2026-10-30): a draft that starts like a command the
 * engine does not have (`/reveiw`) is not sent as prose at once: one line
 * says so, and the same draft sent again — Enter or 「仍然发送」 — goes out.
 */

const mocks = vi.hoisted(() => {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const api = {
    ensureHost: vi.fn(async () => undefined),
    send: vi.fn(async (input: { sessionId: string }) => ({ requestId: `req-${input.sessionId}` })),
  };
  window.electronAPI = {
    env: { platform: 'linux', HOME: '/home/test' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: {
      onRuntimeEvent: () => () => undefined,
      getSlashCommands: async () => ({ commands: [], truncated: false }),
      getHostStatus: async () => ({ state: 'ready' }),
      ensureHost: api.ensureHost,
      send: api.send,
    },
  } as unknown as typeof window.electronAPI;
  return { api, listeners, toast: vi.fn() };
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
vi.mock('@/stores/runtimeEventBus', () => ({
  subscribeRuntimeEvent: (listener: (event: RuntimeEvent) => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));
// The target row carries the composer's bar controls at its two ends.
vi.mock('../ComposerTargetBar', () => ({
  ComposerTargetBar: (props: {
    leading?: import('react').ReactNode;
    trailing?: import('react').ReactNode;
  }) => [props.leading, props.trailing],
}));
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
import { useMessageQueueStore } from '@/stores/messageQueue';
import { useTurnSendStatusStore } from '@/stores/turnSendStatus';
import { ChatComposer } from '../ChatComposer';
import { createEmptyState } from '../messageQueue';

let root: Root | undefined;
let container: HTMLDivElement;

function chat(id: string): ChatSession {
  return { id, projectId: 'p', workspaceId: 'w', title: id, status: 'idle', updatedAt: 1 };
}

function setStore() {
  useChatSessionsStore.setState({
    activeSessionId: 'a',
    sessions: [chat('a'), chat('b')],
    projects: [{ id: 'p', name: 'repo' }],
    workspaces: [{ id: 'w', projectId: 'p', name: 'Main', kind: 'main', path: '/repo' }],
    messages: {},
    hostBoundSessionIds: ['a', 'b'],
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

async function settle(ms = 0) {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
}

async function pressEnter() {
  await act(async () => {
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetComposerDraftsForTests();
  for (const fn of Object.values(mocks.api)) fn.mockClear();
  mocks.listeners.clear();
  mocks.toast.mockClear();
  localStorage.clear();
  useMessageQueueStore.setState({ state: createEmptyState() });
  useTurnSendStatusStore.setState({ status: null, pendingReplies: {} });
  setStore();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('[PILAB-R2-UNKNOWN-CMD] a slip of a command asks before going out', () => {
  it('holds the first Enter, sends on the second', async () => {
    await mountComposer();
    await type('/reveiw look at this');
    await settle();
    await pressEnter();
    expect(mocks.api.send).not.toHaveBeenCalled();
    expect(container.textContent).toContain('There is no /reveiw command.');
    expect(box().value).toBe('/reveiw look at this');

    await pressEnter();
    expect(mocks.api.send).toHaveBeenCalledTimes(1);
    expect(mocks.api.send.mock.calls[0]?.[0]).toMatchObject({ text: '/reveiw look at this' });
  });

  it('sends at once from "Send anyway"', async () => {
    await mountComposer();
    await type('/xyz');
    await settle();
    await pressEnter();
    const button = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === 'Send anyway'
    );
    await act(async () => button?.click());
    await settle();
    expect(mocks.api.send).toHaveBeenCalledTimes(1);
  });

  it('never takes a path for a command', async () => {
    await mountComposer();
    await type('/home/pi/a.txt what is this');
    await settle();
    await pressEnter();
    expect(mocks.api.send).toHaveBeenCalledTimes(1);
  });

  it('editing the draft retires the notice', async () => {
    await mountComposer();
    await type('/xyz');
    await settle();
    await pressEnter();
    expect(container.textContent).toContain('There is no /xyz command.');
    await type('/xyz2');
    expect(container.textContent).not.toContain('There is no /xyz command.');
  });
});
