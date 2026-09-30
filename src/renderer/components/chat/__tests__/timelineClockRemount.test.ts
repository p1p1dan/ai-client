// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-7e (problem 16, decision 139): a LIVE turn keeps its
 * 「已工作 N 秒」 and 「完成于 HH:MM」 when its timeline is mounted again.
 *
 * A live message carries no date (the red-line store keeps none), so the
 * turn's clock is the metadata registry's alone — and the timeline unmounts
 * every time the middle column shows the start screen (New chat, which is also
 * how six new chats push one out of the pool). The registry used to be the
 * timeline's component state and came back empty. It is now a store held for
 * the whole run by `ChatWorkspace`; here the workspace's hold is taken by hand.
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
import { MessageTimeline } from '../MessageTimeline';
import { formatAbsoluteTime } from '../messageMetadata';

const SENT_AT = Date.UTC(2026, 8, 30, 9, 0, 0);
const DONE_AT = SENT_AT + 3_000;
const WORKED = zh('Worked for {{seconds}}s', { seconds: 3 });
const DONE = zh('Completed at {{time}}', { time: formatAbsoluteTime(DONE_AT) });

/** A finished live turn: no `h:` ids, no `timestamp`, exactly as the store keeps an echo. */
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
          blocks: [{ id: 'u1:t', type: 'text', text: '在吗' }],
        },
        {
          id: 'm1',
          sessionId: 's',
          role: 'assistant',
          blocks: [{ id: 'm1:t', type: 'text', text: '在' }],
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
        createElement(MessageTimeline, { sessionId: 's', status: 'idle', thinkingEnabled: false })
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

let releaseWorkspaceHold: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetMessageMetadataRegistryForTests();
  listeners.clear();
  liveTurn();
  releaseWorkspaceHold = useMessageMetadataStore.getState().retain(() => undefined);
});

afterEach(() => {
  releaseWorkspaceHold?.();
  releaseWorkspaceHold = null;
  resetMessageMetadataRegistryForTests();
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
  emit({ type: 'message.completed', timestamp: DONE_AT, payload: { messageId: 'm1' } });
}

it('[P7E-16-REMOUNT] a remounted timeline still says how long the turn took and when it ended', async () => {
  const first = await mountTimeline();
  await act(async () => runTheTurn());
  expect(first.container.textContent).toContain(WORKED);
  expect(first.container.textContent).toContain(DONE);
  // The start screen of a New chat: the timeline is gone for a while.
  await first.unmount();

  const again = await mountTimeline();
  try {
    expect(again.container.textContent).toContain(WORKED);
    expect(again.container.textContent).toContain(DONE);
  } finally {
    await again.unmount();
  }
});

it('[P7E-16-OFFSCREEN] a turn that ended while no timeline showed it has its clock too', async () => {
  // Nothing mounted: the user is on another chat's start screen.
  runTheTurn();
  const view = await mountTimeline();
  try {
    expect(view.container.textContent).toContain(WORKED);
    expect(view.container.textContent).toContain(DONE);
  } finally {
    await view.unmount();
  }
});
