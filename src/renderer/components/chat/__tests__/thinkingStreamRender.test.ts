// @vitest-environment happy-dom
/**
 * The thought a user can actually read WHILE the model is thinking.
 *
 * `toolCard.test.ts` locks the view model; this locks the paint. The two are
 * separate because the bug this covers lived in the gap between them: the
 * store held the thinking text the whole time, the row builder saw it, and the
 * renderer still put nothing on screen for the 12-20s a turn spends thinking —
 * `showBody` was gated on `!streaming`, so the text only became reachable once
 * the thought was over, behind a chevron the reader had to find and click.
 *
 * What these assert is deliberately literal: the characters are in the DOM,
 * and there is no toggle next to them.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToolGroup } from '../ToolRows';
import { deriveToolGroupRows, type ToolGroupEntry } from '../toolCard';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function thought(id: string, text: string): ToolGroupEntry {
  return { kind: 'thinking', block: { id, type: 'thinking', text }, blockIndex: 0 };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(rows: ReturnType<typeof deriveToolGroupRows>) {
  await act(async () => root.render(createElement(ToolGroup, { rows })));
}

it('shows the thought text while it is still streaming, with no chevron to click', async () => {
  const rows = deriveToolGroupRows([thought('th1', 'Checking the model catalog first.')], {
    isStreamingBlockId: 'th1',
  });
  await render(rows);
  expect(container.textContent).toContain('Checking the model catalog first.');
  // No collapsible at all: nothing to open, so nothing can be left closed.
  expect(container.querySelector('[data-slot="collapsible-trigger"]')).toBeNull();
});

it('appends as deltas land — the wait visibly moves', async () => {
  await render(deriveToolGroupRows([thought('th1', 'Let me ')], { isStreamingBlockId: 'th1' }));
  expect(container.textContent).toContain('Let me ');
  await render(
    deriveToolGroupRows([thought('th1', 'Let me read the catalog.')], {
      isStreamingBlockId: 'th1',
    })
  );
  expect(container.textContent).toContain('Let me read the catalog.');
});

it('a thought with no text yet paints the header alone, not an empty block', async () => {
  await render(deriveToolGroupRows([thought('th1', '')], { isStreamingBlockId: 'th1' }));
  expect(container.querySelector('p')).toBeNull();
  expect(container.querySelector('[data-slot="collapsible-trigger"]')).toBeNull();
});

it('folds back behind a chevron once the thought has settled', async () => {
  await render(
    deriveToolGroupRows([thought('th1', 'Settled reasoning.')], { isStreamingBlockId: null })
  );
  // Collapsed by default, so the text is not on screen until asked for.
  expect(container.textContent).not.toContain('Settled reasoning.');
  const trigger = container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  expect(container.textContent).toContain('Settled reasoning.');
});
