// @vitest-environment happy-dom
/**
 * dsh-rebase P1-7e (problems 20 and 21, decision 140), painted:
 *
 *  - a command Stop cut short opens onto what it printed before the stop
 *    (the window's last live tail), under 「· 已停止」, and never onto DSH's
 *    English `Error: tool call aborted` as if that were its output;
 *  - an output that lost its start opens on a whole line with 「已省略前 x KB」
 *    (bytes known) or 「已省略前面的输出」 (DSH's record does not say how much)
 *    above it.
 */
import { translate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { useToolExpansionStore } from '@/stores/toolExpansion';
import { useToolLiveOutputStore } from '@/stores/toolLiveOutput';
import { ToolGroup } from '../ToolRows';
import {
  deriveToolGroupRows,
  deriveToolRowView,
  pairToolBlocks,
  withStoppedOutput,
} from '../toolCard';
import { initialToolLiveOutput, reduceToolLiveOutput } from '../toolLiveOutputModel';
import { DSH_OUTPUT_TRUNCATED_MARKER } from '../toolOutputHead';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));

const ABORTED = 'Error: tool call aborted';
const SESSION = 's';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useToolExpansionStore.setState({ bySession: {} });
  useToolLiveOutputStore.setState({ ...initialToolLiveOutput });
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

/** A bash call Stop cut short, as the store keeps DSH's record of it. */
function stoppedBash(id: string): ChatBlock[] {
  return [
    call(id, 'bash', { command: 'sleep-tool 30', description: 'Run a long command' }),
    {
      id: `${id}-result`,
      type: 'tool_result',
      toolCallId: id,
      toolOk: false,
      toolOutput: { content: [{ type: 'text', text: ABORTED }], details: { stopped: true } },
      text: ABORTED,
    },
  ];
}

function finishedBash(id: string, output: string): ChatBlock[] {
  return [
    call(id, 'bash', { command: 'seq 4000' }),
    { id: `${id}-result`, type: 'tool_result', toolCallId: id, toolOk: true, toolOutput: output },
  ];
}

/** What the live fold keeps for a call after its tail and its stopped completion. */
function keepTail(
  toolCallId: string,
  tail: string,
  omittedBytes: number,
  sessionId = SESSION
): void {
  const events = [
    {
      type: 'tool.output',
      seq: 1,
      timestamp: 1,
      sessionId,
      payload: {
        messageId: 'm',
        toolCallId,
        jobId: 'bash-1',
        tail,
        omittedBytes,
        totalBytes: omittedBytes + tail.length,
      },
    },
    {
      type: 'tool.completed',
      seq: 2,
      timestamp: 2,
      sessionId,
      payload: {
        messageId: 'm',
        toolCallId,
        ok: false,
        output: { content: [{ type: 'text', text: ABORTED }], details: { stopped: true } },
        error: ABORTED,
      },
    },
  ] as RuntimeEvent[];
  const state = events.reduce(reduceToolLiveOutput, useToolLiveOutputStore.getState());
  useToolLiveOutputStore.setState({
    byCall: state.byCall,
    order: state.order,
    stopped: state.stopped,
    stoppedOrder: state.stoppedOrder,
  });
}

async function renderAndOpen(blocks: ChatBlock[]) {
  const rows = deriveToolGroupRows(
    pairToolBlocks(blocks).map((run) => ({ kind: 'run' as const, run })),
    { t: zh }
  );
  await act(async () => root.render(createElement(ToolGroup, { rows, sessionId: SESSION })));
  const trigger = container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]');
  if (trigger) await act(async () => trigger.click());
  return container;
}

