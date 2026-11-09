// @vitest-environment happy-dom
/**
 * Decision 211 (user, 2026-11-09): a running turn says what it is doing ONCE —
 * on its live row (`∴ Thinking… (10m 37s · esc 中断)`, `Bash(跑测试) (…)`, the
 * desktop run's words then `10m 37s`), or on a line of its own when no row is
 * live. The turn's last tool group decides; this locks its DOM and the pure
 * pickers it decides with.
 */
import { translate } from '@shared/i18n';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { useToolExpansionStore } from '@/stores/toolExpansion';
import type { TurnItem } from '../chatTurn';
import { partitionStepRuns } from '../stepRuns';
import { ToolGroup } from '../ToolRows';
import { TranscriptStyleContext } from '../TranscriptBlocks';
import { deriveToolGroupRows, groupTimeline, type ToolRowView } from '../toolCard';
import {
  liveRowHostIndex,
  liveRunHostIndex,
  replyStreaming,
  type TurnLiveClock,
  TurnLiveClockContext,
  TurnLiveLine,
  TurnLiveSlotContext,
  turnLiveClockOf,
} from '../turnLiveStatus';
import { deriveStepRows } from '../turnSteps';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));

/** What a turn 10m 37s in, waiting on the model, says (the real wording). */
const LIVE: TurnLiveClock = turnLiveClockOf(
  zh,
  { kind: 'thinking', promptChars: 0 },
  { minutes: 10, seconds: 37 }
);

