// @vitest-environment happy-dom
/**
 * The thought row a user can open and close — and that starts CLOSED.
 *
 * `toolCard.test.ts` locks the view model; this locks the paint. The shape
 * locked here is the 2026-09-23 user decision (thoughts start collapsed, a
 * click opens the whole text, and the preview's expand/collapse button goes):
 * no 200-character preview tier, no inline button, the whole row is the
 * trigger, and the expanded body is the complete text. Before this the row
 * always painted a preview (truncated, with an inline expand/collapse
 * button); before THAT a streaming thought painted bare live text with no
 * control at all (2026-09-19's complaint). Both shapes retired — the
 * "something is happening" signal lives at the turn head's live
 * "thinking N s" clause, which never depended on this row.
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

/**
 * Review 2026-09-24: opening a long thought while pinned to the bottom of a
 * streaming turn scrolled the row just clicked out of view.
 *
 * The follower (`MessageTimeline`'s ResizeObserver) treats a resize as a
 * disclosure only when the new height EQUALS the one `follow()` recorded in
 * the toggle's layout pass. Base UI's panel animated its height over 150ms
 * from `h-0`, so that record was the pre-animation height, every animation
 * frame missed it, and each was followed as new content. The fix takes the
 * height animation off the row panel, so the panel is at its final height in
 * the very commit `follow()` records.
 *
 * happy-dom has no layout and no transitions, so this asserts the two
 * preconditions rather than pixels: at the moment `follow()` runs, the body is
 * mounted and the panel carries none of the height-animation classes (the DOM
 * `className` is the real `cn()` merge with `COLLAPSIBLE_PANEL_BASE_CLASS`);
 * and a tool row reports its disclosure too, not only a thought.
 */
const ANIMATION_CLASSES = [
  'transition-[height]',
  'duration-150',
  'h-(--collapsible-panel-height)',
  'data-starting-style:h-0',
  'data-ending-style:h-0',
];

/** A thought and a settled bash row, under a follower that snapshots the open panel. */
async function renderFollowed() {
  const seen: { panelClass: string | null; bodyText: string | null }[] = [];
  const follow = vi.fn(() => {
    const panel = container.querySelector<HTMLElement>('[data-slot="collapsible-panel"]');
    seen.push({ panelClass: panel?.className ?? null, bodyText: panel?.textContent ?? null });
  });
  const rows = deriveToolGroupRows(
    [
      thought('th1', 'Weighing the two builds.'),
      {
        kind: 'run',
        run: {
          toolCallId: 'c1',
          blockId: 'c1',
          blockIndex: 1,
          toolName: 'bash',
          input: { command: 'pnpm build' },
          status: 'ok',
          output: 'BUILD_OUTPUT',
        },
      },
    ],
    { isStreamingBlockId: null }
  );
  await act(async () =>
    root.render(
      createElement(
        ThinkingFollowContext,
        { value: follow },
        createElement(ToolGroup, { rows, sessionId: SESSION })
      )
    )
  );
  const triggers = container.querySelectorAll<HTMLElement>('[data-slot="collapsible-trigger"]');
  expect(triggers).toHaveLength(2);
  const [thoughtTrigger, toolTrigger] = [...triggers];
  return { follow, seen, thoughtTrigger, toolTrigger };
}

it('a thought is recorded with its panel already at its final height', async () => {
  const { follow, seen, thoughtTrigger } = await renderFollowed();
  await act(async () => thoughtTrigger.click());
  expect(follow).toHaveBeenCalledTimes(1);
  expect(seen[0].bodyText, 'the body is mounted when the height is recorded').toContain(
    'Weighing the two builds.'
  );
  for (const token of ANIMATION_CLASSES) {
    expect(seen[0].panelClass?.split(' '), `panel still animates: ${token}`).not.toContain(token);
  }
});

it('a tool row reports its disclosure too, with the same final-height panel', async () => {
  const { follow, seen, toolTrigger } = await renderFollowed();
  // It used to open without telling the follower at all.
  await act(async () => toolTrigger.click());
  expect(follow, 'a tool row disclosure reports to the follower').toHaveBeenCalledTimes(1);
  expect(seen[0].bodyText).toContain('BUILD_OUTPUT');
  for (const token of ANIMATION_CLASSES) {
    expect(seen[0].panelClass?.split(' '), `panel still animates: ${token}`).not.toContain(token);
  }
  await act(async () => toolTrigger.click());
  expect(follow, 'and on the way closed').toHaveBeenCalledTimes(2);
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
