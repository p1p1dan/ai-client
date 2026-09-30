// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-7e (decision 140; decision 139's leftover): a LIVE turn keeps
 * its 「思考 N 秒」 when its timeline is mounted again, as its 「已工作」 does
 * since problem 16 (`timelineClockRemount.test.ts`).
 *
 * A live thought carries no dates of its own; its duration lived only in the
 * registry `useTurnTiming` held as component state, which came back empty
 * whenever the middle column had shown the start screen. It is now a store
 * held for the whole run by `ChatWorkspace`; here that hold is taken by hand.
 */

const { listeners } = vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: { onRuntimeEvent: () => () => undefined },
  } as unknown as typeof window.electronAPI;
  return { listeners: new Set<(event: unknown) => void>() };
});

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh, locale: 'zh' }) }));
vi.mock('@/stores/settings', () => {
  const state = { showToolDiff: false };
  return {
    useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/stores/runtimeEventBus', () => ({
  subscribeRuntimeEvent: (listener: (event: unknown) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));
vi.mock('../useResolvedSessionModel', () => ({ useResolvedSessionModel: () => () => undefined }));
vi.mock('../sessionIndex/useResumeSession', () => ({ useResumeSession: () => () => undefined }));

import { useChatSessionsStore } from '@/stores/chatSessions';
import {
  resetMessageMetadataRegistryForTests,
  useMessageMetadataStore,
} from '@/stores/messageMetadataRegistry';
import { resetTurnTimingRegistryForTests, useTurnTimingStore } from '@/stores/turnTimingRegistry';
import { MessageTimeline } from '../MessageTimeline';

const SENT_AT = Date.UTC(2026, 8, 30, 9, 0, 0);
const THOUGHT = zh('Thinking {{seconds}}s', { seconds: 7 });

/** A finished live turn that thought first: no `h:` ids, no dates. */
function liveTurn() {
  useChatSessionsStore.setState({
    activeSessionId: 's',
    sessions: [
      { id: 's', title: 's', projectId: 'p', workspaceId: 'w', status: 'idle', updatedAt: 0 },
    ],
    messages: {
      s: [
        {
          id: 'u1',
          sessionId: 's',
          role: 'user',
          blocks: [{ id: 'u1:t', type: 'text', text: '想一想' }],
        },
        {
          id: 'm1',
          sessionId: 's',
          role: 'assistant',
          blocks: [
            { id: 'm1:th', type: 'thinking', text: 'Let me think this through.' },
            { id: 'm1:t', type: 'text', text: '想好了' },
          ],
        },
      ],
    },
    historyErrors: {},
    lastError: null,
    pendingPermissions: [],
    pendingQuestions: [],
  } as never);
}

function emit(event: Record<string, unknown>) {
  for (const listener of [...listeners]) listener({ sessionId: 's', seq: 1, ...event });
}

async function mountTimeline() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient();
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageTimeline, { sessionId: 's', status: 'idle', thinkingEnabled: true })
      )
    )
  );
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const holds: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetMessageMetadataRegistryForTests();
  resetTurnTimingRegistryForTests();
  listeners.clear();
  liveTurn();
  // `ChatWorkspace`'s two run-long holds.
  holds.push(useMessageMetadataStore.getState().retain(() => undefined));
  holds.push(useTurnTimingStore.getState().retain());
});

afterEach(() => {
  for (const release of holds.splice(0)) release();
  resetMessageMetadataRegistryForTests();
  resetTurnTimingRegistryForTests();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function runTheTurn() {
  emit({ type: 'message.started', timestamp: SENT_AT, payload: { messageId: 'u1', role: 'user' } });
  emit({
    type: 'message.started',
    timestamp: SENT_AT + 1_000,
    payload: { messageId: 'm1', role: 'assistant' },
  });
  emit({
    type: 'thinking.started',
    timestamp: SENT_AT + 1_000,
    payload: { messageId: 'm1', blockId: 'm1:th' },
  });
  emit({
    type: 'thinking.completed',
    timestamp: SENT_AT + 8_000,
    payload: { messageId: 'm1', blockId: 'm1:th' },
  });
  emit({ type: 'message.completed', timestamp: SENT_AT + 9_000, payload: { messageId: 'm1' } });
}

it('[E2B-THOUGHT-REMOUNT] a remounted timeline still says how long the turn thought', async () => {
  const first = await mountTimeline();
  await act(async () => runTheTurn());
  expect(first.container.textContent).toContain(THOUGHT);
  // The start screen of a New chat: the timeline is gone for a while.
  await first.unmount();

  const again = await mountTimeline();
  try {
    expect(again.container.textContent).toContain(THOUGHT);
  } finally {
    await again.unmount();
  }
});

it('[E2B-THOUGHT-OFFSCREEN] a thought that ended while no timeline showed it is timed too', async () => {
  runTheTurn();
  const view = await mountTimeline();
  try {
    expect(view.container.textContent).toContain(THOUGHT);
  } finally {
    await view.unmount();
  }
});
