// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Decision 203 made Enter while a turn runs an interjection. An engine command
 * (DSH `/goal`, a skill, a CLI command) runs only as a send: steered into the
 * turn, the worker hands it to the model as plain text and nothing runs. Such
 * a line still queues for the turn's end, as Enter did before 203; plain text
 * is interjected.
 */

const mocks = vi.hoisted(() => {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const api = {
    ensureHost: vi.fn(async () => undefined),
    send: vi.fn(async (input: { sessionId: string }) => ({ requestId: `req-${input.sessionId}` })),
    interject: vi.fn(async (_input: { sessionId: string; text: string }) => ({
      interjected: true,
    })),
    // A Stop that has not settled yet.
    stop: vi.fn(() => new Promise<void>(() => undefined)),
  };
  window.electronAPI = {
    env: { platform: 'linux', HOME: '/home/test' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: {
      onRuntimeEvent: () => () => undefined,
      getSlashCommands: async () => ({
        commands: [{ name: 'goal', source: 'command', description: 'Set or view the goal' }],
        truncated: false,
      }),
      getHostStatus: async () => ({ state: 'ready' }),
      ensureHost: api.ensureHost,
      send: api.send,
      interject: api.interject,
      stop: api.stop,
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

import { useChatSessionsStore } from '@/stores/chatSessions';
import { resetComposerDraftsForTests } from '@/stores/composerDrafts';
import { useMessageQueueStore } from '@/stores/messageQueue';
import { useTurnSendStatusStore } from '@/stores/turnSendStatus';
import { ChatComposer } from '../ChatComposer';
import { createEmptyState, selectSessionQueue } from '../messageQueue';

let root: Root | undefined;
let container: HTMLDivElement;

function setStore() {
  useChatSessionsStore.setState({
    activeSessionId: 'a',
    sessions: [
      { id: 'a', projectId: 'p', workspaceId: 'w', title: 'a', status: 'running', updatedAt: 1 },
      { id: 'b', projectId: 'p', workspaceId: 'w', title: 'b', status: 'running', updatedAt: 1 },
    ],
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

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(box(), text);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
  // The slash catalog loads once the draft starts with `/`.
  await settle();
}

async function pressEnter() {
  await act(async () => {
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle();
}

const queuedTexts = () =>
  selectSessionQueue(useMessageQueueStore.getState().state, 'a').entries.map((entry) => entry.text);

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

describe('Enter while a turn runs (decision 203)', () => {
  it('interjects plain text into the running turn', async () => {
    await mountComposer();
    await type('also check the tests');
    await pressEnter();

    expect(mocks.api.interject).toHaveBeenCalledTimes(1);
    expect(mocks.api.interject.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'a',
      text: 'also check the tests',
    });
    expect(queuedTexts()).toEqual([]);
  });

  it('queues an engine command instead of steering it in as text', async () => {
    await mountComposer();
    await type('/goal ship the release');
    await pressEnter();

    expect(mocks.api.interject).not.toHaveBeenCalled();
    expect(mocks.api.send).not.toHaveBeenCalled();
    expect(queuedTexts()).toEqual(['/goal ship the release']);
  });

  it("interjects while another chat's Stop is still settling", async () => {
    await mountComposer();
    await act(async () => {
      useChatSessionsStore.setState({ activeSessionId: 'b' });
    });
    await settle();
    await act(async () => {
      box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(mocks.api.stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      useChatSessionsStore.setState({ activeSessionId: 'a' });
    });
    await settle();
    await type('note for a');
    await pressEnter();

    expect(mocks.api.interject).toHaveBeenCalledTimes(1);
    expect(mocks.api.interject.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'a' });
    expect(queuedTexts()).toEqual([]);
  });
});