it('[D211-WORDS] the words a waiting turn says, in Chinese: English verbs, Chinese stop key', () => {
  expect(LIVE).toEqual({
    activity: 'Thinking…',
    tail: '(10m 37s · esc 中断)',
    line: 'Thinking… 10m 37s',
    clock: '10m 37s',
  });
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useToolExpansionStore.setState({ bySession: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const call = (id: string, toolName: string, toolInput: unknown): ChatBlock => ({
  id,
  type: 'tool_call',
  toolCallId: id,
  toolName,
  toolInput,
});
const done = (id: string): ChatBlock => ({
  id: `${id}-r`,
  type: 'tool_result',
  toolCallId: id,
  toolOk: true,
  toolOutput: 'ok',
});
const thought = (id: string): ChatBlock => ({ id, type: 'thinking', text: 'Weighing it up.' });

/** One message's blocks as the timeline's step rows, `streaming` the block still streaming. */
function rowsOf(
  blocks: ChatBlock[],
  options: { streaming?: string; merge?: 'adjacent' | 'stretch' } = {}
): ToolRowView[] {
  const message: ChatMessage = { id: 'a', sessionId: 's', role: 'assistant', blocks };
  const group = groupTimeline(message).find((item) => item.kind === 'toolGroup');
  if (!group || group.kind !== 'toolGroup') throw new Error('no tool group');
  return deriveStepRows(
    deriveToolGroupRows(group.entries, {
      t: zh,
      isStreamingBlockId: options.streaming ?? null,
      thoughts: 'inPlace',
    }),
    zh,
    { merge: options.merge ?? 'adjacent' }
  );
}

async function render(
  rows: ToolRowView[],
  options: { style?: 'terminal' | 'desktop'; slot?: boolean; live?: TurnLiveClock | null } = {}
) {
  const slot = options.slot ?? true;
  const tree: ReactNode = createElement(
    TranscriptStyleContext.Provider,
    { value: options.style ?? 'terminal' },
    createElement(
      TurnLiveSlotContext.Provider,
      { value: slot },
      createElement(
        TurnLiveClockContext.Provider,
        { value: options.live === undefined ? LIVE : options.live },
        createElement(ToolGroup, { rows, sessionId: 's' })
      )
    )
  );
  await act(async () => root.render(tree));
}

const lines = () => container.querySelectorAll('[data-slot="turn-live-line"]');
const tails = () => container.querySelectorAll('[data-slot="turn-live-tail"]');
const hosts = () => container.querySelectorAll('[data-turn-live-host]');

describe('[D211-PICK] which row carries the running turn', () => {
  it('the newest live thought or step', () => {
    const rows = rowsOf([thought('th1'), call('b1', 'Bash', { command: 'pnpm test' })]);
    expect(rows.map((row) => row.running)).toEqual([false, true]);
    expect(liveRowHostIndex(rows)).toBe(1);
    expect(liveRowHostIndex(rowsOf([thought('th1')], { streaming: 'th1' }))).toBe(0);
  });

  it('none when nothing is live', () => {
    expect(liveRowHostIndex(rowsOf([call('b1', 'Bash', { command: 'ls' }), done('b1')]))).toBe(-1);
    expect(liveRowHostIndex([])).toBe(-1);
  });

  it('none when the newest live row keeps its own drawing (a todo list)', () => {
    const rows = rowsOf([
      call('b1', 'Bash', { command: 'pnpm test' }),
      call('t1', 'TodoWrite', { todos: [{ content: 'clean up', status: 'pending' }] }),
    ]);
    expect(rows.map((row) => row.running)).toEqual([true, true]);
    expect(liveRowHostIndex(rows)).toBe(-1);
  });

  it('desktop: the newest run with a live step, by the same rule', () => {
    const live = rowsOf([thought('th1'), call('b1', 'Bash', { command: 'pnpm test' })], {
      merge: 'stretch',
    });
    expect(liveRunHostIndex(partitionStepRuns(live))).toBe(0);
    const todoLast = rowsOf(
      [
        call('b1', 'Bash', { command: 'pnpm test' }),
        call('t1', 'TodoWrite', { todos: [{ content: 'clean up', status: 'pending' }] }),
      ],
      { merge: 'stretch' }
    );
    expect(liveRunHostIndex(partitionStepRuns(todoLast))).toBe(-1);
  });
});

describe('[D211-TERM] terminal style: the status is said once', () => {
  it('a thought streaming: ✻ Thinking… (10m 37s · esc 中断), and no line of its own', async () => {
    await render(rowsOf([thought('th1')], { streaming: 'th1' }));
    expect(lines()).toHaveLength(0);
    expect(tails()).toHaveLength(1);
    const host = hosts()[0];
    expect(host?.textContent).toContain('Thinking… (10m 37s · esc 中断)');
    // It reads as the line of its own did: the working star and the brand ink…
    expect(host?.querySelector('[data-shape="star"][data-status="running"]')).not.toBeNull();
    expect(host?.querySelector('[data-slot="terminal-thought-mark"]')).toBeNull();
    // (The star is in the brand ink too; the line is the upright one.)
    const words = host?.querySelector('.text-primary.not-italic');
    expect(words?.textContent).toContain('Thinking…');
    expect(words?.className).toContain('not-italic');
    // …with the tail in the faint ink, upright.
    const tail = host?.querySelector('[data-slot="turn-live-tail"]');
    expect(tail?.className).toContain('text-foreground-faint');
    expect(tail?.className).toContain('not-italic');
  });

  it('a step running: the tail closes its head line, above `⎿ Running…`', async () => {
    await render(rowsOf([call('b1', 'Bash', { command: 'pnpm test', description: '跑测试' })]));
    expect(lines()).toHaveLength(0);
    const host = hosts()[0];
    expect(host?.textContent).toContain('Bash(跑测试)');
    const tail = host?.querySelector('[data-slot="turn-live-tail"]');
    expect(tail?.textContent).toBe(' (10m 37s · esc 中断)');
    const running = host?.querySelector('[data-slot="terminal-step-running"]');
    expect(running && tail?.compareDocumentPosition(running)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(host?.querySelector('[data-shape="star"][data-status="running"]')).not.toBeNull();
    expect(host?.querySelector('[data-shape="bullet"]')).toBeNull();
    // The tool's name and what it is for take the brand ink; the result lines do not.
    const label = [...(host?.querySelectorAll('.text-primary') ?? [])].map((el) => el.textContent);
    expect(label.join(' ')).toContain('Bash');
    expect(label.join(' ')).toContain('跑测试');
    expect(running?.className).not.toContain('text-primary');
  });

  it('a step that is running but not the host keeps its own blinking dot', async () => {
    await render(
      rowsOf([
        call('b1', 'Bash', { command: 'pnpm build', description: '构建' }),
        call('b2', 'Bash', { command: 'pnpm lint', description: '检查' }),
      ])
    );
    const blocks = [...container.querySelectorAll('[data-slot="terminal-block"]')];
    expect(blocks[0]?.querySelector('[data-shape="bullet"][data-status="running"]')).not.toBeNull();
    expect(blocks[0]?.querySelector('.text-primary')).toBeNull();
    expect(blocks[1]?.hasAttribute('data-turn-live-host')).toBe(true);
  });

  it('only the newest of two live steps carries it', async () => {
    await render(
      rowsOf([
        call('b1', 'Bash', { command: 'pnpm build', description: '构建' }),
        call('b2', 'Bash', { command: 'pnpm lint', description: '检查' }),
      ])
    );
    expect(tails()).toHaveLength(1);
    expect(hosts()[0]?.textContent).toContain('Bash(检查)');
  });

  it('nothing live: the line of its own, after the steps', async () => {
    await render(rowsOf([call('b1', 'Bash', { command: 'ls' }), done('b1')]));
    expect(tails()).toHaveLength(0);
    expect(hosts()).toHaveLength(0);
    const line = lines()[0];
    expect(lines()).toHaveLength(1);
    expect(line?.textContent).toBe('Thinking… (10m 37s · esc 中断)');
    expect(line?.querySelector('[data-shape="star"][data-status="running"]')).not.toBeNull();
    const step = container.querySelector('[data-slot="terminal-block"]');
    expect(step && line && step.compareDocumentPosition(line)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('a live todo list keeps its drawing, and the line follows it', async () => {
    await render(
      rowsOf([call('t1', 'TodoWrite', { todos: [{ content: 'clean up', status: 'pending' }] })])
    );
    expect(tails()).toHaveLength(0);
    expect(lines()).toHaveLength(1);
  });

  it('a group that is not the turn’s last says nothing about the turn', async () => {
    await render(rowsOf([thought('th1')], { streaming: 'th1' }), { slot: false });
    expect(lines()).toHaveLength(0);
    expect(tails()).toHaveLength(0);
    expect(hosts()).toHaveLength(0);
    expect(container.textContent).toContain('Thinking…');
    expect(container.textContent).not.toContain('esc');
    // The dim `∴`, as every thought is drawn.
    expect(container.querySelector('[data-slot="terminal-thought-mark"]')).not.toBeNull();
    expect(container.querySelector('[data-shape="star"]')).toBeNull();
  });

  it('a settled turn (no words) draws no tail, even on a live-looking row', async () => {
    await render(rowsOf([thought('th1')], { streaming: 'th1' }), { live: null });
    expect(tails()).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });

  it('an empty last group still says it, on a line of its own', async () => {
    await render([]);
    expect(lines()).toHaveLength(1);
  });

  it('a group nested in the rows is never the slot', async () => {
    // A desktop run nests today's rows in a `ToolGroup` of its own, mounted
    // even while closed: the run carries the clock, and the rows inside say
    // nothing again.
    await render(rowsOf([call('b1', 'Bash', { command: 'pnpm test' })]), { style: 'desktop' });
    expect(hosts()).toHaveLength(1);
    expect(tails()).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });
});

describe('[D211-DESK] desktop style: the live run carries the clock', () => {
  it('the run’s live words, then 10m 37s', async () => {
    await render(rowsOf([call('b1', 'Bash', { command: 'pnpm test', description: '跑测试' })]), {
      style: 'desktop',
    });
    expect(lines()).toHaveLength(0);
    const host = hosts()[0];
    expect(host?.getAttribute('data-slot')).toBe('step-run');
    const summary = host?.querySelector('summary');
    // The desktop app's live line: a spinner, the words, then the turn's clock.
    const parts = [...(summary?.children ?? [])];
    expect(parts[0]?.getAttribute('data-status')).toBe('running');
    expect(parts[1]?.className).toContain('text-shimmer');
    expect(parts[1]?.textContent).toContain('跑测试');
    expect(parts[2]?.getAttribute('data-slot')).toBe('turn-live-clock');
    expect(parts[2]?.textContent).toBe('10m 37s');
  });

  it('nothing live: `Thinking… 10m 37s` on a line of its own, after the running icon', async () => {
    await render(rowsOf([call('b1', 'Bash', { command: 'ls' }), done('b1')]), {
      style: 'desktop',
    });
    expect(hosts()).toHaveLength(0);
    expect(lines()[0]?.textContent).toBe('Thinking… 10m 37s');
    expect(lines()[0]?.querySelector('[data-status="running"]')).not.toBeNull();
  });

  it('no clock measured: the run keeps its words and adds nothing', async () => {
    await render(rowsOf([call('b1', 'Bash', { command: 'pnpm test' })]), {
      style: 'desktop',
      live: { ...LIVE, clock: null },
    });
    expect(hosts()).toHaveLength(1);
    expect(container.querySelector('[data-slot="turn-live-clock"]')).toBeNull();
  });
});

describe('[D211-REPLY] while the reply streams in, no line at all', () => {
  const text = (id: string, body: string): TurnItem => ({
    kind: 'text',
    messageId: 'a',
    blockIndex: 0,
    block: { id, type: 'text', text: body },
  });

  it('only for text still streaming that already shows something', () => {
    expect(replyStreaming(text('t1', 'Six branches'), 't1')).toBe(true);
    // Finished: the turn is between steps again, and the line comes back.
    expect(replyStreaming(text('t1', 'Six branches'), null)).toBe(false);
    // Nothing on screen yet: the line still says the turn is alive.
    expect(replyStreaming(text('t1', '  '), 't1')).toBe(false);
    expect(replyStreaming(undefined, 't1')).toBe(false);
  });
});

describe('[D211-LINE] the line of its own', () => {
  it('takes its words from a prop at the turn’s foot', async () => {
    await act(async () =>
      root.render(
        createElement(
          TranscriptStyleContext.Provider,
          { value: 'terminal' },
          createElement(TurnLiveLine, { live: LIVE })
        )
      )
    );
    expect(lines()[0]?.textContent).toBe('Thinking… (10m 37s · esc 中断)');
  });

  it('draws nothing without words', async () => {
    await act(async () => root.render(createElement(TurnLiveLine, {})));
    expect(lines()).toHaveLength(0);
  });
});
