// @vitest-environment happy-dom
/**
 * Decision 208, terminal style, painted (user ruling 2026-11-03): each step is
 * a block with a coloured bullet, the tool's own English name with what it was
 * for in parentheses, and up to three `⎿` lines of what came of it.
 * `stepPresentation.test.ts` truth-tables the words; this locks the DOM.
 */
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { useToolExpansionStore } from '@/stores/toolExpansion';
import { ToolGroup } from '../ToolRows';
import { TranscriptStyleContext } from '../TranscriptBlocks';
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

const OUTPUT = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n');

function call(id: string, toolName: string, toolInput: unknown): ChatBlock {
  return { id, type: 'tool_call', toolCallId: id, toolName, toolInput };
}

const BLOCKS: ChatBlock[] = [
  call('b1', 'Bash', { command: 'git branch -vv', description: '列出所有本地分支' }),
  { id: 'b1-r', type: 'tool_result', toolCallId: 'b1', toolOk: true, toolOutput: OUTPUT },
  call('b2', 'Bash', { command: 'rm -rf dir', description: '删除残留目录' }),
  {
    id: 'b2-r',
    type: 'tool_result',
    toolCallId: 'b2',
    toolOk: true,
    toolOutput: {
      content: [{ type: 'text', text: 'The safety check stopped this call.' }],
      details: { refused: true },
    },
  },
  call('t1', 'TodoWrite', { todos: [{ content: 'clean up', status: 'pending' }] }),
  { id: 't1-r', type: 'tool_result', toolCallId: 't1', toolOk: true, toolOutput: 'ok' },
  // Still running: no result yet.
  call('b3', 'Bash', { command: 'pnpm test', description: '跑测试' }),
];

async function render() {
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
        { value: 'terminal' },
        createElement(ToolGroup, { rows, sessionId: 's' })
      )
    )
  );
  const blocks = [...container.querySelectorAll<HTMLElement>('[data-slot="terminal-block"]')];
  const blockOf = (text: string) => {
    const found = blocks.find((block) => block.textContent?.includes(text));
    expect(found, `a block reads ${text}`).toBeDefined();
    return found as HTMLElement;
  };
  return { blocks, blockOf };
}

describe('decision 208: terminal style steps', () => {
  it('every step is a block whose bullet says how the call went', async () => {
    const { blockOf } = await render();
    const done = blockOf('列出所有本地分支');
    expect(done.querySelector('[data-shape="bullet"]')?.getAttribute('data-status')).toBe(
      'success'
    );
    const refused = blockOf('删除残留目录');
    expect(refused.querySelector('[data-shape="bullet"]')?.getAttribute('data-status')).toBe(
      'failed'
    );
  });

  it('a step reads the tool in its own English name, with what it was for', async () => {
    const { blockOf } = await render();
    expect(blockOf('列出所有本地分支').textContent).toContain('Bash(列出所有本地分支)');
    // The 终端 / 运行 split is gone: a refused shell call is Bash too.
    expect(blockOf('删除残留目录').textContent).toContain('Bash(删除残留目录)');
  });

  it('a command shows its last three lines and opens to the rest', async () => {
    const { blockOf } = await render();
    const block = blockOf('列出所有本地分支');
    const result = block.querySelector<HTMLElement>('[data-slot="terminal-step-result"]');
    expect(result?.textContent).toContain('line 3\nline 4\nline 5');
    expect(result?.textContent).not.toContain('line 1');
    const more = [...block.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('… +2 lines')
    );
    expect(more, 'the English affordance').toBeDefined();
    await act(async () => more?.click());
    // Open, the body shows the whole output and the preview steps aside.
    expect(block.querySelector('[data-slot="terminal-step-result"]')).toBeNull();
    expect(block.textContent).toContain('line 1');
    expect(useToolExpansionStore.getState().bySession.s).toBeDefined();
  });

  it('a step still running blinks and says so under it, as the CLI does', async () => {
    const { blockOf } = await render();
    const block = blockOf('跑测试');
    expect(block.querySelector('[data-shape="bullet"]')?.getAttribute('data-status')).toBe(
      'running'
    );
    expect(block.querySelector('[data-slot="terminal-step-running"]')?.textContent).toContain(
      `${zh('Running')}…`
    );
  });

  it('a refusal says so once, on its `⎿` line', async () => {
    const { blockOf } = await render();
    const block = blockOf('删除残留目录');
    const said = zh('Refused');
    expect(block.textContent?.split(said).length).toBe(2);
    expect(block.querySelector('[data-slot="terminal-step-result"]')?.textContent).toContain(said);
  });

  it('a special row keeps its own drawing, in the text column with no bullet', async () => {
    const { blocks } = await render();
    const todo = blocks.find((block) => !block.textContent?.includes('Bash('));
    expect(todo, 'the todo list sits in a block').toBeDefined();
    expect(todo?.querySelector('[data-shape="bullet"]')).toBeNull();
  });

  it('a step is not drawn as the old row (only a special row keeps that drawing)', async () => {
    const { blockOf } = await render();
    for (const text of ['列出所有本地分支', '删除残留目录']) {
      expect(blockOf(text).querySelector('.group\\/row')).toBeNull();
    }
  });
});
