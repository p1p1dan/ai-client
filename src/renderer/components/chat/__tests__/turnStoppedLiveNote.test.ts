// @vitest-environment happy-dom
/**
 * dsh-rebase decision 146 (GW-18), rendered: a turn cut off before any of its
 * reply arrived — signed out mid-request (Main's `forced` stop, then
 * `released`), or stopped by the user before the first byte.
 *
 * In the real-gateway pass the timeline froze on 「已工作 1 秒」 with no note,
 * and kept it after switching chats and back: a chat whose timeline is in
 * memory is not re-read (T092), and only a replay used to write the note
 * (decision 140). The live store now writes the same note, so the turn ends
 * on 「这一轮已停止，没有保存任何回复。」 at once, says no 「完成于」, and
 * reads the same after a remount.
 */

import { translate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyRuntimeEvent, useChatSessionsStore } from '@/stores/chatSessions';
import { useTurnSendStatusStore } from '@/stores/turnSendStatus';
import { MessageTimeline } from '../MessageTimeline';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/utils/logging', () => ({ updateRendererLogging: () => {} }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));
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

const STEP_1 = 'dsh-aiclient-s1-t1-s1';

let seq = 0;
function push(type: string, payload: Record<string, unknown>) {
  seq += 1;
  const stamped = {
    type,
    sessionId: 's1',
    requestId: 'send-1',
    seq,
    timestamp: 1_790_000_000_000 + seq * 500,
    payload,
  } as RuntimeEvent;
  useChatSessionsStore.setState((state) => ({
    ...state,
    ...applyRuntimeEvent(useChatSessionsStore.getState(), stamped),
  }));
}

let root: Root | undefined;
let container: HTMLDivElement;

async function render(): Promise<HTMLElement> {
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
          status: 'disconnected',
          thinkingEnabled: false,
        })
      )
    )
  );
  return container;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useTurnSendStatusStore.setState({ status: null });
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
    messages: { s1: [] },
    hostBoundSessionIds: ['s1'],
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  });
  // The request went out; the bridge opened its (still empty) reply; sign-out cut it.
  push('message.started', { messageId: 'dsh-user-3', role: 'user' });
  push('message.delta', {
    messageId: 'dsh-user-3',
    blockId: 'dsh-user-3-text',
    text: '三句话说明中位数',
  });
  push('message.started', { messageId: STEP_1, role: 'assistant' });
  push('session.stopped', { stopCause: 'forced' });
  push('session.status', { status: 'disconnected', disconnectReason: 'released' });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('[GW18-DOM] the cut turn ends on the stopped note, with no completion time, and keeps it after a remount', async () => {
  const view = await render();
  const text = view.textContent ?? '';
  expect(text).toContain('这一轮已停止，没有保存任何回复。');
  // Not a reply: the English fallback sentence never shows.
  expect(text).not.toContain('This turn was stopped');
  expect(text).not.toContain('完成于');

  // Switching chats and back remounts the timeline over the same store.
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  const again = await render();
  expect(again.textContent ?? '').toContain('这一轮已停止，没有保存任何回复。');
});
