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
import { useToolExpansionStore } from '@/stores/toolExpansion';
import { ToolGroup } from '../ToolRows';
import { deriveToolGroupRows, type ToolGroupEntry } from '../toolCard';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function thought(id: string, text: string): ToolGroupEntry {
  return { kind: 'thinking', block: { id, type: 'thinking', text }, blockIndex: 0 };
}

/** The session scope the expand memory is keyed by — without one, nothing is remembered. */
const SESSION = 'session-under-test';

/**
 * The `data-slot` `ToolRows.tsx` looks for when it re-anchors a folded header.
 * Spelled here as the same literal the component uses, because the whole point
 * of the T096 cases below is that the lookup finds a real scroll surface.
 */
const SCROLL_SURFACE_SLOT = 'scroll-area-viewport';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // The memory is a module-level store: a choice made by one case would
  // otherwise seed the next one's rows.
  useToolExpansionStore.setState({ bySession: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  // T096's cases re-home `container` inside a stand-in scroll surface; the
  // surface outlives `container.remove()` and would be found by the next case's
  // `closest()` lookup if it were left in the document.
  document.querySelector(`[data-slot="${SCROLL_SURFACE_SLOT}"]`)?.remove();
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

it('shows the thought text while it is still streaming, and offers a way to fold it', async () => {
  await streamThought('Checking the model catalog first.');
  expect(container.textContent).toContain('Checking the model catalog first.');
  // The reversal: this used to assert there was NO trigger. Visible-by-default
  // and foldable are not in conflict — `defaultOpen` gives the first, the
  // trigger gives the second.
  expect(trigger()).not.toBeNull();
});

it('appends as deltas land — the wait visibly moves', async () => {
  await streamThought('Let me ');
  expect(container.textContent).toContain('Let me ');
  await streamThought('Let me read the catalog.');
  expect(container.textContent).toContain('Let me read the catalog.');
});

it('a thought with no text yet paints the header alone, not an empty block', async () => {
  await streamThought('');
  expect(container.querySelector('p')).toBeNull();
  // An empty shell with a chevron that opens onto nothing is worse than no
  // chevron: the bare row is the honest shape (T-05 ledger).
  expect(trigger()).toBeNull();
});

it('folds back behind a chevron once the thought has settled', async () => {
  await settleThought('Settled reasoning.');
  // Collapsed by default, so the text is not on screen until asked for.
  expect(container.textContent).not.toContain('Settled reasoning.');
  expect(trigger()).not.toBeNull();
  await clickTrigger();
  expect(container.textContent).toContain('Settled reasoning.');
});

it('collapsing mid-stream hides the text while deltas keep landing', async () => {
  await streamThought('First sentence.');
  await clickTrigger();
  expect(container.textContent).not.toContain('First sentence.');
  // The stream does not stop for the reader, and the row must not re-open
  // itself when it grows — that would make the control unusable during exactly
  // the wait it exists for.
  await streamThought('First sentence. Second sentence.');
  expect(container.textContent).not.toContain('First sentence.');
  expect(container.textContent).toContain('Thinking');
});

it('re-expanding mid-stream shows everything that arrived while it was closed', async () => {
  await streamThought('First sentence.');
  await clickTrigger();
  await streamThought('First sentence. Second sentence.');
  await clickTrigger();
  expect(container.textContent).toContain('First sentence. Second sentence.');
});

it('a thought nobody touched still folds itself away once it settles', async () => {
  await streamThought('Weighing two options.');
  expect(container.textContent).toContain('Weighing two options.');
  await settleThought('Weighing two options.');
  // The 2026-08-25 rule survives the new default: with no explicit choice on
  // record, the settled row has no `defaultOpen` to inherit, so it closes.
  expect(container.textContent).not.toContain('Weighing two options.');
  expect(trigger()).not.toBeNull();
});

it('a thought the user collapsed mid-stream stays collapsed after it settles', async () => {
  await streamThought('Long chain of reasoning.');
  await clickTrigger();
  await settleThought('Long chain of reasoning.');
  expect(container.textContent).not.toContain('Long chain of reasoning.');
});

it('a thought the user re-opened mid-stream stays open after it settles', async () => {
  await streamThought('Long chain of reasoning.');
  await clickTrigger();
  await clickTrigger();
  expect(container.textContent).toContain('Long chain of reasoning.');
  // This is the case the auto-fold must NOT swallow: the reader said "keep
  // this open" and the row settles a second later.
  await settleThought('Long chain of reasoning.');
  expect(container.textContent).toContain('Long chain of reasoning.');
});

/*
 * ────────────────────────────────────────────────────────────────────────────
 * T096 (decision 028): folding a header that followed the reader down the page
 * ────────────────────────────────────────────────────────────────────────────
 *
 * happy-dom has no layout engine, so the geometry is supplied rather than
 * measured — and that is the right shape for this assertion anyway. What the
 * component owns is a decision ("was the header pinned, and where does the
 * viewport have to land"), not a measurement; `stickyFoldScrollTarget` states
 * the arithmetic and these cases prove the component feeds it the right four
 * numbers and honours the answer. The layout itself is the browser's job.
 */

/**
 * Freeze one element's box. Only `top` is ever read by the code under test;
 * the rest is filled in so the value is a legal `DOMRect`.
 */
function stubTop(element: Element, top: number): void {
  const height = 24;
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    top,
    bottom: top + height,
    height,
    y: top,
    left: 0,
    right: 600,
    width: 600,
    x: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/**
 * Re-home the render container inside a stand-in for the timeline's scroll
 * viewport, tagged with the same `data-slot` the real one carries.
 *
 * `scrollTop` is redefined rather than assigned: the component both reads and
 * writes it, and a plain assignment on a happy-dom element is not guaranteed to
 * read back, which would make the assertion pass for the wrong reason.
 */
function mountScrollSurface(scrollTop: number): HTMLDivElement {
  const surface = document.createElement('div');
  surface.dataset.slot = SCROLL_SURFACE_SLOT;
  document.body.append(surface);
  surface.append(container);
  Object.defineProperty(surface, 'scrollTop', {
    value: scrollTop,
    writable: true,
    configurable: true,
  });
  stubTop(surface, 0);
  return surface;
}

it('collapsing a stuck thought header scrolls the viewport back to the header', async () => {
  const surface = mountScrollSurface(800);
  await streamThought('A chain of reasoning taller than the viewport.');
  const header = trigger();
  expect(header, 'no header to fold').not.toBeNull();
  const block = header?.parentElement;
  expect(block, 'the header must sit inside the collapsible root').not.toBeNull();

  // What "stuck" looks like in numbers: the block's natural top is 500px above
  // the viewport's top edge, and the header is NOT there — it has been pinned
  // to the viewport's own top (`sticky top-0`), 500px below where it belongs.
  stubTop(block as HTMLElement, -500);
  stubTop(header as HTMLElement, 0);

  await clickTrigger();

  // 800 (where the reader was) - 500 (the distance the pin had carried the
  // header) = the offset at which the block's own top sits at the viewport's.
  expect(surface.scrollTop).toBe(300);
  expect(container.textContent).not.toContain('A chain of reasoning taller than the viewport.');
});

it('collapsing a thought header that was never stuck leaves the scroll alone', async () => {
  const surface = mountScrollSurface(800);
  await streamThought('A short thought that fits on screen.');
  const header = trigger();
  const block = header?.parentElement;
  // Header and block share a top edge, which is precisely what "not pinned"
  // means. Moving the viewport here would be the defect, not the feature: the
  // reader can already see the row they clicked.
  stubTop(block as HTMLElement, 240);
  stubTop(header as HTMLElement, 240);

  await clickTrigger();

  expect(surface.scrollTop).toBe(800);
});
