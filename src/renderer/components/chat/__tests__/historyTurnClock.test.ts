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

const WORKED_LINE = zh('Worked for {{minutes}}m {{seconds}}s', { minutes: 6, seconds: 41 });

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

it('[HIST-CLOCK-1] a replayed turn reports its duration on the head and its bill on the tail row', async () => {
  const { container, unmount } = await renderHistory(historyTurn(true));
  try {
    const summary = container.querySelector('summary');
    expect(summary, 'the group folds, so a head exists').not.toBeNull();
    // 「已工作 6 分 41 秒」 — the user's ⑥, on the element they read it from.
    expect(summary?.textContent).toContain(WORKED_LINE);
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

/**
 * The duration sits at the TOP of the turn. In every case.
 *
 * ## Two reports, one rule
 *
 * 「有的时候，直接显示：思考+输出，没有已工作 xx 秒」 — decision 034 D2 put the
 * duration on the process fold head, and a head only exists where a group
 * FOLDS. T112 refuses a fold below two steps, so 思考 → 输出, 单工具 → 输出 and
 * a bare paragraph reported no duration at all.
 *
 * The first fix gave it a fallback home on the TAIL row, and the user rejected
 * that on sight: 「什么情况都让 已工作 x 分 xx 秒 落在顶部。不要什么一个折叠头
 * 都没有时，落到尾栏，那样展示出来的风格都不统一」. The rule is not "the clock
 * has a home somewhere" — it is **the clock is the turn's first line**, folded
 * or not.
 *
 * So these cases assert POSITION, not mere presence. A test that only asked
 * 「时长在页面上吗」 passed against the rejected design too.
 *
 * T112's threshold no longer decides the SHAPE of a finished turn. 5b7853dc
 * ties the fold to the turn's phase instead (`processSettled || …folds()`,
 * `turnWorkGroupOpen` returning `!settled`), so a settled turn gets a head even
 * where T112 would have rendered its one step in place. That is a deliberate
 * behaviour change and this case follows it: what it guards is unchanged and is
 * the part the user actually reported — the clock is the turn's FIRST line,
 * whatever shape the process rows take around it.
 *
 * `[CLOCK-ONCE-1]` is the other half and is not optional: T107 is the defect
 * where two elements print the same duration, and a second line carrying it is
 * exactly how that comes back.
 */
it('[CLOCK-TOP-1] a turn too small to fold still leads with its duration', async () => {
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
  ] as [string, ChatMessage['blocks']][]) {
    const { container, unmount } = await renderHistory(historyTurn(true, blocks));
    try {
      // One head, not zero (5b7853dc — see the note above) and not two: a
      // second head would mean the turn folded its process rows twice, which
      // is how the duplicated-duration defect of T107 comes back.
      expect(
        container.querySelectorAll('summary'),
        `${label}: the settled turn folds under exactly one head`
      ).toHaveLength(1);
      const text = container.textContent ?? '';
      expect(text, `${label}: the clock is on screen`).toContain(WORKED_LINE);
      // …and it LEADS. Before everything the turn has to show, exactly as it
      // does on a folded turn.
      expect(text.indexOf(WORKED_LINE), `${label}: the clock comes first`).toBeLessThan(
        text.indexOf('答案')
      );
      expect(
        text.indexOf(WORKED_LINE),
        `${label}: …including before the process rows`
      ).toBeLessThan(text.indexOf(zh('Final output')));
      // The tail row is the BILL. The duration is not part of it — that was the
      // rejected shape.
      expect(text.lastIndexOf(WORKED_LINE), `${label}: not on the tail row`).toBeLessThan(
        text.indexOf('完成于')
      );
    } finally {
      await unmount();
    }
  }
});

it('[CLOCK-TOP-2] a turn with no process at all leads with its duration too', async () => {
  const { container, unmount } = await renderHistory(
    historyTurn(true, [{ id: 'h:a1:b1', type: 'text', text: '答案' }])
  );
  try {
    expect(container.querySelectorAll('summary')).toHaveLength(0);
    const text = container.textContent ?? '';
    expect(text.indexOf(WORKED_LINE)).toBeGreaterThan(-1);
    expect(text.indexOf(WORKED_LINE)).toBeLessThan(text.indexOf('答案'));
    expect(text.lastIndexOf(WORKED_LINE)).toBeLessThan(text.indexOf('完成于'));
  } finally {
    await unmount();
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

it('[CLOCK-ONCE-1] a turn that HAS a fold head does not repeat the duration below it', async () => {
  const { container, unmount } = await renderHistory(historyTurn(true));
  try {
    const text = container.textContent ?? '';
    expect(text.split(WORKED_LINE).length - 1, 'T107: one duration per turn').toBe(1);
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
    expect(text).toContain(zh('Worked for {{seconds}}s', { seconds: 20 }));
    expect(text, 'not the write of the call that started the 20 seconds').not.toContain(
      zh('Worked for {{seconds}}s', { seconds: 1 })
    );
  } finally {
    await unmount();
  }
});
