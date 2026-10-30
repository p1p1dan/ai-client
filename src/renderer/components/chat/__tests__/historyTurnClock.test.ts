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
import { turnClockRowClass, turnWorkGroupSummaryClass } from '../chatTimelineLayout';
import { MessageTimeline } from '../MessageTimeline';

const SENT_AT = Date.UTC(2026, 8, 22, 9, 0, 0);
const DONE_AT = SENT_AT + 401_000; // 6m 41s — the duration from the zcode brief.

/** Two calls plus a reply — enough steps that the group earns a fold. */
const TWO_CALL_BODY: ChatMessage['blocks'] = [
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
];

/**
 * A turn exactly as a replay hands it over: two `h:`-prefixed messages and NO
 * metadata registry entry anywhere — which is the whole point.
 */
function historyTurn(stamped: boolean, blocks = TWO_CALL_BODY): ChatMessage[] {
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
      blocks,
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

/**
 * PiLab R1 (user ruling 2026-10-30, preview
 * `docs/design/2026-10-30-turn-display-claude-code-preview.html`): the turn
 * reads as steps with no fold head, and its duration moved into the footer —
 * 「✻ 完成于 17:05 · 用时 6 分 41 秒 · 2 次工具调用」. That replaces the 09-22
 * rule "the duration is the turn's first line". What this file guards is
 * unchanged: a replayed turn HAS a duration, printed ONCE (T107), on a line that
 * is never blank (the 「折叠头和尾栏都没了」 incident).
 */
const TOOK_LINE = zh('Took {{duration}}', {
  duration: zh('{{minutes}}m {{seconds}}s', { minutes: 6, seconds: 41 }),
});
const billOf = (container: HTMLElement) =>
  container.querySelector('[data-slot="turn-bill"]')?.textContent ?? '';

it('[HIST-CLOCK-1] a replayed turn reports when it ended, how long it took and its calls', async () => {
  const { container, unmount } = await renderHistory(historyTurn(true));
  try {
    expect(container.querySelector('summary'), 'no fold head any more').toBeNull();
    const bill = billOf(container);
    expect(bill).toContain('完成于');
    expect(bill).toContain(TOOK_LINE);
    expect(bill).toContain(zh('{{count}} tool calls', { count: 2 }));
  } finally {
    await unmount();
  }
});

it('[HEAD-BLANK-1] the turn line is never empty, even with no timestamps at all', async () => {
  const { container, unmount } = await renderHistory(historyTurn(false));
  try {
    expect(billOf(container).trim(), 'a turn with no clock still says what it did').not.toBe('');
  } finally {
    await unmount();
  }
});

it('[CLOCK-BILL-1] every shape of turn states its duration once, in the footer after the answer', async () => {
  for (const [label, blocks] of [
    [
      '思考 + 输出',
      [
        { id: 'h:a1:b1', type: 'thinking', text: '想一想' },
        { id: 'h:a1:b2', type: 'text', text: '答案' },
      ],
    ],
    [
      '单工具 + 输出',
      [
        {
          id: 'h:a1:b1',
          type: 'tool_call',
          toolCallId: 'c1',
          toolName: 'Bash',
          toolInput: { command: 'ls' },
        },
        { id: 'h:a1:b2', type: 'tool_result', toolCallId: 'c1', toolOk: true, toolOutput: 'ok' },
        { id: 'h:a1:b3', type: 'text', text: '答案' },
      ],
    ],
    ['只有正文', [{ id: 'h:a1:b1', type: 'text', text: '答案' }]],
  ] as [string, ChatMessage['blocks']][]) {
    const { container, unmount } = await renderHistory(historyTurn(true, blocks));
    try {
      expect(container.querySelectorAll('summary'), `${label}: no fold head`).toHaveLength(0);
      const text = container.textContent ?? '';
      expect(text.split(TOOK_LINE).length - 1, `${label}: exactly once`).toBe(1);
      expect(billOf(container), `${label}: on the footer`).toContain(TOOK_LINE);
      expect(text.indexOf(TOOK_LINE), `${label}: after the answer`).toBeGreaterThan(
        text.indexOf('答案')
      );
    } finally {
      await unmount();
    }
  }
});

/**
 * One row, one look. 「那样展示出来的风格都不统一」 is the failure this pins, so
 * the assertion is on the CLASS SETS and not on a screenshot: every token the
 * plain row carries is a token the fold head carries, and the difference is a
 * closed, named list.
 *
 * Three of the five extras are what a `<summary>` needs to stop looking like a
 * `<summary>`. The other two are the pin, which T096 grants to exactly one
 * surface in the timeline and which changes nothing about the line's
 * appearance — see `turnClockRowClass`.
 */
it('[CLOCK-TOP-3] the unfolded clock row wears the folded head class, minus a closed list', () => {
  const summary = turnWorkGroupSummaryClass().split(' ');
  const plain = turnClockRowClass().split(' ');
  expect(plain.every((token) => summary.includes(token))).toBe(true);
  expect(summary.filter((token) => !plain.includes(token)).sort()).toEqual([
    'cursor-pointer',
    'list-none',
    'marker:content-none',
    'sticky',
    'top-0',
    'z-10',
  ]);
});

it('[CLOCK-ONCE-1] a turn prints its duration once', async () => {
  const { container, unmount } = await renderHistory(historyTurn(true));
  try {
    const text = container.textContent ?? '';
    expect(text.split(TOOK_LINE).length - 1, 'T107: one duration per turn').toBe(1);
  } finally {
    await unmount();
  }
});

/**
 * 「✻」 is the tail row's BULLET, not one of its clauses.
 *
 * Decision 034 rewrote the line as `joinTurnProgressLine('✻', [...])`, and that
 * helper `· `-joins its head with the clauses — so the row rendered
 * 「✻ · 完成于 17:06」, a separator with nothing on its left. The spec line in
 * decision 034 is 「✻ 完成于 17:05 · 73 次调用」.
 */
it('[TAIL-GLYPH-1] the tail row bullet carries no separator after it', async () => {
  const { container, unmount } = await renderHistory(historyTurn(true));
  try {
    const text = container.textContent ?? '';
    expect(text).toContain('✻ 完成于');
    expect(text, 'no orphan separator after the bullet').not.toContain('✻ · ');
  } finally {
    await unmount();
  }
});

/**
 * N2 (devbox 2026-09-24): a turn ended by Ctrl+Enter read 「已工作 20 秒」 live
 * and 「已工作 1 秒」 after a restart.
 *
 * Ctrl+Enter stops the run at the tool boundary, so the turn's last assistant
 * entry is the one that ISSUED `sleep 20` — written before the 20 seconds ran.
 * The history projection now carries the later dates it folds into that
 * message (the tool result, the run-stop record) as `settledAt`, and the
 * replayed clock has to end there. `settledAt` reaches `ChatMessage` through
 * the store's history mapping (`chatSessionsHistory.test.ts [N2-MAP-1]`).
 */
it('[HIST-CLOCK-3] an interjected turn that ended on a tool result is timed to its settle', async () => {
  const sleepCall: ChatMessage['blocks'] = [
    {
      id: 'h:a2:b1',
      type: 'tool_call',
      toolCallId: 'c2',
      toolName: 'bash',
      toolInput: { command: 'sleep 20' },
    },
    { id: 'h:a2:b2', type: 'tool_result', toolCallId: 'c2', toolOk: true, toolOutput: 'done' },
  ];
  const messages: ChatMessage[] = [
    {
      id: 'h:u1',
      sessionId: 's',
      role: 'user',
      blocks: [{ id: 'h:u1:t', type: 'text', text: '长任务' }],
      timestamp: SENT_AT,
    },
    {
      id: 'h:a1',
      sessionId: 's',
      role: 'assistant',
      blocks: TWO_CALL_BODY.slice(0, 4),
      timestamp: SENT_AT + 150,
      settledAt: SENT_AT + 200,
    },
    {
      id: 'h:a2',
      sessionId: 's',
      role: 'assistant',
      blocks: sleepCall,
      stopCause: 'interjected',
      timestamp: SENT_AT + 322,
      settledAt: SENT_AT + 20_368,
    },
  ];
  const { container, unmount } = await renderHistory(messages);
  try {
    const text = container.textContent ?? '';
    const took = (seconds: number) =>
      zh('Took {{duration}}', { duration: zh('{{seconds}}s', { seconds }) });
    expect(text).toContain(took(20));
    expect(text, 'not the write of the call that started the 20 seconds').not.toContain(took(1));
  } finally {
    await unmount();
  }
});
