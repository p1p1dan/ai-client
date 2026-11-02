// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * Every finished turn keeps its steps on screen, read off the DOM of a real
 * `MessageTimeline`.
 *
 * PiLab R1 (user ruling 2026-10-30, preview
 * `docs/design/2026-10-30-turn-display-claude-code-preview.html`): the turn
 * reads as steps with no 「已工作 ›」 fold, so the 2026-09-24 rules about which
 * finished turn opens its fold by default no longer have a subject. What they
 * protected still holds and is what this file checks: a turn ended by Ctrl+Enter,
 * by Stop, on a tool call, by a failure, or waiting on an authorization shows
 * WHERE it got to — its steps, never behind a closed head.
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
import { useToolExpansionStore } from '@/stores/toolExpansion';
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
  // Expand choices are remembered per session now (FR-11.6); every render here
  // reuses session `s` and turn `u1`, so each starts with no remembered choice.
  useToolExpansionStore.setState({ bySession: {} });
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
  /** What the turn anchored on `turnId` shows, and whether any of it sits behind a fold. */
  const turn = (turnId: string) => {
    const section = container.querySelector(`section[data-turn-id="${turnId}"]`);
    expect(section, `turn ${turnId} is on screen`).not.toBeNull();
    return {
      text: section?.textContent ?? '',
      folds: section?.querySelectorAll('details').length ?? 0,
    };
  };
  return { turn, render };
}

it('[END-OPEN-1] a turn cut off by Ctrl+Enter shows its steps, not a closed head', async () => {
  for (const [label, body] of [
    ['ends on a tool call', ENDS_ON_TOOL],
    ['ends on prose', ENDS_ON_TEXT],
  ] as const) {
    const { turn } = await renderSession([
      user('u1', 'Fix the build'),
      assistant('a1', body, { stopCause: 'interjected' }),
      user('u2', 'Use pnpm instead'),
      assistant('a2', [{ id: 'a2:t', type: 'text', text: 'Switching to pnpm.' }]),
    ]);
    expect(turn('u1').folds, `${label}: no fold`).toBe(0);
    expect(turn('u1').text, `${label}: the step it reached`).toContain('pnpm');
    await cleanup?.();
    cleanup = null;
  }
});

it('[END-OPEN-2] a turn the user stopped shows its steps', async () => {
  for (const [label, extra] of [
    ['live stop stamp', { stopCause: 'user_stop' }],
    ['legacy aborted reply', { stopReason: 'aborted' }],
  ] as const) {
    const { turn } = await renderSession([
      user('u1', 'Fix the build'),
      assistant('a1', ENDS_ON_TOOL, extra),
    ]);
    expect(turn('u1').folds, `${label}: no fold`).toBe(0);
    expect(turn('u1').text, `${label}: its steps`).toContain('pnpm test');
    await cleanup?.();
    cleanup = null;
  }
});

it('[END-OPEN-3] a turn that ended on a tool call, or failed, shows its steps too', async () => {
  const endsOnTool = await renderSession([
    user('u1', 'Fix the build'),
    assistant('a1', ENDS_ON_TOOL, { stopReason: 'toolUse' }),
  ]);
  expect(endsOnTool.turn('u1').folds).toBe(0);
  expect(endsOnTool.turn('u1').text).toContain('pnpm test');
  await cleanup?.();
  cleanup = null;

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
  expect(failed.turn('u1').folds).toBe(0);
  expect(failed.turn('u1').text, 'output kept where it stopped (user, 2026-10-19)').toContain(
    'pnpm test'
  );
});

it('[END-OPEN-4] a step waiting on an authorization is never behind a fold', async () => {
  const { turn } = await renderSession([
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
  expect(turn('u1').folds).toBe(0);
  expect(turn('u1').text).toContain('ls cache');
});
