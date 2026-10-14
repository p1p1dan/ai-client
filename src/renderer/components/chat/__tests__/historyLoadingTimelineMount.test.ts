// @vitest-environment happy-dom
/**
 * "Loading this conversation…" in the real `MessageTimeline`: the notice a
 * stored chat shows between the click and its transcript, in place of the
 * 「还没有消息」 copy a genuinely empty chat gets.
 *
 * The first version decided "answered" inside the timeline, from whether the
 * chat had a read cursor at all. A cursor outlives the read that wrote it, so
 * coming back to a chat read earlier in the run dropped the notice the moment
 * the timeline switched to it ([HLM-03]). Pinned here against the mounted
 * component, which does not remount between chats, not just the store.
 *
 * The `electronAPI` stub is hoisted: persisted stores rehydrate at import.
 */

import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { resetHistoryLoadingForTests, useHistoryLoadingStore } from '@/stores/historyLoading';
import { useLegacyMigrationStore } from '@/stores/legacyMigration';
import { usePendingUserMessagesStore } from '@/stores/pendingUserMessages';
import { useTurnSendStatusStore } from '@/stores/turnSendStatus';
import { MessageTimeline } from '../MessageTimeline';

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: { onRuntimeEvent: () => () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));
vi.mock('@/stores/settings', () => {
  const state = { showToolDiff: false };
  return {
    useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/stores/runtimeEventBus', () => ({ subscribeRuntimeEvent: () => () => undefined }));
vi.mock('../useResolvedSessionModel', () => ({ useResolvedSessionModel: () => () => 'glm/glm-5' }));
vi.mock('../sessionIndex/useResumeSession', () => ({
  useResumeSession: () => ({ resume: async () => false }),
}));

const LOADING = 'Loading this conversation…';
const EMPTY = 'No messages yet. Send a message to start.';

let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;

function timeline(sessionId: string) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(MessageTimeline, { sessionId, status: 'idle', thinkingEnabled: false })
  );
}

async function render(sessionId: string) {
  await act(async () => root?.render(timeline(sessionId)));
}

/** The click: `useActivateSession` selects the row, then announces the load. */
async function open(sessionId: string) {
  await act(async () => {
    useChatSessionsStore.getState().selectSession(sessionId);
    useHistoryLoadingStore.getState().begin(sessionId);
  });
  await render(sessionId);
}

/** What the `session.history` reducer writes for one answer. */
async function answer(sessionId: string, text: string | null) {
  await act(async () =>
    useChatSessionsStore.setState((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: text
          ? [
              {
                id: `h:${sessionId}`,
                sessionId,
                role: 'user',
                blocks: [{ id: 'b', type: 'text', text }],
              },
            ]
          : [],
      },
      historyPagination: {
        ...state.historyPagination,
        [sessionId]: { nextOffset: 1, hydratedCount: 1, totalCount: 1, hasMore: false },
      },
    }))
  );
}

const text = () => container.textContent ?? '';

function row(id: string) {
  return {
    id,
    projectId: 'p1',
    workspaceId: 'w1',
    title: id,
    status: 'idle' as const,
    updatedAt: 0,
    agent: 'dsh' as const,
    runtimeIdentity: `/sessions/${id}.jsonl`,
  };
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetHistoryLoadingForTests();
  useTurnSendStatusStore.setState({ status: null, baseline: null, pendingReply: null });
  usePendingUserMessagesStore.setState({ bySession: {} });
  useLegacyMigrationStore.setState({ migrating: {}, postureRevisions: {} });
  useChatSessionsStore.setState({
    activeSessionId: null,
    sessions: [row('s1'), row('s2')],
    messages: {},
    historyErrors: {},
    historyPagination: {},
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  });
  client = new QueryClient();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  resetHistoryLoadingForTests();
  vi.unstubAllGlobals();
});

describe('a stored chat loading, in the timeline', () => {
  it('[HLM-01] says loading until the transcript lands, then shows it', async () => {
    await open('s1');
    expect(text()).toContain(LOADING);
    expect(text()).not.toContain(EMPTY);
    await answer('s1', 'FIRST-QUESTION');
    expect(text()).not.toContain(LOADING);
    expect(text()).toContain('FIRST-QUESTION');
  });

  it('[HLM-02] a chat whose answer is empty ends on the empty copy, not the spinner', async () => {
    await open('s1');
    await answer('s1', null);
    expect(text()).not.toContain(LOADING);
    expect(text()).toContain(EMPTY);
  });

  it('[HLM-03] coming back to a chat read before says loading again', async () => {
    // Its earlier read left a cursor behind (removing the row keeps it, and an
    // archived chat comes back with an empty timeline), which the first version
    // took as this load's answer: 「还没有消息」 for the whole round trip.
    await open('s1');
    await answer('s1', 'FIRST-QUESTION');
    await open('s2');
    await answer('s2', 'SECOND-QUESTION');
    await act(async () =>
      useChatSessionsStore.setState((state) => ({ messages: { ...state.messages, s1: [] } }))
    );
    await open('s1');
    expect(text()).toContain(LOADING);
    expect(text()).not.toContain(EMPTY);
    await answer('s1', 'FIRST-QUESTION');
    expect(text()).not.toContain(LOADING);
  });

  it('[HLM-04] each chat ends on its own answer, whatever the chat being left showed', async () => {
    await open('s1');
    await answer('s1', 'FIRST-QUESTION');
    await open('s2');
    expect(text()).toContain(LOADING);
    await answer('s2', 'SECOND-QUESTION');
    expect(text()).not.toContain(LOADING);
    expect(text()).toContain('SECOND-QUESTION');
  });

  it('[HLM-05] a send in flight outranks the loading notice, as it does the empty copy', async () => {
    await open('s1');
    await act(async () =>
      useTurnSendStatusStore.setState({
        status: {
          owner: 1,
          sessionId: 's1',
          phase: 'handshake',
          elapsedSeconds: 0,
          turnStartedAtMs: Date.now(),
          budgetMs: 60_000,
          attachmentCount: 0,
          attachmentBytes: 0,
          promptChars: 5,
        },
      })
    );
    expect(text()).not.toContain(LOADING);
    expect(text()).not.toContain(EMPTY);
  });
});
