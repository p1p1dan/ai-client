// @vitest-environment happy-dom
/**
 * The thought a user can actually read — and put away — WHILE the model thinks.
 *
 * `toolCard.test.ts` locks the view model; this locks the paint. The two are
 * separate because the bug this covers lived in the gap between them: the
 * store held the thinking text the whole time, the row builder saw it, and the
 * renderer still put nothing on screen for the 12-20s a turn spends thinking —
 * `showBody` was gated on `!streaming`, so the text only became reachable once
 * the thought was over, behind a chevron the reader had to find and click.
 *
 * The fix for that shipped a row with the opposite problem: text visible, no
 * control at all, on the argument that "a row whose content is still arriving
 * must not offer a toggle whose state would be meaningless a second later".
 * The user's answer (2026-09-19) is that a 40-second think is exactly when the
 * toggle is worth having. So a streaming thought is now an ordinary expandable
 * row that starts open, and what these assert is the pair that argument missed:
 * the text is there without a click, AND the reader can fold it away —
 * mid-stream, with deltas still landing, and the fold outlives the moment the
 * thought settles.
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

async function clickTrigger() {
  const node = trigger();
  expect(node, 'no trigger to click').not.toBeNull();
  await act(async () => node?.click());
}

it('shows short thoughts without a control that can hide them', async () => {
  await streamThought('Checking the model catalog first.');
  expect(container.textContent).toContain('Checking the model catalog first.');
  expect(container.querySelector('[data-slot="thinking-header"]')).toBeNull();
  expect(container.querySelector('[data-slot="collapsible-trigger"]')).toBeNull();
});

it('removes all blank lines for display without changing nonblank indentation', async () => {
  const raw = '\n \r\nfirst\n\t\n  second\r\n\r\nthird\n';
  await streamThought(raw);
  expect(container.querySelector('[data-slot="thinking-text"]')?.textContent).toBe(
    'first\n  second\nthird'
  );
  await streamThought(`${raw}fourth`);
  expect(container.querySelector('[data-slot="thinking-text"]')?.textContent).toBe(
    'first\n  second\nthird\nfourth'
  );
});

it('the heading and inline button share full/preview state without hiding the preview', async () => {
  const text = '思'.repeat(240);
  await streamThought(text);
  const header = container.querySelector<HTMLButtonElement>('[data-slot="thinking-header"]');
  const button = container.querySelector<HTMLButtonElement>(
    '[data-slot="thinking-preview-toggle"]'
  );
  expect(button?.parentElement?.tagName).toBe('P');
  await act(async () => header?.click());
  expect(container.querySelector('[data-slot="thinking-text"]')?.textContent).toBe(text);
  expect(button?.getAttribute('aria-expanded')).toBe('true');
  await act(async () => button?.click());
  expect(container.querySelector('[data-slot="thinking-text"]')?.textContent).toBe(
    `${'思'.repeat(200)}…`
  );
  expect(header?.getAttribute('aria-expanded')).toBe('false');
  await settleThought(text);
  expect(container.querySelector('[data-slot="thinking-text"]')?.textContent).toBe(
    `${'思'.repeat(200)}…`
  );
});

it('blank lines do not consume the preview budget', async () => {
  await streamThought(`\n${'\n \n'.repeat(100)}${'思'.repeat(200)}\n`);
  expect(container.querySelector('[data-slot="thinking-text"]')?.textContent).toBe(
    '思'.repeat(200)
  );
  expect(container.querySelector('[data-slot="thinking-preview-toggle"]')).toBeNull();
});

it('limits the preview to 200 Unicode characters and streams the full text after a click', async () => {
  const preview = '想😀'.repeat(100);
  await streamThought(preview);
  expect(container.querySelector('[data-slot="thinking-text"]')?.textContent).toBe(preview);
  await streamThought(`${preview}隐藏的尾部`);
  expect(container.querySelector('[data-slot="thinking-text"]')?.textContent).toBe(`${preview}…`);
  const expand = container.querySelector<HTMLButtonElement>(
    '[data-slot="thinking-preview-toggle"][aria-expanded="false"]'
  );
  expect(expand?.textContent).toBe('Expand');
  await act(async () => expand?.click());
  expect(container.querySelector('[data-slot="thinking-text"]')?.textContent).toBe(
    `${preview}隐藏的尾部`
  );
  await streamThought(`${preview}隐藏的尾部继续输出`);
  expect(container.querySelector('[data-slot="thinking-text"]')?.textContent).toBe(
    `${preview}隐藏的尾部继续输出`
  );
  await settleThought(`${preview}隐藏的尾部继续输出`);
  expect(container.querySelector('[data-slot="thinking-text"]')?.textContent).toBe(
    `${preview}隐藏的尾部继续输出`
  );
  expect(container.querySelector('p')?.className).not.toContain('overflow');
  const collapse = container.querySelector<HTMLButtonElement>(
    '[data-slot="thinking-preview-toggle"][aria-expanded="true"]'
  );
  await act(async () => collapse?.click());
  expect(container.querySelector('[data-slot="thinking-text"]')?.textContent).toBe(`${preview}…`);
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
  const expand = container.querySelector<HTMLButtonElement>(
    '[data-slot="thinking-preview-toggle"]'
  );
  await act(async () => expand?.click());
  expect(follow).toHaveBeenCalledTimes(1);
  await act(async () => expand?.click());
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
