// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

/**
 * The turn clock on a REPLAYED turn, and the head that must never be blank.
 *
 * ## The incident this file is the regression for (2026-09-22)
 *
 * Decision 034 made the process fold head report the turn's clock and nothing
 * else, and deleted the step-count line that used to be there unconditionally.
 * The clock comes from `useMessageMetadata`, which is an in-memory registry fed
 * by live Runtime Events and persisted nowhere — so it holds exactly the turns
 * this mount watched run. Every OTHER turn (app restart, session switch and
 * back, resume) derived `null`, and `null` meant:
 *
 *  - the fold head rendered a lone chevron with NO text at all, and
 *  - the work zone row did not render.
 *
 * The user's report was 「现在折叠头和尾栏都没了」. The whole suite was green
 * through it, because every assertion on this element is a source scan
 * (`messageTimelineWiring.test.ts`) — the code had the right SHAPE and the
 * screen was still empty. That is why these cases read the DOM instead.
 *
 * ## Two independent guards, and neither replaces the other
 *
 *  - `[HIST-CLOCK-1]` — a replayed turn HAS a clock, derived from the history
 *    entries' own timestamps. This is the fix that makes decision 034's head
 *    visible where the user actually reads it.
 *  - `[HEAD-BLANK-1]` — a fold head is never an empty row, whatever the clock
 *    says. This holds even for a turn with no timestamps anywhere, which is
 *    still reachable (a history entry Pi could not date), and it is the
 *    property whose absence turned a missing clock into a missing HEAD.
 */
const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
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

import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { MessageTimeline } from '../MessageTimeline';

const SENT_AT = Date.UTC(2026, 8, 22, 9, 0, 0);
const DONE_AT = SENT_AT + 401_000; // 6m 41s — the duration from the zcode brief.

/**
 * A turn exactly as a replay hands it over: two `h:`-prefixed messages, two
 * tool calls so the group earns a fold (`turnProcessGroupFolds` > 1 step), and
 * NO metadata registry entry anywhere — which is the whole point.
 */
function historyTurn(stamped: boolean): ChatMessage[] {
  const at = (ms: number) => (stamped ? { timestamp: ms } : {});
  return [
    {
      id: 'h:u1',
      sessionId: 's',
      role: 'user',
      blocks: [{ id: 'h:u1:t', type: 'text', text: '帮我看看' }],
      ...at(SENT_AT),
    },
    {
      id: 'h:a1',
      sessionId: 's',
      role: 'assistant',
      blocks: [
        {
          id: 'h:a1:b1',
          type: 'tool_call',
          toolCallId: 'c1',
          toolName: 'Bash',
          toolInput: { command: 'ls' },
        },
        { id: 'h:a1:b2', type: 'tool_result', toolCallId: 'c1', toolOk: true, toolOutput: 'ok' },
        {
          id: 'h:a1:b3',
          type: 'tool_call',
          toolCallId: 'c2',
          toolName: 'Read',
          toolInput: { file_path: '/repo/a.ts' },
        },
        { id: 'h:a1:b4', type: 'tool_result', toolCallId: 'c2', toolOk: true, toolOutput: 'ok' },
        { id: 'h:a1:b5', type: 'text', text: '看完了' },
      ],
      ...at(DONE_AT),
    },
  ];
}

async function renderHistory(messages: ChatMessage[]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useChatSessionsStore.setState({
    activeSessionId: 's',
    sessions: [
      { id: 's', title: 's', projectId: 'p', workspaceId: 'w', status: 'idle', updatedAt: 0 },
    ],
    messages: { s: messages },
    lastError: null,
    pendingPermissions: [],
    pendingQuestions: [],
  } as never);
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
  return { container, unmount: () => act(async () => root.unmount()) };
}

it('[HIST-CLOCK-1] a replayed turn reports its duration on the head and its bill on the tail row', async () => {
  const { container, unmount } = await renderHistory(historyTurn(true));
  try {
    const summary = container.querySelector('summary');
    expect(summary, 'the group folds, so a head exists').not.toBeNull();
    // 「已工作 6 分 41 秒」 — the user's ⑥, on the element they read it from.
    expect(summary?.textContent).toContain(
      zh('Worked for {{minutes}}m {{seconds}}s', { minutes: 6, seconds: 41 })
    );
    // The tail row is the turn's BILL, settled-only: completion time and the
    // call count. Thinking time is absent from a replay and is omitted rather
    // than printed as a zero (A07 :2399).
    const text = container.textContent ?? '';
    expect(text).toContain('完成于');
    expect(text).toContain(zh('{{count}} tool calls', { count: 2 }));
  } finally {
    await unmount();
  }
});

it('[HEAD-BLANK-1] a fold head is never an empty row, even with no timestamps at all', async () => {
  const { container, unmount } = await renderHistory(historyTurn(false));
  try {
    const summary = container.querySelector('summary');
    expect(
      summary,
      'the group still folds — the fold rule counts steps, not clocks'
    ).not.toBeNull();
    expect(
      (summary?.textContent ?? '').trim(),
      'a head with no clock still says what it is'
    ).not.toBe('');
  } finally {
    await unmount();
  }
});
