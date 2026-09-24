// @vitest-environment happy-dom
/**
 * N5 (devbox 2026-09-24), painted: a call that never did its work reads, in
 * the reader's language, as the request plus how it ended — 「等待子 Agent ·
 * 已拒绝」, 「列出子 Agent · 未执行」 — never as a completed operation, and a
 * never-started call is not painted as a failure.
 *
 * `runtimeToolVocabulary.test.ts` locks the view model; this locks the DOM.
 * The results are shaped exactly as the store keeps them from `tool.completed`:
 * `toolOutput` is the projector's `{ content, details }` object.
 */
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { useToolExpansionStore } from '@/stores/toolExpansion';
import { ToolGroup } from '../ToolRows';
import { deriveToolGroupRows, pairToolBlocks } from '../toolCard';

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

const REFUSED = 'Refused: TaskWait has nothing left to act on, and this run has already said so.';
const NOT_STARTED = 'The run ended before this call started.';

function call(id: string, toolName: string, toolInput: unknown): ChatBlock {
  return { id, type: 'tool_call', toolCallId: id, toolName, toolInput };
}

/** Blocks as the store holds them after the projector's `tool.completed`. */
const BLOCKS: ChatBlock[] = [
  call('w1', 'TaskWait', { delegationIds: [] }),
  {
    id: 'w1-result',
    type: 'tool_result',
    toolCallId: 'w1',
    toolOk: true,
    toolOutput: { content: [{ type: 'text', text: REFUSED }], details: { refused: true } },
  },
  call('l1', 'TaskList', {}),
  {
    id: 'l1-result',
    type: 'tool_result',
    toolCallId: 'l1',
    toolOk: false,
    toolOutput: { content: [{ type: 'text', text: NOT_STARTED }], details: { notStarted: true } },
    text: NOT_STARTED,
  },
  // Control: a real completion keeps its done-state words.
  call('s1', 'TaskStop', { delegationIds: [] }),
  {
    id: 's1-result',
    type: 'tool_result',
    toolCallId: 's1',
    toolOk: true,
    toolOutput: 'Stopped nothing.',
  },
];

async function renderRows() {
  const rows = deriveToolGroupRows(
    pairToolBlocks(BLOCKS).map((run) => ({ kind: 'run' as const, run })),
    { t: zh }
  );
  await act(async () => root.render(createElement(ToolGroup, { rows, sessionId: 's' })));
  const triggers = [
    ...container.querySelectorAll<HTMLElement>('[data-slot="collapsible-trigger"]'),
  ];
  const rowText = (tool: string) => {
    const found = [...container.querySelectorAll<HTMLElement>('.group\\/row')].find((row) =>
      row.textContent?.includes(tool)
    );
    expect(found, `a row for ${tool}`).toBeDefined();
    return found as HTMLElement;
  };
  return { triggers, rowText };
}

it('[N5-DOM-1] a refused call reads as the request plus 「已拒绝」, in the row’s ordinary tone', async () => {
  const { rowText } = await renderRows();
  const row = rowText(zh('Wait for subagents'));
  expect(row.textContent).toContain('等待子 Agent');
  expect(row.textContent).toContain('· 已拒绝');
  expect(row.textContent, 'no completed-tense verb').not.toContain('已等待子 Agent');
  expect(row.className).not.toContain('text-destructive');
});

it('[N5-DOM-2] a call the run ended before reads 「未执行」, not done and not red', async () => {
  const { rowText } = await renderRows();
  const row = rowText(zh('List subagents'));
  expect(row.textContent).toContain('列出子 Agent');
  expect(row.textContent).toContain('· 未执行');
  expect(row.textContent).not.toContain('已列出子 Agent');
  expect(row.className, 'nothing ran, so nothing failed').not.toContain('text-destructive');
  expect(row.textContent, 'the English runtime note is not painted').not.toContain(NOT_STARTED);
});

it('[N5-DOM-3] a call that really ran keeps its done-state words and no outcome word', async () => {
  const { rowText } = await renderRows();
  const row = rowText('已停止子 Agent');
  expect(row.querySelector('[data-slot="tool-row-outcome"]')).toBeNull();
});
