// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-7e (problems 7 and 10, decision 140), on a reopened chat:
 *
 *  - a turn that failed before any reply ends on a note in the reader's
 *    language that says why — not on an English sentence drawn as the reply
 *    under 「最终输出」 with 「完成于」 beside it;
 *  - a `/compact` after a turn does not stretch that turn's 「已工作」: the
 *    summary row is dated when the summary was written.
 */

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: { onRuntimeEvent: () => () => undefined },
  } as unknown as typeof window.electronAPI;
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
vi.mock('@/stores/runtimeEventBus', () => ({ subscribeRuntimeEvent: () => () => undefined }));
vi.mock('../useResolvedSessionModel', () => ({ useResolvedSessionModel: () => () => undefined }));
vi.mock('../sessionIndex/useResumeSession', () => ({ useResumeSession: () => () => undefined }));

import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { MessageTimeline } from '../MessageTimeline';
import { formatAbsoluteTime } from '../messageMetadata';

const T0 = Date.UTC(2026, 8, 30, 9, 0, 0);

function seed(messages: ChatMessage[]) {
  useChatSessionsStore.setState({
    activeSessionId: 's',
    sessions: [
      { id: 's', title: 's', projectId: 'p', workspaceId: 'w', status: 'idle', updatedAt: 0 },
    ],
    messages: { s: messages },
    historyErrors: {},
    lastError: null,
    pendingPermissions: [],
    pendingQuestions: [],
  } as never);
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

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('[E2B-7-MOUNT] a failed turn reopens on a note that says why, with no reply and no completion time', async () => {
  // What `mapHistoryMessageToChatMessage` makes of the history's failed placeholder.
  seed([
    {
      id: 'h:u1',
      sessionId: 's',
      role: 'user',
      timestamp: T0,
      blocks: [{ id: 'h:u1:text:0', type: 'text', text: 'P1-FAIL: go' }],
    },
    {
      id: 'h:u1:end',
      sessionId: 's',
      role: 'system',
      timestamp: T0 + 2_000,
      incomplete: true,
      stopReason: 'error',
      turnEnd: {
        kind: 'failed',
        errorCode: 'PROVIDER_ERROR',
        error: 'P1-FAIL: the fake upstream failed this request',
      },
      blocks: [
        {
          id: 'h:u1:end:interrupted',
          type: 'text',
          text: 'This turn did not finish. No reply was saved.',
        },
      ],
    },
  ]);
  const view = await mountTimeline();
  try {
    const text = view.container.textContent ?? '';
    expect(text).toContain('这一轮没有完成：模型服务返回了错误，没有保存任何回复。');
    expect(text).toContain('P1-FAIL: the fake upstream failed this request');
    expect(view.container.querySelector('[data-testid="turn-end-notice"]')).not.toBeNull();
    // Not a reply: no 「最终输出」 divider, no English sentence, no 「完成于」.
    expect(text).not.toContain(zh('Final output'));
    expect(text).not.toContain('No reply was saved');
    expect(text).not.toContain('Response interrupted');
    expect(text).not.toContain(
      zh('Completed at {{time}}', { time: formatAbsoluteTime(T0 + 2_000) })
    );
  } finally {
    await view.unmount();
  }
});

it('[E2B-10-MOUNT] a compaction after a turn does not count toward that turn’s 「已工作」', async () => {
  seed([
    {
      id: 'h:u1',
      sessionId: 's',
      role: 'user',
      timestamp: T0,
      blocks: [{ id: 'h:u1:text:0', type: 'text', text: 'hello' }],
    },
    {
      id: 'h:a1',
      sessionId: 's',
      role: 'assistant',
      timestamp: T0 + 3_000,
      blocks: [{ id: 'h:a1:text:0', type: 'text', text: 'hi' }],
    },
    {
      id: 'h:c1',
      sessionId: 's',
      role: 'system',
      timestamp: T0 + 13_000,
      blocks: [
        {
          id: 'h:c1:summary:0',
          type: 'text',
          text: 'Context summary\n\n## Current Work\n- (none)',
        },
      ],
    },
  ]);
  const view = await mountTimeline();
  try {
    const text = view.container.textContent ?? '';
    expect(text).toContain(zh('Worked for {{seconds}}s', { seconds: 3 }));
    expect(text).not.toContain(zh('Worked for {{seconds}}s', { seconds: 13 }));
    expect(text).toContain(zh('Completed at {{time}}', { time: formatAbsoluteTime(T0 + 3_000) }));
    // The summary itself is still on the timeline, as the reopen shows it —
    // its title in the UI language since decision 144.
    expect(text).toContain(`${zh('Context summary')}\n\n## Current Work`);
    expect(text).not.toContain('Context summary');
  } finally {
    await view.unmount();
  }
});

it('[E2B-7-MOUNT-AFTER-WORK] a turn that failed after saving steps does not claim nothing was saved', async () => {
  seed([
    {
      id: 'h:u1',
      sessionId: 's',
      role: 'user',
      timestamp: T0,
      blocks: [{ id: 'h:u1:text:0', type: 'text', text: 'P1-FAIL after a step' }],
    },
    {
      id: 'h:a1',
      sessionId: 's',
      role: 'assistant',
      timestamp: T0 + 1_000,
      blocks: [{ id: 'h:a1:text:0', type: 'text', text: 'Reading the file first.' }],
    },
    {
      id: 'h:u1:end',
      sessionId: 's',
      role: 'system',
      timestamp: T0 + 2_000,
      incomplete: true,
      stopReason: 'error',
      turnEnd: { kind: 'failed', errorCode: 'PROVIDER_ERROR', error: 'P1-FAIL: upstream' },
      blocks: [
        {
          id: 'h:u1:end:interrupted',
          type: 'text',
          text: 'This turn did not finish. No reply was saved.',
        },
      ],
    },
  ]);
  const view = await mountTimeline();
  try {
    const text = view.container.textContent ?? '';
    expect(text).toContain('Reading the file first.');
    expect(text).toContain('这一轮没有完成：模型服务返回了错误。');
    expect(text).not.toContain('没有保存任何回复');
    // Still no completion time: the turn did not complete.
    expect(text).not.toContain(
      zh('Completed at {{time}}', { time: formatAbsoluteTime(T0 + 1_000) })
    );
  } finally {
    await view.unmount();
  }
});
