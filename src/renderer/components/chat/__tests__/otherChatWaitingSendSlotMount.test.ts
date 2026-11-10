// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-09 report (Windows, 1.2.3): after the network dropped (a 502), a
 * message sent in chat B went into B's queue and only left it a while later;
 * ending a conversation from the sidebar let it through at once.
 *
 * Cause: the composer has ONE send slot for every chat, and chat A's
 * `runSend` held it while waiting for A's first assistant block. The
 * 2026-10-19 fix (`otherChatRetrySendSlotMount.test.ts`) frees it when the
 * engine reports an upstream retry, but a request that hangs with no retry
 * frame, or a slow first reply, kept it until the first block or the silence
 * ceiling, minutes later.
 *
 * Mounted in the real `ChatComposer` with the real queue release: once A's
 * turn is admitted (user echo) and B has a message queued for the slot, A's
 * wait hands the turn to the pending-reply watch, and B's queue releases.
 */

type SendInput = { sessionId: string; attemptId?: string; text: string };

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
import { createEmptyState, selectSessionQueue } from '../messageQueue';

let root: Root | undefined;
let container: HTMLDivElement;
let seq = 0;

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

function emit(event: Record<string, unknown>) {
  seq += 1;
  const full = { ...event, seq, timestamp: Date.now() } as unknown as RuntimeEvent;
  act(() => {
    for (const listener of [...mocks.listeners]) listener(full);
  });
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

async function sendInA(): Promise<SendInput> {
  await type('first question');
  await pressEnter();
  expect(mocks.api.send).toHaveBeenCalledTimes(1);
  const sent = mocks.api.send.mock.calls[0]?.[0] as SendInput;
  expect(sent.sessionId).toBe('a');
  return sent;
}

async function openChatB() {
  await act(async () => {
    useChatSessionsStore.setState({ activeSessionId: 'b' });
  });
  await settle();
}

const queuedTextsInB = () =>
  selectSessionQueue(useMessageQueueStore.getState().state, 'b').entries.map((entry) => entry.text);

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

describe('another chat waiting for its first reply does not hold the send slot (2026-11-09)', () => {
  it("releases chat B's queued message once A's turn is admitted, with no retry frame", async () => {
    await mountComposer();
    const sent = await sendInA();
    emit({
      type: 'message.started',
      sessionId: 'a',
      payload: { messageId: 'u-a', role: 'user', attemptId: sent.attemptId },
    });
    emit({ type: 'session.status', sessionId: 'a', payload: { status: 'running' } });
    await settle(20);
    // Nothing else waits for the slot yet: A keeps it, as before.
    expect(useTurnSendStatusStore.getState().pendingReplies.a).toBeUndefined();

    await openChatB();
    await type('已经连上了');
    await pressEnter();
    // The wait polls every 50ms, then B's queue release runs.
    await settle(20);

    expect(queuedTextsInB()).toEqual([]);
    expect(mocks.api.send).toHaveBeenCalledTimes(2);
    expect(mocks.api.send.mock.calls[1]?.[0]).toMatchObject({
      sessionId: 'b',
      text: '已经连上了',
    });
    // A's turn is still running: the turn head keeps it, and its Stop.
    expect(useTurnSendStatusStore.getState().pendingReplies.a?.sessionId).toBe('a');
    // End B's own wait (no echo came) before the environment goes.
    emit({ type: 'session.failed', sessionId: 'b', payload: { error: 'end of test' } });
    await settle();
  });

  it('keeps holding the slot for a turn the engine has not admitted', async () => {
    await mountComposer();
    await sendInA();
    emit({ type: 'session.status', sessionId: 'a', payload: { status: 'running' } });
    await settle(20);

    await openChatB();
    await type('已经连上了');
    await pressEnter();
    await settle(20);

    expect(mocks.api.send).toHaveBeenCalledTimes(1);
    expect(queuedTextsInB()).toEqual(['已经连上了']);
    // End A's wait before the environment goes.
    emit({ type: 'session.failed', sessionId: 'a', payload: { error: 'end of test' } });
    await settle();
  });
});
