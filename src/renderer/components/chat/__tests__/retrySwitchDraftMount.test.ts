// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PiLab R2 (03.7): a send rejected before the engine took it clears the box
 * and arms a Retry holding the message. Leaving the chat used to drop that
 * Retry, and the message with it: coming back showed an empty box and nothing
 * in the timeline. The message now goes back to the chat's own draft.
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

async function openChat(id: string) {
  await act(async () => {
    useChatSessionsStore.setState({ activeSessionId: id });
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

describe('[PILAB-R2-RETRY-SWITCH] an unclicked Retry survives leaving the chat', () => {
  it('gives the failed message back to its chat, never to the other one', async () => {
    mocks.api.send.mockRejectedValueOnce(new Error('the host refused the send'));
    await mountComposer();
    await type('first question');
    await pressEnter();
    expect(mocks.api.send).toHaveBeenCalledTimes(1);
    expect(box().value).toBe('');

    await openChat('b');
    expect(box().value).toBe('');
    await openChat('a');
    expect(box().value).toBe('first question');
  });
});
