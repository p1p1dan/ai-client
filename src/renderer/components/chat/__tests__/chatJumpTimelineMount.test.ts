// @vitest-environment happy-dom
/**
 * Chat search (stage 4), mounted in the real `MessageTimeline`: every user
 * message and assistant text carries a `data-message-id` anchor, and a jump
 * request for this chat marks its message and shows the find bar.
 *
 * The `electronAPI` stub is hoisted: persisted stores rehydrate at import.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: { onRuntimeEvent: () => () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/stores/settings', () => {
  const state = { showToolDiff: false };
  return {
    useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/stores/runtimeEventBus', () => ({ subscribeRuntimeEvent: () => () => undefined }));
vi.mock('../useResolvedSessionModel', () => ({ useResolvedSessionModel: () => () => undefined }));
vi.mock('../sessionIndex/useResumeSession', () => ({ useResumeSession: () => () => undefined }));

import { useChatJumpStore } from '@/stores/chatJump';
import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { MessageTimeline } from '../MessageTimeline';

let root: Root | undefined;
let container: HTMLDivElement;

const messages: ChatMessage[] = [
  {
    id: 'h:u1',
    sessionId: 's1',
    role: 'user',
    blocks: [{ id: 'u1:t', type: 'text', text: '帮我看一下 8GE21E15 的良率' }],
  },
  {
    id: 'h:a1',
    sessionId: 's1',
    role: 'assistant',
    blocks: [{ id: 'a1:t', type: 'text', text: '8GE21E15 在第 3 站失败最多。' }],
  },
];

async function render() {
  useChatSessionsStore.setState({
    activeSessionId: 's1',
    sessions: [
      { id: 's1', projectId: 'p1', workspaceId: 'w1', title: 's1', status: 'idle', updatedAt: 0 },
    ],
    messages: { s1: messages },
    historyPagination: { s1: { nextOffset: 2, hydratedCount: 2, totalCount: 2, hasMore: false } },
    historyErrors: {},
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  } as never);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient();
  await act(async () =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageTimeline, { sessionId: 's1', status: 'idle', thinkingEnabled: false })
      )
    )
  );
}

const anchor = (id: string) => container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useChatJumpStore.setState({ request: null, lastSeq: 0 });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('chat search in the timeline', () => {
  it('anchors every user message and assistant text by its message id', async () => {
    await render();
    expect(anchor('h:u1')?.tagName).toBe('ARTICLE');
    expect(anchor('h:a1')?.textContent).toContain('第 3 站');
    expect(container.querySelector('[data-chat-find-bar]')).toBeNull();
  });

  it('marks the requested message and shows the find bar over this chat', async () => {
    await render();
    await act(async () =>
      useChatJumpStore
        .getState()
        .requestJump({ sessionId: 's1', query: '8GE21E15', messageKeys: ['h:u1', 'h:a1'] })
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(anchor('h:u1')?.hasAttribute('data-located')).toBe(true);
    const bar = container.querySelector('[data-chat-find-bar]');
    expect(bar?.textContent).toContain('8GE21E15');
    expect(bar?.textContent).toContain('1 / 2');
  });
});
