// @vitest-environment happy-dom
/**
 * S-6 feedback 11c (user, 2026-10-17): right after a send, while it is still
 * connecting to the engine, the turn shows ONE line — the clock with the
 * handshake as its clause (「✻ 工作中 1 秒 · 正在连接对话引擎…」). Before, the
 * clock line and a handshake status row under it both counted the same seconds
 * (「✻ 工作中 2 秒」 over 「正在连接对话引擎… · 2s」).
 *
 * The `electronAPI` stub is hoisted: persisted stores rehydrate at import.
 */

import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { resetHistoryLoadingForTests } from '@/stores/historyLoading';
import { useLegacyMigrationStore } from '@/stores/legacyMigration';
import { usePendingUserMessagesStore } from '@/stores/pendingUserMessages';
import { type OwnedTurnSendStatus, useTurnSendStatusStore } from '@/stores/turnSendStatus';
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

const CONNECTING = 'Connecting to the chat engine…';

let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;

function sendStatus(phase: OwnedTurnSendStatus['phase']): OwnedTurnSendStatus {
  return {
    owner: 1,
    sessionId: 's1',
    phase,
    elapsedSeconds: 2,
    turnStartedAtMs: Date.now() - 2_000,
    budgetMs: 60_000,
    attachmentCount: 0,
    attachmentBytes: 0,
    promptChars: 5,
  };
}

/** The send's echo has landed: the turn exists, with nothing in its body yet. */
async function sent(phase: OwnedTurnSendStatus['phase']) {
  await act(async () => {
    useChatSessionsStore.setState((state) => ({
      messages: {
        ...state.messages,
        s1: [
          {
            id: 'u1',
            sessionId: 's1',
            role: 'user',
            blocks: [{ id: 'b', type: 'text', text: 'hi' }],
          },
        ],
      },
    }));
    useTurnSendStatusStore.setState({
      status: sendStatus(phase),
      baseline: { sessionId: 's1', messageId: null },
    });
  });
  await act(async () =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageTimeline, {
          sessionId: 's1',
          status: 'running',
          thinkingEnabled: false,
        })
      )
    )
  );
}

const text = () => container.textContent ?? '';
const count = (needle: string) => text().split(needle).length - 1;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetHistoryLoadingForTests();
  useTurnSendStatusStore.setState({ status: null, baseline: null, pendingReply: null });
  usePendingUserMessagesStore.setState({ bySession: {} });
  useLegacyMigrationStore.setState({ migrating: {}, postureRevisions: {} });
  useChatSessionsStore.setState({
    activeSessionId: 's1',
    sessions: [
      {
        id: 's1',
        projectId: 'p1',
        workspaceId: 'w1',
        title: 's1',
        status: 'running',
        updatedAt: 0,
        agent: 'dsh',
        runtimeIdentity: '/sessions/s1.jsonl',
      },
    ],
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

describe('a send still connecting, in the timeline', () => {
  it('[THS-01] the clock line carries the handshake; no second row counts the seconds', async () => {
    await sent('handshake');
    const lines = [...container.querySelectorAll('span[title]')]
      .map((node) => node.getAttribute('title') ?? '')
      .filter((title) => title.includes(CONNECTING));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^✻ Working \d+s · Connecting to the chat engine…$/);
    expect(count(CONNECTING)).toBe(1);
    expect(text()).not.toContain(`${CONNECTING} · `);
  });

  it('[THS-02] once connected the clause goes and the clock line stays', async () => {
    await sent('awaiting');
    expect(text()).not.toContain(CONNECTING);
    expect(text()).toMatch(/✻ Working \d+s/);
  });
});