describe('deriveToolRowView / withStoppedOutput', () => {
  it('[E2B-20-VIEW] DSH’s sentence for the stop is no body; the kept tail becomes one', () => {
    const [run] = pairToolBlocks(stoppedBash('b1'));
    if (!run) throw new Error('no run');
    const view = deriveToolRowView(run, { t: zh });
    expect(view.outcome).toBe('stopped');
    expect(view.output).toBeUndefined();
    expect(view.body).toBeUndefined();
    // The command itself still opens.
    expect(view.expandable).toBe(true);
    const kept = withStoppedOutput(view, {
      text: 'half\nsleep-tool c5 started\n',
      omittedBytes: 2048,
    });
    expect(kept).toMatchObject({
      body: 'output',
      output: 'sleep-tool c5 started\n',
      outputHeadOmitted: { bytes: 2048 + 5 },
      expandable: true,
    });
    expect(withStoppedOutput(view, { text: 'started\n', omittedBytes: 0 })).not.toHaveProperty(
      'outputHeadOmitted'
    );
    // Nothing kept, or a row that is not a stopped one: unchanged.
    expect(withStoppedOutput(view, undefined)).toBe(view);
    const [done] = pairToolBlocks(finishedBash('b2', 'ok\n'));
    if (!done) throw new Error('no run');
    const doneView = deriveToolRowView(done, { t: zh });
    expect(withStoppedOutput(doneView, { text: 'x', omittedBytes: 0 })).toBe(doneView);
  });

  it('[E2B-21-VIEW] DSH’s tail-only record of stdout starts on a whole line and is marked cut', () => {
    const recorded = `ll-line 612 d2\nline 613 d2${DSH_OUTPUT_TRUNCATED_MARKER}/tmp/spill/stdout]`;
    const [run] = pairToolBlocks(finishedBash('b3', recorded));
    if (!run) throw new Error('no run');
    const view = deriveToolRowView(run, { t: zh });
    expect(view.output?.startsWith('line 613 d2')).toBe(true);
    expect(view.outputHeadOmitted).toEqual({});
    // A read tool's output is not a shell's: left as it came.
    const [read] = pairToolBlocks([
      call('r1', 'read', { file_path: 'a.txt' }),
      {
        id: 'r1-result',
        type: 'tool_result',
        toolCallId: 'r1',
        toolOk: true,
        toolOutput: recorded,
      },
    ]);
    if (!read) throw new Error('no run');
    expect(deriveToolRowView(read, { t: zh })).not.toHaveProperty('outputHeadOmitted');
  });
});

describe('painted', () => {
  it('[E2B-20-DOM] a stopped command opens onto what it printed, with no English error', async () => {
    keepTail('b1', 'sleep-tool c5 started\n', 0);
    const view = await renderAndOpen(stoppedBash('b1'));
    const row = view.querySelector<HTMLElement>('.group\\/row');
    expect(row?.querySelector('[data-slot="tool-row-outcome"]')?.textContent).toContain('· 已停止');
    expect(view.textContent).toContain('sleep-tool 30');
    expect(view.textContent).toContain('sleep-tool c5 started');
    expect(view.textContent).not.toContain(ABORTED);
    expect(view.querySelector('[data-testid="tool-output-head-omitted"]')).toBeNull();
  });

  it('[E2B-20-DOM-NONE] with nothing kept (another run), the stop is said once and no sentence stands in', async () => {
    const view = await renderAndOpen(stoppedBash('b9'));
    expect(view.textContent).toContain('sleep-tool 30');
    expect(view.textContent).toContain('· 已停止');
    expect(view.textContent).not.toContain(ABORTED);
  });

  it('[E2B-20-DOM-OTHER-CHAT] another chat’s kept tail under the same call id is not shown', async () => {
    keepTail('b1', 'not mine\n', 0, 'other');
    const view = await renderAndOpen(stoppedBash('b1'));
    expect(view.textContent).not.toContain('not mine');
  });

  it('[E2B-21-DOM-BYTES] a kept tail read from an offset opens on a whole line under 「已省略前 x KB」', async () => {
    keepTail('b1', 'ne 611\nline 612\nline 613\n', 3 * 1024);
    const view = await renderAndOpen(stoppedBash('b1'));
    const note = view.querySelector('[data-testid="tool-output-head-omitted"]');
    expect(note?.textContent).toBe('已省略前 3 KB');
    expect(view.textContent).toContain('line 612');
    expect(view.textContent).not.toContain('ne 611');
    // The note is above the output.
    const pre = [...view.querySelectorAll('pre')].find((node) =>
      node.textContent?.includes('line 612')
    );
    expect(pre).toBeDefined();
    expect(
      note && pre ? note.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING : 0
    ).toBeTruthy();
  });

  it('[E2B-21-DOM-UNKNOWN] DSH’s tail-only record says 「已省略前面的输出」 above its first whole line', async () => {
    const recorded = `ll-line 612 d2\nline 613 d2${DSH_OUTPUT_TRUNCATED_MARKER}/tmp/spill/stdout]`;
    const view = await renderAndOpen(finishedBash('b3', recorded));
    expect(view.querySelector('[data-testid="tool-output-head-omitted"]')?.textContent).toBe(
      '已省略前面的输出'
    );
    expect(view.textContent).toContain('line 613 d2');
    expect(view.textContent).not.toContain('ll-line 612');
  });
});
