// @vitest-environment happy-dom
/**
 * dsh-rebase P1-7a (decisions 072, 093, 106 rule 36, 111 rule 12, 118): the
 * rows a DSH timeline adds, mounted in the real `MessageTimeline`:
 *
 * - a goal round's first message is a light head (「目标 · 第 3/256 轮」 and a
 *   rule), not the empty user bubble decision 106 rule 36 accepted until now;
 *   the prompt rail does not list it;
 * - a background task's notice is one light line, not an Alert;
 * - a Ctrl+Enter message the turn has not taken in yet is a dashed bubble that
 *   says it is awaiting delivery, with a clock rather than a spinner.
 *
 * The `electronAPI` stub is hoisted: persisted stores rehydrate at import.
 */

import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
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
vi.mock('../useResolvedSessionModel', () => ({ useResolvedSessionModel: () => () => undefined }));
vi.mock('../sessionIndex/useResumeSession', () => ({ useResumeSession: () => () => undefined }));

let root: Root | undefined;
let container: HTMLDivElement;

async function render() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient();
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

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useTurnSendStatusStore.setState({ status: null });
  usePendingUserMessagesStore.setState({ bySession: {} });
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
      },
    ],
    messages: {
      s1: [
        {
          id: 'dsh-user-1',
          sessionId: 's1',
          role: 'user',
          blocks: [{ id: 'u', type: 'text', text: 'SET-A-GOAL' }],
        },
        {
          id: 'asst-1',
          sessionId: 's1',
          role: 'assistant',
          blocks: [{ id: 'a', type: 'text', text: 'Goal set.' }],
        },
        {
          id: 'dsh-user-9',
          sessionId: 's1',
          role: 'user',
          blocks: [],
          origin: { kind: 'goal', round: 3, maxRounds: 256 },
        },
        {
          id: 'asst-2',
          sessionId: 's1',
          role: 'assistant',
          blocks: [{ id: 'b', type: 'text', text: 'Round three.' }],
        },
        {
          id: 'dsh-notice-12',
          sessionId: 's1',
          role: 'system',
          noticeKind: 'tool-jobs',
          blocks: [{ id: 'n', type: 'text', text: 'background job bash-3 finished' }],
        },
      ],
    },
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('DSH timeline rows (P1-7a)', () => {
  it('[P7A-MOUNT-HEAD] a goal round opens with a light head, not a bubble; the rail skips it', async () => {
    await render();
    const heads = [...container.querySelectorAll('[data-testid="auto-turn-head"]')];
    expect(heads).toHaveLength(1);
    expect(heads[0]?.getAttribute('data-origin')).toBe('goal');
    expect(heads[0]?.textContent).toContain('Goal · round 3/256');
    // Only the typed prompt is a bubble.
    const bubbles = [...container.querySelectorAll('article')].filter((article) =>
      article.className.includes('justify-end')
    );
    expect(bubbles.map((bubble) => bubble.textContent)).toEqual(['SET-A-GOAL']);
    // The head still opens its own turn.
    expect(container.querySelectorAll('[data-turn-id]')).toHaveLength(2);
  });

  it('[P7A-MOUNT-NOTICE] a DSH notice is one light line, not an Alert', async () => {
    await render();
    const row = container.querySelector('[data-testid="dsh-notice-row"]');
    expect(row?.getAttribute('data-kind')).toBe('notice');
    expect(row?.textContent).toBe('background job bash-3 finished');
    expect(row?.closest('[role="status"]')).toBeNull();
  });

  it('[P7A-MOUNT-AWAITING] a Ctrl+Enter message not yet taken in: dashed, "Awaiting delivery", no spinner', async () => {
    usePendingUserMessagesStore.getState().publish({
      attemptId: 'steer-1',
      sessionId: 's1',
      text: 'ALSO-CHECK-LINT',
      attachments: [],
      startedAt: 1,
      awaitingDelivery: true,
    });
    await render();
    const awaiting = container.querySelector('[data-awaiting-delivery="true"]');
    expect(awaiting?.textContent).toContain('ALSO-CHECK-LINT');
    expect(awaiting?.textContent).toContain('Awaiting delivery');
    expect(awaiting?.querySelector('.border-dashed')).not.toBeNull();
    expect(awaiting?.querySelector('[data-slot="spinner"], .animate-spin')).toBeNull();
  });
});
