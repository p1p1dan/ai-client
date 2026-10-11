// @vitest-environment happy-dom
/**
 * dsh-rebase decision 180, mounted in the real `MessageTimeline`: a `/compact`
 * the user ran shows as an automatic compaction does — its command line,
 * drawn as the user's own line (but no prompt: it opens no turn), then its
 * row: running with its clock and the way to cancel it while this window runs
 * it, then a note saying why there is no summary, in the reader's language.
 *
 * The `electronAPI` stub is hoisted: persisted stores rehydrate at import.
 */

import { translate } from '@shared/i18n';
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

import { DSH_COMPACT_FAILED_REASON_KEY } from '@shared/dshHistory/types';
import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { useCompactRunsStore } from '@/stores/compactRuns';
import {
  compactCommandRow,
  compactNoteRow,
  compactRunningRow,
} from '@/stores/manualCompactionRows';
import { MessageTimeline } from '../MessageTimeline';

let root: Root | undefined;
let container: HTMLDivElement;

const turn: ChatMessage[] = [
  {
    id: 'u1',
    sessionId: 's1',
    role: 'user',
    blocks: [{ id: 'u1:t', type: 'text', text: '先做第一步' }],
  },
  {
    id: 'a1',
    sessionId: 's1',
    role: 'assistant',
    blocks: [{ id: 'a1:t', type: 'text', text: '第一步做完了。' }],
  },
];

function setTimeline(rows: ChatMessage[]) {
  useChatSessionsStore.setState({
    activeSessionId: 's1',
    sessions: [
      { id: 's1', projectId: 'p1', workspaceId: 'w1', title: 's1', status: 'idle', updatedAt: 0 },
    ],
    messages: { s1: [...turn, ...rows] },
    historyErrors: {},
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  } as never);
}

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
        createElement(MessageTimeline, { sessionId: 's1', status: 'idle', thinkingEnabled: false })
      )
    )
  );
}

const row = () => container.querySelector('[data-testid="dsh-compaction-row"]');

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useCompactRunsStore.setState({ phases: {}, compactingSince: {}, cancelling: {} });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('/compact in the timeline (decision 180)', () => {
  it('[180-TL-1] its command line is the user’s own line, but opens no turn', async () => {
    setTimeline([
      compactCommandRow('s1', 'dsh-compact-command-k1', '/compact 保留未完成的任务'),
      compactRunningRow('s1', 'dsh-compaction-k1', 'Compacting the context…'),
    ]);
    await render();
    const command = container.querySelector('[data-testid="compact-command-row"]');
    expect(command?.textContent).toBe('/compact 保留未完成的任务');
    // Drawn as the user's bubble is drawn: the right edge.
    expect(command?.className).toContain('justify-end');
    // One turn: the typed prompt's.
    expect(container.querySelectorAll('[data-turn-id]')).toHaveLength(1);
    // Not this window's run: the row runs, with no clock and no way to cancel here.
    expect(row()?.getAttribute('data-state')).toBe('running');
    expect(row()?.textContent).toBe('正在压缩上下文…');
  });

  it('[180-TL-2] while this window compacts: the clock, and Esc to cancel; then cancelling', async () => {
    setTimeline([
      compactCommandRow('s1', 'compact-run-x-command', '/compact'),
      compactRunningRow('s1', 'compact-run-x', 'Compacting the context…'),
    ]);
    useCompactRunsStore.setState({
      phases: { s1: 'compacting' },
      compactingSince: { s1: Date.now() - 75_000 },
      cancelling: {},
    });
    await render();
    expect(row()?.textContent).toBe('正在压缩上下文… 1 分 15 秒按 Esc 取消');
    expect(container.querySelector('[data-testid="dsh-compaction-hint"]')?.textContent).toBe(
      '按 Esc 取消'
    );
    await act(async () => useCompactRunsStore.getState().requestCancel('s1'));
    expect(container.querySelector('[data-testid="dsh-compaction-hint"]')?.textContent).toBe(
      '正在取消…'
    );
  });

  it('[180-TL-3] while it starts the conversation: no clock yet, still cancellable', async () => {
    setTimeline([
      compactCommandRow('s1', 'compact-run-y-command', '/compact'),
      compactRunningRow('s1', 'compact-run-y', 'Starting the conversation…'),
    ]);
    useCompactRunsStore.setState({
      phases: { s1: 'starting' },
      compactingSince: {},
      cancelling: {},
    });
    await render();
    expect(row()?.textContent).toBe('正在启动对话…按 Esc 取消');
  });

  it('[180-TL-4] ended without a summary: one line why, DSH’s own reason included, in Chinese', async () => {
    setTimeline([
      compactCommandRow('s1', 'dsh-compact-command-k1', '/compact'),
      compactNoteRow('s1', 'dsh-compaction-k1', {
        key: DSH_COMPACT_FAILED_REASON_KEY,
        params: { reason: 'The history selected for compaction changed.' },
      }),
    ]);
    await render();
    expect(row()?.getAttribute('data-state')).toBe('settled');
    expect(row()?.textContent).toBe(
      '压缩没有成功，对话没有改动：The history selected for compaction changed.'
    );
    expect(container.querySelector('[data-testid="dsh-compaction-hint"]')).toBeNull();
  });
});
