// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 2026-10-19 report (Windows, 1.1.1-test.1): chat A's turn was in an upstream
 * retry loop (the "next attempt in Ns" countdown) when the user opened a new
 * chat B and sent its first message. The message went into B's queue and
 * never left it.
 *
 * Cause: the composer has ONE send slot for every chat, and A's `runSend`
 * held it while waiting for A's first assistant block. Each retry frame is
 * liveness, so the silence budget never ran out and the slot stayed held for
 * up to the 30-minute loop bound — B's send was queued behind it, and B's
 * queue release waits on the same slot.
 *
 * Mounted in the real `ChatComposer`: once A's turn is admitted (user echo)
 * and the engine reports a retry, A's wait hands the turn to the pending-reply
 * watch and frees the slot, so B's Enter is a send, not an enqueue.
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

const retryFrame = {
  attempt: 1,
  maxRetries: 10,
  delayMs: 30_000,
  errorStatus: 529,
  error: 'overloaded',
};

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

describe('another chat retrying upstream does not hold the send slot (2026-10-19)', () => {
  it("sends a new chat's first message instead of queueing it", async () => {
    await mountComposer();
    const sent = await sendInA();
    emit({
      type: 'message.started',
      sessionId: 'a',
      payload: { messageId: 'u-a', role: 'user', attemptId: sent.attemptId },
    });
    emit({
      type: 'session.status',
      sessionId: 'a',
      payload: { status: 'running', retry: retryFrame },
    });
    // The wait polls every 50ms.
    await settle(20);

    await openChatB();
    await type('你好');
    await pressEnter();

    expect(queuedTextsInB()).toEqual([]);
    expect(mocks.api.send).toHaveBeenCalledTimes(2);
    expect(mocks.api.send.mock.calls[1]?.[0]).toMatchObject({ sessionId: 'b', text: '你好' });
    // A's turn is still running: the turn head keeps it (and its Stop), and
    // B's send does not take A's watch away.
    expect(useTurnSendStatusStore.getState().pendingReplies.a?.sessionId).toBe('a');
  });

  // Decision 205 follow-up: B, handed off in the same outage, used to take
  // A's watch (one slot for the app): A's turn head went, and A's later
  // failure gave its input back to nobody.
  it("keeps A's watch when B is handed off too, and A's failure gives A's input back", async () => {
    await mountComposer();
    const sent = await sendInA();
    emit({
      type: 'message.started',
      sessionId: 'a',
      payload: { messageId: 'u-a', role: 'user', attemptId: sent.attemptId },
    });
    emit({
      type: 'session.status',
      sessionId: 'a',
      payload: { status: 'running', retry: retryFrame },
    });
    await settle(20);

    await openChatB();
    await type('你好');
    await pressEnter();
    const sentB = mocks.api.send.mock.calls[1]?.[0] as SendInput;
    emit({
      type: 'message.started',
      sessionId: 'b',
      payload: { messageId: 'u-b', role: 'user', attemptId: sentB.attemptId },
    });
    emit({
      type: 'session.status',
      sessionId: 'b',
      payload: { status: 'running', retry: retryFrame },
    });
    await settle(20);

    expect(Object.keys(useTurnSendStatusStore.getState().pendingReplies).sort()).toEqual([
      'a',
      'b',
    ]);

    emit({ type: 'session.failed', sessionId: 'a', payload: { error: 'upstream 500' } });
    await settle();
    expect(Object.keys(useTurnSendStatusStore.getState().pendingReplies)).toEqual(['b']);

    await act(async () => {
      useChatSessionsStore.setState({ activeSessionId: 'a' });
    });
    await settle();
    expect(box().value).toBe('first question');
  });

  it('keeps holding the slot for a turn the engine has not admitted', async () => {
    await mountComposer();
    await sendInA();
    // A retry frame with no echo: the Host may still refuse this turn.
    emit({
      type: 'session.status',
      sessionId: 'a',
      payload: { status: 'running', retry: retryFrame },
    });
    await settle(20);

    await openChatB();
    await type('你好');
    await pressEnter();

    expect(mocks.api.send).toHaveBeenCalledTimes(1);
    expect(queuedTextsInB()).toEqual(['你好']);
  });
});
