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

async function renderSession(
  style: 'terminal' | 'desktop',
  extra: Partial<ChatMessage> = {},
  options: { blocks?: Blocks; running?: boolean } = {}
) {
  settings.state.chatTranscriptStyle = style;
  const status = options.running ? 'running' : 'idle';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useToolExpansionStore.setState({ bySession: {} });
  useChatSessionsStore.setState({
    activeSessionId: 's',
    sessions: [{ id: 's', title: 's', projectId: 'p', workspaceId: 'w', status, updatedAt: 0 }],
    messages: {
      s: [user('u1', 'Which branches can go?'), assistant('a1', options.blocks ?? TURN, extra)],
    },
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
  const turn = () => container.querySelector('section[data-turn-id="u1"]') as HTMLElement;
  return { container, turn, render };
}

describe('decision 208: the transcript style setting', () => {
  it('terminal: prose and steps sit in bullet blocks, in the app’s sans, with no fold', async () => {
    const { turn } = await renderSession('terminal');
    const section = turn();
    const blocks = section.querySelectorAll('[data-slot="terminal-block"]');
    // Two paragraphs and two steps.
    expect(blocks.length).toBe(4);
    expect(section.querySelectorAll('[data-shape="bullet"][data-status="success"]').length).toBe(2);
    // User, 2026-11-03: the mono stack read odd next to Claude's desktop app, so
    // the prose and the step lines take the app's sans; only the mark column and
    // code stay mono.
    expect(section.querySelector('[data-message-id]')).not.toBeNull();
    expect(section.querySelector('.font-mono [data-message-id]')).toBeNull();
    expect(section.querySelector('[class*="group/step"].font-mono')).toBeNull();
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

/**
 * Decision 208, second round (user ruling 2026-11-03): the terminal style's
 * live line names the running step, its reads merge only when adjacent, and
 * thinking in both styles is drawn where it happened.
 */
describe('decision 208: aligned with the comparison mockup', () => {
  const read = (id: string, path: string): Blocks => [
    {
      id,
      type: 'tool_call',
      toolCallId: id,
      toolName: 'Read',
      toolInput: { file_path: path },
    },
    { id: `${id}:r`, type: 'tool_result', toolCallId: id, toolOk: true, toolOutput: 'x' },
  ];
  const LOOKS: Blocks = [
    { id: 'th', type: 'thinking', text: 'Which file holds the list?' },
    ...read('r1', '/repo/a.ts'),
    ...call('c1', 'List branches'),
    ...read('r2', '/repo/b.ts'),
    { id: 'tx', type: 'text', text: 'Done.' },
  ];

  const RUNNING_CALL: Blocks = [
    {
      id: 'c9',
      type: 'tool_call',
      toolCallId: 'c9',
      toolName: 'Bash',
      toolInput: { command: 'pnpm test', description: 'Run the tests' },
    },
  ];

  // Decision 211 (user, 2026-11-09): the running step says what the turn is
  // doing; a second line saying it again is gone.
  it('terminal: the running step carries how long and how to stop it, once', async () => {
    const { turn } = await renderSession('terminal', {}, { blocks: RUNNING_CALL, running: true });
    expect(turn().querySelector('[data-slot="turn-live-line"]')).toBeNull();
    const tails = turn().querySelectorAll('[data-slot="turn-live-tail"]');
    expect(tails).toHaveLength(1);
    expect(tails[0]?.textContent).toContain('esc to interrupt');
    const host = tails[0]?.closest('[data-turn-live-host]');
    expect(host?.getAttribute('data-slot')).toBe('terminal-block');
    expect(host?.textContent).toContain('Bash(Run the tests)');
    // It reads as the line of its own did: the working star, not the step's dot.
    expect(host?.querySelector('[data-shape="star"][data-status="running"]')).not.toBeNull();
    expect(host?.querySelector('[data-shape="bullet"]')).toBeNull();
  });

  it('terminal: with nothing live, the turn says it on a line of its own', async () => {
    // The call came back; the model has not said anything since.
    const { turn } = await renderSession(
      'terminal',
      {},
      { blocks: call('c1', 'List branches'), running: true }
    );
    const line = turn().querySelector('[data-slot="turn-live-line"]');
    expect(line?.textContent).toContain('Thinking…');
    expect(line?.textContent).toContain('esc to interrupt');
    expect(line?.querySelector('[data-shape="star"][data-status="running"]')).not.toBeNull();
    expect(turn().querySelectorAll('[data-turn-live-host]')).toHaveLength(0);
    // It follows the steps, as the foot line did.
    const blocks = [...turn().querySelectorAll('[data-slot="terminal-block"]')];
    const last = blocks.at(-1);
    expect(last && line && last.compareDocumentPosition(line)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('terminal: a reply streaming leaves the line at the turn’s foot', async () => {
    const { turn } = await renderSession(
      'terminal',
      {},
      {
        blocks: [...call('c1', 'List branches'), { id: 'tx', type: 'text', text: 'Six' }],
        running: true,
      }
    );
    expect(turn().querySelectorAll('[data-slot="turn-live-line"]')).toHaveLength(1);
    expect(turn().querySelectorAll('[data-turn-live-host]')).toHaveLength(0);
  });

  it('desktop: the live run carries the turn; no line of its own', async () => {
    const { turn } = await renderSession('desktop', {}, { blocks: RUNNING_CALL, running: true });
    expect(turn().querySelector('[data-slot="turn-live-line"]')).toBeNull();
    const host = turn().querySelector('[data-turn-live-host]');
    expect(host?.getAttribute('data-slot')).toBe('step-run');
    expect(host?.querySelector('summary')?.textContent).toContain('Run the tests');
  });

  it('desktop: with nothing live, the line of its own keeps its words', async () => {
    const { turn } = await renderSession(
      'desktop',
      {},
      { blocks: call('c1', 'List branches'), running: true }
    );
    const line = turn().querySelector('[data-slot="turn-live-line"]');
    expect(line?.textContent).toContain('Thinking');
    expect(line?.textContent).not.toContain('esc to interrupt');
    expect(line?.querySelector('[data-shape="star"]')).toBeNull();
    expect(turn().querySelectorAll('[data-turn-live-host]')).toHaveLength(0);
  });

  it('terminal: reads apart are steps apart, and the thinking is a ∴ line before them', async () => {
    const { turn } = await renderSession('terminal', {}, { blocks: LOOKS });
    const blocks = [...turn().querySelectorAll<HTMLElement>('[data-slot="terminal-block"]')];
    const words = blocks.map((block) => block.textContent ?? '');
    // ∴ thought, Read, Bash, Read, the reply.
    expect(blocks[0]?.querySelector('[data-slot="terminal-thought-mark"]')).not.toBeNull();
    expect(words[1]).toContain('Read(repo/a.ts)');
    expect(words[2]).toContain('Bash(List branches)');
    expect(words[3]).toContain('Read(repo/b.ts)');
    expect(words[4]).toContain('Done.');
    expect(turn().querySelector('[data-slot="turn-thinking-toggle"]')).toBeNull();
  });

  it('desktop: the stretch is one run that says its thinking first', async () => {
    const { turn } = await renderSession('desktop', {}, { blocks: LOOKS });
    const runs = turn().querySelectorAll('details[data-slot="step-run"]');
    expect(runs).toHaveLength(1);
    // Unmeasured here (no thinking events), so the thinking goes unsaid on the
    // line and sits inside, in place.
    expect(runs[0]?.querySelector('summary')?.textContent).toContain('Ran 1 command, read 2 files');
    expect(runs[0]?.textContent).toContain('Thought');
  });
});
