// @vitest-environment happy-dom
/**
 * Decision 208, desktop style, painted (user ruling 2026-11-03): each run of
 * steps is one muted line that opens to today's rows; special rows stay out of
 * runs; an unanswered card pins a run open. `stepRuns.test.ts` locks the words;
 * this locks the DOM and the open-state rules.
 */
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { useToolExpansionStore } from '@/stores/toolExpansion';
import { ToolGroup } from '../ToolRows';
import {
  type StepRunDisposition,
  StepRunDispositionContext,
  TranscriptStyleContext,
} from '../TranscriptBlocks';
import { deriveToolGroupRows, pairToolBlocks } from '../toolCard';
import { deriveStepRows } from '../turnSteps';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));

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

function call(id: string, toolName: string, toolInput: unknown): ChatBlock {
  return { id, type: 'tool_call', toolCallId: id, toolName, toolInput };
}
function done(id: string, output = 'ok'): ChatBlock {
  return { id: `${id}-r`, type: 'tool_result', toolCallId: id, toolOk: true, toolOutput: output };
}
function refused(id: string): ChatBlock {
  return {
    id: `${id}-r`,
    type: 'tool_result',
    toolCallId: id,
    toolOk: true,
    toolOutput: { content: [{ type: 'text', text: 'Stopped.' }], details: { refused: true } },
  };
}

/** Two runs around a todo list; the second run's command is still running. */
const BLOCKS: ChatBlock[] = [
  call('b1', 'Bash', { command: 'git status', description: '查看改动' }),
  done('b1'),
  call('r1', 'Read', { file_path: 'src/a.ts' }),
  done('r1', 'contents'),
  call('b2', 'Bash', { command: 'rm -rf x', description: '删除目录' }),
  refused('b2'),
  call('t1', 'TodoWrite', { todos: [{ content: 'clean up', status: 'pending' }] }),
  done('t1'),
  call('b3', 'Bash', { command: 'pnpm test', description: '跑测试' }),
];

async function render(disposition: StepRunDisposition = 'closed') {
  const rows = deriveStepRows(
    deriveToolGroupRows(
      pairToolBlocks(BLOCKS).map((run) => ({ kind: 'run' as const, run })),
      { t: zh }
    ),
    zh
  );
  await act(async () =>
    root.render(
      createElement(
        TranscriptStyleContext.Provider,
        { value: 'desktop' },
        createElement(
          StepRunDispositionContext.Provider,
          { value: disposition },
          createElement(ToolGroup, { rows, sessionId: 's' })
        )
      )
    )
  );
  const runs = [...container.querySelectorAll<HTMLDetailsElement>('details[data-slot="step-run"]')];
  return { runs };
}

describe('decision 208: desktop style runs', () => {
  it('a special row cuts the steps into two runs and stays outside both', async () => {
    const { runs } = await render();
    expect(runs).toHaveLength(2);
    const outside = [...container.querySelectorAll('.group\\/row')].filter(
      (row) => !row.closest('details')
    );
    expect(outside, 'the todo row is drawn on its own').toHaveLength(1);
  });

  it('a settled run reads as one line of counts, with its refusals in red', async () => {
    const { runs } = await render();
    const summary = runs[0]?.querySelector('summary');
    expect(summary?.textContent).toContain('运行了 2 条命令，读取了 1 个文件');
    const red = summary?.querySelector('.text-destructive');
    expect(red?.textContent).toBe('1 条被拒');
  });

  it('a run that is still working shows that call under the shimmer', async () => {
    const { runs } = await render();
    const shimmer = runs[1]?.querySelector('summary .text-shimmer');
    expect(shimmer?.textContent).toBe('Bash 跑测试');
  });

  it('starts closed, opens on a click, and remembers the click per session', async () => {
    const { runs } = await render();
    const first = runs[0] as HTMLDetailsElement;
    expect(first.open).toBe(false);
    // The rows inside are today's, mounted while closed (search and 定位 reach them).
    expect(first.querySelector('.group\\/row')).not.toBeNull();
    await act(async () => first.querySelector('summary')?.click());
    expect(first.open).toBe(true);
    const key = first.getAttribute('data-run-key');
    expect(useToolExpansionStore.getState().bySession.s?.[`group:${key}`]).toBe(true);
  });

  it('an unanswered card pins the runs open; a click does not close them', async () => {
    const { runs } = await render('forced');
    const first = runs[0] as HTMLDetailsElement;
    expect(first.open).toBe(true);
    await act(async () => first.querySelector('summary')?.click());
    expect(first.open).toBe(true);
  });

  it('a turn that did not finish starts open, and a click still closes it', async () => {
    const { runs } = await render('open');
    const first = runs[0] as HTMLDetailsElement;
    expect(first.open).toBe(true);
    await act(async () => first.querySelector('summary')?.click());
    expect(first.open).toBe(false);
  });
});

/**
 * Decision 208 (user ruling 2026-11-03): thinking sits in its run, where it
 * happened — said first on the run's line, as the CLI's collapsed group says
 * it, and a stretch of only thinking is the desktop app's 「思考了 N 秒 ›」,
 * opening straight to the text.
 */
describe('decision 208: desktop style thinking', () => {
  async function renderThinking(withCall: boolean) {
    const entries = [
      {
        kind: 'thinking' as const,
        block: { id: 'th1', type: 'thinking' as const, text: '先确认分支' },
        blockIndex: 0,
      },
      ...(withCall
        ? pairToolBlocks([
            call('b1', 'Bash', { command: 'git status', description: '查看改动' }),
            done('b1'),
          ]).map((run) => ({ kind: 'run' as const, run }))
        : []),
    ];
    const rows = deriveStepRows(
      deriveToolGroupRows(entries, { t: zh, thoughts: 'inPlace', thinkingDurationMs: () => 5_000 }),
      zh
    );
    await act(async () =>
      root.render(
        createElement(
          TranscriptStyleContext.Provider,
          { value: 'desktop' },
          createElement(ToolGroup, { rows, sessionId: 's' })
        )
      )
    );
    const runs = [
      ...container.querySelectorAll<HTMLDetailsElement>('details[data-slot="step-run"]'),
    ];
    expect(runs).toHaveLength(1);
    return runs[0] as HTMLDetailsElement;
  }

  it('a run says its thinking first, and opens to the thought in place', async () => {
    const run = await renderThinking(true);
    expect(run.querySelector('summary')?.textContent).toContain('思考了 5 秒，运行了 1 条命令');
    expect(run.open).toBe(false);
  });

  it('a stretch of only thinking is 「思考了 N 秒 ›」 and opens to the text itself', async () => {
    const run = await renderThinking(false);
    expect(run.querySelector('summary')?.textContent).toContain('思考了 5 秒');
    const body = run.querySelector('[data-slot="thinking-text"]');
    expect(body?.textContent).toContain('先确认分支');
    // No row inside to open a second time.
    expect(run.querySelector('[data-slot="collapsible-trigger"]')).toBeNull();
  });
});
