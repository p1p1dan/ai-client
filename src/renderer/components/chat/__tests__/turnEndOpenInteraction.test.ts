// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * Which finished turns keep their process area open (user decision
 * 2026-09-24), read off the DOM of a real `MessageTimeline`.
 *
 * Only a turn the USER ended — Ctrl+Enter interjection or Stop — opens by
 * default, and it is a default: one click on the head closes it. Every other
 * finished turn folds, including one that ends on a tool call or fails. An
 * unanswered authorization is the one thing that still pins a group open
 * against the click.
 *
 * The regression this guards: 0a836f27 opened every settled turn with no
 * final answer, and did it through `forcedOpen`, which ignores the click — so
 * a turn that ended on a tool call, a failed turn and a replayed one all
 * stayed open and could not be closed.
 */
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate }) }));
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

type Blocks = ChatMessage['blocks'];

const user = (id: string, text: string): ChatMessage => ({
  id,
  sessionId: 's',
  role: 'user',
  blocks: [{ id: `${id}:t`, type: 'text', text }],
});

const assistant = (id: string, blocks: Blocks, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  sessionId: 's',
  role: 'assistant',
  blocks,
  ...extra,
});

const call = (id: string, command: string): Blocks => [
  { id, type: 'tool_call', toolCallId: id, toolName: 'Bash', toolInput: { command } },
  { id: `${id}:r`, type: 'tool_result', toolCallId: id, toolOk: true, toolOutput: 'ok' },
];

/** A turn body that ends on a tool call: narration, then two calls, no reply after them. */
const ENDS_ON_TOOL: Blocks = [
  { id: 'th', type: 'thinking', text: 'Checking the build.' },
  { id: 'tx', type: 'text', text: 'Let me run the build.' },
  ...call('c1', 'pnpm build'),
  ...call('c2', 'pnpm test'),
];

/** A turn body that ends on prose, so settling extracts it as the final answer. */
const ENDS_ON_TEXT: Blocks = [
  { id: 'th', type: 'thinking', text: 'Checking the build.' },
  ...call('c1', 'pnpm build'),
  { id: 'tx', type: 'text', text: 'Half an answer' },
];

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function renderSession(
  messages: ChatMessage[],
  status: 'idle' | 'failed' = 'idle',
  extra: Record<string, unknown> = {}
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useChatSessionsStore.setState({
    activeSessionId: 's',
    sessions: [{ id: 's', title: 's', projectId: 'p', workspaceId: 'w', status, updatedAt: 0 }],
    messages: { s: messages },
    lastError: null,
    pendingPermissions: [],
    pendingQuestions: [],
    ...extra,
  } as never);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient();
  const render = () =>
    act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(MessageTimeline, { sessionId: 's', status, thinkingEnabled: true })
        )
      )
    );
  await render();
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  };
  /** The process group of the turn anchored on `turnId`. */
  const group = (turnId: string) => {
    const details = container.querySelector<HTMLDetailsElement>(
      `section[data-turn-id="${turnId}"] details`
    );
    expect(details, `turn ${turnId} has a process head`).not.toBeNull();
    return details as HTMLDetailsElement;
  };
  // A plain `Event`, not `summary.click()`: happy-dom toggles `<details>` as
  // the click bubbles THROUGH it, before React's root listener can call
  // `preventDefault()`, so a MouseEvent click would flip `open` on its own
  // and mask what the component decided. A browser runs that default action
  // after dispatch and honours the cancel. React's `onClick` fires for any
  // `click` event, and happy-dom only toggles for a MouseEvent — so with this,
  // `details.open` is exactly the component's own `open` prop.
  const clickHead = (turnId: string) =>
    act(async () =>
      group(turnId)
        .querySelector('summary')
        ?.dispatchEvent(new Event('click', { bubbles: true }))
    );
  return { group, clickHead, render };
}

it('[END-OPEN-1] a turn cut off by Ctrl+Enter opens by default, and one click closes it', async () => {
  for (const [label, body] of [
    ['ends on a tool call', ENDS_ON_TOOL],
    ['ends on prose', ENDS_ON_TEXT],
  ] as const) {
    const { group, clickHead, render } = await renderSession([
      user('u1', 'Fix the build'),
      assistant('a1', body, { stopCause: 'interjected' }),
      user('u2', 'Use pnpm instead'),
      assistant('a2', [{ id: 'a2:t', type: 'text', text: 'Switching to pnpm.' }]),
    ]);
    expect(group('u1').open, `${label}: open by default`).toBe(true);
    await clickHead('u1');
    expect(group('u1').open, `${label}: the click closes it`).toBe(false);
    // A later render (a new token, a store write) must not reopen it.
    await render();
    expect(group('u1').open, `${label}: and it stays closed`).toBe(false);
    await clickHead('u1');
    expect(group('u1').open, `${label}: and reopens on the next click`).toBe(true);
    await cleanup?.();
    cleanup = null;
  }
});

it('[END-OPEN-2] a turn the user stopped opens by default, and one click closes it', async () => {
  for (const [label, extra] of [
    ['live stop stamp', { stopCause: 'user_stop' }],
    // History written before the run-stop record: `turnEndCause`'s fallback.
    ['legacy aborted reply', { stopReason: 'aborted' }],
  ] as const) {
    const { group, clickHead } = await renderSession([
      user('u1', 'Fix the build'),
      assistant('a1', ENDS_ON_TOOL, extra),
    ]);
    expect(group('u1').open, `${label}: open by default`).toBe(true);
    await clickHead('u1');
    expect(group('u1').open, `${label}: the click closes it`).toBe(false);
    await cleanup?.();
    cleanup = null;
  }
});

it('[END-OPEN-3] a turn that ended on its own folds, even when it ends on a tool call or fails', async () => {
  // Ended on a tool call, naturally: `answer → tool → end`.
  const endsOnTool = await renderSession([
    user('u1', 'Fix the build'),
    assistant('a1', ENDS_ON_TOOL, { stopReason: 'toolUse' }),
  ]);
  expect(endsOnTool.group('u1').open, 'ended on a tool call').toBe(false);
  await endsOnTool.clickHead('u1');
  expect(endsOnTool.group('u1').open, 'and a click still opens it').toBe(true);
  await cleanup?.();
  cleanup = null;

  // Failed: the reply errored and the turn carries the error notice.
  const failed = await renderSession(
    [
      user('u1', 'Fix the build'),
      assistant('a1', ENDS_ON_TOOL, { stopReason: 'error' }),
      {
        id: 'e1',
        sessionId: 's',
        role: 'error',
        blocks: [{ id: 'e1:t', type: 'text', text: 'Upstream error' }],
      },
    ],
    'failed'
  );
  expect(failed.group('u1').open, 'a failed turn').toBe(false);
});

it('[END-OPEN-4] an unanswered authorization still pins the group open against a click', async () => {
  const { group, clickHead } = await renderSession([
    user('u1', 'Delete the cache'),
    assistant('a1', [
      ...call('c1', 'ls cache'),
      {
        id: 'p1',
        type: 'permission_request',
        toolCallId: 'c2',
        toolName: 'Bash',
        permissionId: 'perm-1',
        resolved: false,
      },
      { id: 'c2', type: 'tool_call', toolCallId: 'c2', toolName: 'Bash', toolInput: {} },
    ]),
  ]);
  expect(group('u1').open).toBe(true);
  await clickHead('u1');
  expect(group('u1').open, 'the click cannot bury the Allow/Deny surface').toBe(true);
});
