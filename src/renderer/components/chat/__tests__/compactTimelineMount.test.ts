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
import { settleCompactRun, showCompactRun } from '@/stores/chatSessionActions';
import { applyRuntimeEvent, type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
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

/**
 * DA-6 (2026-10-11 acceptance): a `/compact` ran after the turn before it
 * ended, so its rows come after that turn — after its 「✻ 完成于…」 line too.
 * They had joined the turn's body, and the line is drawn after the body.
 */
describe('/compact after the turn it follows (decision 180, DA-6)', () => {
  const T0 = new Date(2026, 9, 11, 9, 59, 0).getTime();
  const finished: ChatMessage[] = [
    {
      id: 'h:u1',
      sessionId: 's1',
      role: 'user',
      timestamp: T0,
      blocks: [{ id: 'h:u1:t', type: 'text', text: '先读一下 README' }],
    },
    {
      id: 'h:a1',
      sessionId: 's1',
      role: 'assistant',
      timestamp: T0 + 9_000,
      blocks: [{ id: 'h:a1:t', type: 'text', text: 'README 读完了。' }],
    },
  ];
  const next: ChatMessage = {
    id: 'h:u2',
    sessionId: 's1',
    role: 'user',
    timestamp: T0 + 60_000,
    blocks: [{ id: 'h:u2:t', type: 'text', text: '接着做第二步' }],
  };

  function setMessages(rows: ChatMessage[]) {
    setTimeline([]);
    useChatSessionsStore.setState((state) => ({ ...state, messages: { s1: rows } }) as never);
  }

  /** Where each piece of text first shows in the page, in reading order. */
  const at = (text: string) => container.textContent?.indexOf(text) ?? -1;

  const cases: [string, ChatMessage[]][] = [
    [
      'live, running',
      [
        compactCommandRow('s1', 'dsh-compact-command-k1', '/compact 保留未完成的任务'),
        compactRunningRow('s1', 'dsh-compaction-k1', 'Compacting the context…'),
      ],
    ],
    [
      'this window’s own, before the engine named it',
      [
        compactCommandRow('s1', 'compact-run-z-command', '/compact 保留未完成的任务'),
        compactRunningRow('s1', 'compact-run-z', 'Compacting the context…'),
      ],
    ],
    [
      'reopened, without a summary',
      [
        compactCommandRow('s1', 'h:compact-command-k1', '/compact 保留未完成的任务'),
        compactNoteRow('s1', 'h:compaction-k1', {
          key: DSH_COMPACT_FAILED_REASON_KEY,
          params: { reason: 'x' },
        }),
      ],
    ],
  ];

  for (const [name, rows] of cases) {
    it(`[180-DA6] ${name}: after the turn and its line, before the next prompt; no turn of its own`, async () => {
      setMessages([...finished, ...rows, next]);
      await render();
      const line = at('✻ 完成于');
      expect(line, name).toBeGreaterThan(at('README 读完了。'));
      expect(at('/compact 保留未完成的任务'), name).toBeGreaterThan(line);
      expect(at('接着做第二步'), name).toBeGreaterThan(at('/compact 保留未完成的任务'));
      expect(row()?.textContent, name).toBeTruthy();
      expect(at(row()?.textContent ?? '?'), name).toBeGreaterThan(at('/compact 保留未完成的任务'));
      // Two prompts, two turns; the compaction is neither, and has no clock or line of its own.
      expect(container.querySelectorAll('[data-turn-id]'), name).toHaveLength(2);
      expect(container.textContent?.match(/✻/g), name).toHaveLength(1);
      const own = container
        .querySelector('[data-testid="compact-command-row"]')
        ?.closest('section');
      expect(own?.hasAttribute('data-turn-id'), name).toBe(false);
      expect(own?.textContent, name).not.toMatch(/已工作|工作中|✻/);
    });
  }

  it('[180-DA6] the last thing in the chat: still after the turn’s line', async () => {
    setMessages([
      ...finished,
      compactCommandRow('s1', 'dsh-compact-command-k2', '/compact'),
      compactRunningRow('s1', 'dsh-compaction-k2', 'Compacting the context…'),
    ]);
    await render();
    expect(at('/compact')).toBeGreaterThan(at('✻ 完成于'));
    expect(container.querySelectorAll('[data-turn-id]')).toHaveLength(1);
  });
});

// Issue #17: a second /compact left two 「上下文摘要」 on the timeline, both looking current.
describe('an earlier compaction’s summary (issue #17)', () => {
  const summary = (id: string, text: string): ChatMessage => ({
    id,
    sessionId: 's1',
    role: 'system',
    blocks: [{ id: `${id}:summary:0`, type: 'text', text }],
  });

  it('[17-TL-1] is folded as superseded; only the newest is drawn in full', async () => {
    setTimeline([
      summary('h:c1', '上下文摘要\n第一次的摘要'),
      summary('h:c2', '上下文摘要\n第二次的摘要'),
    ]);
    await render();
    const folded = container.querySelectorAll('[data-testid="superseded-summary"]');
    expect(folded).toHaveLength(1);
    expect(folded[0]?.textContent).toContain('上下文摘要 · 已被后续的压缩取代');
    expect(folded[0]?.textContent).not.toContain('第一次的摘要');
    expect(container.textContent).toContain('第二次的摘要');
    // Opened on demand, the earlier summary is still there to read.
    await act(async () => (folded[0]?.querySelector('button') as HTMLButtonElement).click());
    expect(container.textContent).toContain('第一次的摘要');
  });

  it('[17-TL-2] a single summary is drawn in full', async () => {
    setTimeline([summary('h:c1', '上下文摘要\n唯一的摘要')]);
    await render();
    expect(container.querySelector('[data-testid="superseded-summary"]')).toBeNull();
    expect(container.textContent).toContain('唯一的摘要');
  });

  // Found in the dev app on 2026-10-18: one /compact showed two command lines and
  // two summaries, the first folded as superseded. Its answer had settled the
  // run before the bridge's events of the same compaction left their batch.
  it('[17-TL-3] one /compact whose answer lands before its live events: one command line, one summary', async () => {
    setTimeline([]);
    showCompactRun('s1', 'r1', '/compact', 'Compacting the context…');
    settleCompactRun('s1', 'r1', {
      kind: 'summary',
      summary: {
        id: 'h:cp1',
        entryId: 'cp1',
        role: 'system',
        liveMessageId: 'dsh-compaction-k1',
        blocks: [{ id: 'h:cp1:summary:0', type: 'text', text: '上下文摘要\n这一次的摘要' }],
      },
    });
    const live = (payload: Record<string, unknown>) =>
      useChatSessionsStore.setState((state) =>
        applyRuntimeEvent(state, {
          type: 'session.compaction',
          seq: 1,
          timestamp: 1,
          sessionId: 's1',
          payload: { messageId: 'dsh-compaction-k1', trigger: 'manual', ...payload },
        } as never)
      );
    live({
      phase: 'started',
      commandMessageId: 'dsh-compact-command-k1',
      command: '/compact',
    });
    live({ phase: 'completed', summary: '上下文摘要\n这一次的摘要' });
    await render();
    expect(container.querySelectorAll('[data-testid="compact-command-row"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="superseded-summary"]')).toBeNull();
    expect(container.textContent?.match(/这一次的摘要/g)).toHaveLength(1);
  });
});
