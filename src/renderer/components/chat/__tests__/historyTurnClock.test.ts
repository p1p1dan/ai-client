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
 * The clock has exactly one home per turn, and EVERY turn has one.
 *
 * ## The second 2026-09-22 report
 *
 * 「有的时候，直接显示：思考+输出，没有已工作 xx 秒」. Decision 034 D2 put the
 * duration on the process fold head and took it off the tail row — but a head
 * only exists where a group FOLDS, and T112 refuses a fold for a group of fewer
 * than two steps. So a turn shaped 思考 → 输出 (one step), 单工具 → 输出 (one
 * step), or a plain paragraph with no process at all (no group) had nowhere
 * left to put its clock, and simply did not report one.
 *
 * The fix does not touch T112's threshold — a one-step group still renders in
 * place, which is what the user asked for. It gives the clock a FALLBACK home:
 * the tail row, which is the one line every settled turn already has. So the
 * invariant is now "exactly one line per turn carries the duration", where it
 * used to be "at most one".
 *
 * `[CLOCK-ONCE-1]` is the other half and is not optional: T107 is the defect
 * where two elements print the same duration, and a fallback with no latch is
 * exactly how that comes back.
 */
it('[CLOCK-ANYWHERE-1] a turn whose group is too small to fold still reports its duration', async () => {
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
      expect(container.querySelectorAll('summary'), `${label}: no fold head, by T112`).toHaveLength(
        0
      );
      expect(container.textContent ?? '', `${label}: the clock still has a home`).toContain(
        WORKED_LINE
      );
    } finally {
      await unmount();
    }
  }
});

it('[CLOCK-ANYWHERE-2] a turn with no process at all reports its duration too', async () => {
  const { container, unmount } = await renderHistory(
    historyTurn(true, [{ id: 'h:a1:b1', type: 'text', text: '答案' }])
  );
  try {
    expect(container.querySelectorAll('summary')).toHaveLength(0);
    expect(container.textContent ?? '').toContain(WORKED_LINE);
  } finally {
    await unmount();
  }
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
