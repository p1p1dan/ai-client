// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Decision 208 (user ruling 2026-11-03), read off a real `MessageTimeline`: the
 * reader's setting picks the drawing, live, and neither style folds the turn or
 * draws the 「最终输出」 divider.
 */
const settings = vi.hoisted(() => ({
  state: { showToolDiff: false, chatTranscriptStyle: 'terminal' as string },
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: Object.assign(
    (selector: (s: typeof settings.state) => unknown) => selector(settings.state),
    { getState: () => settings.state }
  ),
}));
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

const call = (id: string, description: string): Blocks => [
  {
    id,
    type: 'tool_call',
    toolCallId: id,
    toolName: 'Bash',
    toolInput: { command: 'true', description },
  },
  { id: `${id}:r`, type: 'tool_result', toolCallId: id, toolOk: true, toolOutput: 'ok' },
];

/** Narration, two calls, then the reply. */
const TURN: Blocks = [
  { id: 'tx1', type: 'text', text: 'Let me check the `main` branch.' },
  ...call('c1', 'List branches'),
  ...call('c2', 'Count commits'),
  { id: 'tx2', type: 'text', text: 'Done: six branches can go.' },
];

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function renderSession(style: 'terminal' | 'desktop', extra: Partial<ChatMessage> = {}) {
  settings.state.chatTranscriptStyle = style;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useToolExpansionStore.setState({ bySession: {} });
  useChatSessionsStore.setState({
    activeSessionId: 's',
    sessions: [
      { id: 's', title: 's', projectId: 'p', workspaceId: 'w', status: 'idle', updatedAt: 0 },
    ],
    messages: { s: [user('u1', 'Which branches can go?'), assistant('a1', TURN, extra)] },
    lastError: null,
    pendingPermissions: [],
    pendingQuestions: [],
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
          createElement(MessageTimeline, { sessionId: 's', status: 'idle', thinkingEnabled: true })
        )
      )
    );
  await render();
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  };
  const turn = () => container.querySelector('section[data-turn-id="u1"]') as HTMLElement;
  return { container, turn, render };
}

describe('decision 208: the transcript style setting', () => {
  it('terminal: prose and steps sit in bullet blocks, in the mono stack, with no fold', async () => {
    const { turn } = await renderSession('terminal');
    const section = turn();
    const blocks = section.querySelectorAll('[data-slot="terminal-block"]');
    // Two paragraphs and two steps.
    expect(blocks.length).toBe(4);
    expect(section.querySelectorAll('[data-shape="bullet"][data-status="success"]').length).toBe(2);
    expect(section.querySelector('.font-mono [data-message-id]')).not.toBeNull();
    expect(section.textContent).toContain('Bash(List branches)');
    expect(section.querySelectorAll('details').length).toBe(0);
    expect(section.textContent).not.toContain('Final output');
  });

  it('desktop: the two calls between the paragraphs are one closed run', async () => {
    const { turn } = await renderSession('desktop');
    const section = turn();
    const runs = section.querySelectorAll<HTMLDetailsElement>('details[data-slot="step-run"]');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.open).toBe(false);
    expect(runs[0]?.querySelector('summary')?.textContent).toContain('Ran 2 commands');
    expect(section.querySelector('[data-slot="terminal-block"]')).toBeNull();
    // The rows the run opens to name the tool as the summary does, never a
    // translated verb (here the English catalog's 「Ran」).
    const rowWords = [...(runs[0]?.querySelectorAll('.group\\/row') ?? [])].map(
      (row) => row.textContent ?? ''
    );
    expect(rowWords).toHaveLength(2);
    for (const words of rowWords) {
      expect(words.startsWith('Bash')).toBe(true);
      expect(words).not.toContain('Ran');
    }
    expect(section.textContent).not.toContain('Final output');
  });

  it('desktop: a turn the user cut off starts its last section open', async () => {
    const { turn } = await renderSession('desktop', { stopCause: 'interjected' });
    const run = turn().querySelector<HTMLDetailsElement>('details[data-slot="step-run"]');
    expect(run?.open).toBe(true);
  });

  it('switching the setting redraws the open chat', async () => {
    const { turn, render } = await renderSession('terminal');
    expect(turn().querySelector('details[data-slot="step-run"]')).toBeNull();
    settings.state.chatTranscriptStyle = 'desktop';
    await render();
    expect(turn().querySelector('details[data-slot="step-run"]')).not.toBeNull();
  });

  it('an unknown stored value draws the terminal style', async () => {
    const { turn } = await renderSession('classic' as never);
    expect(turn().querySelector('[data-slot="terminal-block"]')).not.toBeNull();
  });
});
