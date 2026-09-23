// @vitest-environment happy-dom
/**
 * The thought row a user can open and close — and that starts CLOSED.
 *
 * `toolCard.test.ts` locks the view model; this locks the paint. The shape
 * locked here is the 2026-09-23 user decision 「思考默认折叠，点击后展开所有
 * 内容，去掉预览的展开/收起按钮」: no 200-character preview tier, no inline
 * button, the whole row is the trigger, and the expanded body is the complete
 * text. Before this the row always painted a preview (truncated with an
 * inline 展开/收起 button); before THAT a streaming thought painted bare live
 * text with no control at all (2026-09-19's complaint). Both shapes retired —
 * the "something is happening" signal lives at the turn head's live
 * 「思考 N 秒」 clause, which never depended on this row.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import { useToolExpansionStore } from '@/stores/toolExpansion';
import { initialSubagentActivity, type SubagentLane } from '../subagentActivityModel';
import { ThinkingFollowContext, ToolGroup } from '../ToolRows';
import { deriveToolGroupRows, deriveToolRowView, type ToolGroupEntry } from '../toolCard';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function thought(id: string, text: string): ToolGroupEntry {
  return { kind: 'thinking', block: { id, type: 'thinking', text }, blockIndex: 0 };
}

/** The session scope the expand memory is keyed by — without one, nothing is remembered. */
const SESSION = 'session-under-test';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // The memory is a module-level store: a choice made by one case would
  // otherwise seed the next one's rows.
  useToolExpansionStore.setState({ bySession: {} });
  useSubagentActivityStore.setState(initialSubagentActivity);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(rows: ReturnType<typeof deriveToolGroupRows>) {
  await act(async () => root.render(createElement(ToolGroup, { rows, sessionId: SESSION })));
}

/** One streaming render of a single thought block. */
async function streamThought(text: string) {
  await render(deriveToolGroupRows([thought('th1', text)], { isStreamingBlockId: 'th1' }));
}

/** The same block after `message.completed` — nothing is streaming any more. */
async function settleThought(text: string) {
  await render(deriveToolGroupRows([thought('th1', text)], { isStreamingBlockId: null }));
}

function trigger(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]');
}

function thoughtText(): string | null {
  return container.querySelector<HTMLElement>('[data-slot="thinking-text"]')?.textContent ?? null;
}

async function clickTrigger() {
  const node = trigger();
  expect(node, 'no trigger to click').not.toBeNull();
  await act(async () => node?.click());
}

it('mounts collapsed — no preview, no button, the row itself is the trigger', async () => {
  await streamThought('Checking the model catalog first.');
  // The 200-char preview tier and its inline toggle are both gone; a short
  // thought is behind the same click as a long one.
  expect(container.querySelector('[data-slot="thinking-header"]')).toBeNull();
  expect(container.querySelector('[data-slot="thinking-preview-toggle"]')).toBeNull();
  expect(thoughtText()).toBeNull();
  expect(trigger()).not.toBeNull();
  await clickTrigger();
  expect(thoughtText()).toBe('Checking the model catalog first.');
});

it('removes all blank lines for display without changing nonblank indentation', async () => {
  const raw = '\n \r\nfirst\n\t\n  second\r\n\r\nthird\n';
  await streamThought(raw);
  await clickTrigger();
  expect(thoughtText()).toBe('first\n  second\nthird');
  await streamThought(`${raw}fourth`);
  expect(thoughtText()).toBe('first\n  second\nthird\nfourth');
});

it('the full text renders with no length cap and keeps streaming while open', async () => {
  const text = '思'.repeat(240);
  await streamThought(text);
  expect(thoughtText()).toBeNull();
  await clickTrigger();
  expect(thoughtText()).toBe(text);
  // Deltas keep landing in the OPEN body — expanding mid-stream is how a
  // reader watches a long think happen.
  await streamThought(`${text}tail`);
  expect(thoughtText()).toBe(`${text}tail`);
  await settleThought(`${text}tail`);
  expect(thoughtText()).toBe(`${text}tail`);
  // No inner height limit: decision 038's page-level full-text flow.
  expect(container.querySelector('p')?.className).not.toContain('overflow');
  // And folding it back is the same click.
  await clickTrigger();
  expect(thoughtText()).toBeNull();
});

it('an empty thought stays a bare row — nothing to read, nothing to open', async () => {
  await streamThought('');
  expect(trigger()).toBeNull();
  expect(thoughtText()).toBeNull();
});

it('both disclosure directions preserve the reading position instead of requesting a bottom jump', async () => {
  const follow = vi.fn();
  const rows = deriveToolGroupRows([thought('th1', '思'.repeat(240))], {
    isStreamingBlockId: 'th1',
  });
  await act(async () =>
    root.render(
      createElement(
        ThinkingFollowContext,
        { value: follow },
        createElement(ToolGroup, { rows, sessionId: SESSION })
      )
    )
  );
  await clickTrigger();
  expect(follow).toHaveBeenCalledTimes(1);
  await clickTrigger();
  expect(follow).toHaveBeenCalledTimes(2);
});

it('merges the delegate and agent headers, starts closed and reveals operations with one click', async () => {
  const lane: SubagentLane = {
    parentToolCallId: 'task1',
    sessionId: SESSION,
    agentId: 'agent1',
    agentType: 'explore',
    description: 'inspect files',
    status: 'running',
    rows: [
      {
        kind: 'tool',
        toolCallId: 'read1',
        name: 'read',
        input: { path: '/tmp/example.ts' },
        status: 'ok',
      },
    ],
    droppedRows: 0,
    progress: null,
    usage: null,
    report: null,
    pendingPermission: null,
    capped: false,
    ordinal: 0,
  };
  useSubagentActivityStore.setState({ lanes: { task1: lane } });
  const row = deriveToolRowView({
    toolCallId: 'task1',
    blockId: 'task-block',
    blockIndex: 0,
    toolName: 'Task',
    input: { description: 'inspect files', subagent_type: 'explore' },
    status: 'running',
  });
  await render([row]);
  expect(container.textContent).toContain('explore');
  expect(container.textContent).not.toContain('Subagent');
  expect(container.textContent).not.toContain('example.ts');
  expect(container.querySelectorAll('[data-slot="collapsible-trigger"]')).toHaveLength(1);
  await clickTrigger();
  expect(container.textContent).toContain('example.ts');
  expect(container.textContent).not.toContain('Subagent');
  await act(async () =>
    useSubagentActivityStore.setState({ lanes: { task1: { ...lane, status: 'completed' } } })
  );
  expect(container.textContent).toContain('example.ts');
});
