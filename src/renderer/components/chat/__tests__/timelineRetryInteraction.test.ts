// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock('@/stores/settings', () => {
  const state = { showToolDiff: false };
  return {
    useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/stores/runtimeEventBus', () => ({ subscribeRuntimeEvent: () => () => undefined }));
vi.mock('../useResolvedSessionModel', () => {
  const resolve = () => undefined;
  return { useResolvedSessionModel: () => resolve };
});
vi.mock('../sessionIndex/useResumeSession', () => ({ useResumeSession: () => () => undefined }));
vi.mock('../SessionTreeDialog', () => ({ SessionTreeDialog: () => null }));

import { useChatSessionsStore } from '@/stores/chatSessions';
import { MessageTimeline } from '../MessageTimeline';

it('renders retry after the long output and preserves a reader scrolled upward', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const retry = { attempt: 2, maxRetries: 3, delayMs: 1000, error: 'upstream', errorStatus: '529' };
  useChatSessionsStore.setState({
    activeSessionId: 's',
    sessions: [
      {
        id: 's',
        title: 's',
        projectId: 'p',
        workspaceId: 'w',
        status: 'running',
        updatedAt: 0,
        retry,
        activity: { phase: 'retry', since: Date.now(), retry },
      },
    ],
    messages: {
      s: [
        {
          id: 'u',
          sessionId: 's',
          role: 'user',
          blocks: [{ id: 'ut', type: 'text', text: 'Prompt' }],
        },
        {
          id: 'a',
          sessionId: 's',
          role: 'assistant',
          blocks: [{ id: 'at', type: 'text', text: `${'Long answer\n\n'.repeat(60)}THE_END` }],
        },
      ],
    },
    lastError: null,
    pendingPermissions: [],
    pendingQuestion: null,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient();
  try {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(MessageTimeline, {
            sessionId: 's',
            status: 'running',
            thinkingEnabled: false,
          })
        )
      )
    );
    expect(container.textContent!.indexOf('THE_END')).toBeLessThan(
      container.textContent!.indexOf('Upstream error 529')
    );
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => 3000 },
      clientHeight: { configurable: true, get: () => 300 },
    });
    await act(async () => {
      viewport.scrollTop = 200;
      viewport.dispatchEvent(new Event('scroll'));
      viewport.dispatchEvent(new Event('scroll'));
    });
    await act(async () => {
      useChatSessionsStore.setState((s) => ({
        messages: {
          ...s.messages,
          s: s.messages.s.map((message) =>
            message.id === 'a'
              ? {
                  ...message,
                  blocks: [{ id: 'at', type: 'text', text: 'continued '.repeat(1500) }],
                }
              : message
          ),
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(viewport.scrollTop).toBe(200);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    vi.unstubAllGlobals();
  }
});
