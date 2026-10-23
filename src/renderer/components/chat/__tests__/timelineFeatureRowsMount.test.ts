// @vitest-environment happy-dom
/**
 * Issue #26 items 2 and 8, painted: the inline diff's line numbers and folded
 * unchanged runs (a click opens one in place), and the copy button of an open
 * thought — which never opens the thought by itself.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useToolExpansionStore } from '@/stores/toolExpansion';
import { ToolGroup } from '../ToolRows';
import { deriveToolGroupRows, deriveToolRowView, type ToolGroupEntry } from '../toolCard';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}));

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

const trigger = () => container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]');

it('[26-2] an SDK patch shows old/new line numbers and folds the far unchanged lines', async () => {
  const context = Array.from({ length: 10 }, (_, i) => ` line ${i + 1}`).join('\n');
  const tail = Array.from({ length: 10 }, (_, i) => ` line ${i + 12}`).join('\n');
  const patch = `--- a/a.ts\n+++ b/a.ts\n@@ -1,21 +1,21 @@\n${context}\n-old 11\n+new 11\n${tail}\n`;
  const row = deriveToolRowView({
    toolCallId: 't',
    blockIndex: 0,
    blockId: 'b',
    toolName: 'Edit',
    input: { file_path: 'a.ts', old_string: 'old 11', new_string: 'new 11' },
    status: 'ok',
    result: { details: { patch } },
  });
  await act(async () => root.render(createElement(ToolGroup, { rows: [row], showDiff: true })));
  await act(async () => trigger()?.click());

  const folds = container.querySelectorAll<HTMLElement>('[data-slot="diff-fold"]');
  expect(folds).toHaveLength(2);
  expect(folds[0]?.textContent).toContain('{{count}} unchanged lines {"count":7}');
  const oldNumbers = [...container.querySelectorAll('[data-slot="diff-old-line"]')].map(
    (cell) => cell.textContent
  );
  const newNumbers = [...container.querySelectorAll('[data-slot="diff-new-line"]')].map(
    (cell) => cell.textContent
  );
  // 3 context, the del, the add, 3 context.
  expect(oldNumbers).toEqual(['8', '9', '10', '11', '', '12', '13', '14']);
  expect(newNumbers).toEqual(['8', '9', '10', '', '11', '12', '13', '14']);

  // Opening the first fold puts its 7 lines back, in place, and leaves the other.
  await act(async () => folds[0]?.click());
  expect(container.querySelectorAll('[data-slot="diff-fold"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-slot="diff-old-line"]')[0]?.textContent).toBe('1');
});

it('[26-2] an argument preview carries no line-number gutter', async () => {
  const row = deriveToolRowView({
    toolCallId: 't',
    blockIndex: 0,
    blockId: 'b',
    toolName: 'edit',
    input: { path: 'a.ts', oldText: 'before', newText: 'after' },
    status: 'ok',
  });
  await act(async () => root.render(createElement(ToolGroup, { rows: [row], showDiff: true })));
  await act(async () => trigger()?.click());
  expect(container.textContent).toContain('before');
  expect(container.querySelector('[data-slot="diff-old-line"]')).toBeNull();
});

it('[26-8] an open thought has a copy button; a closed one has none and is not forced open', async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const entry: ToolGroupEntry = {
    kind: 'thinking',
    block: { id: 'th1', type: 'thinking', text: 'first\n\nsecond' },
    blockIndex: 0,
  };
  const rows = deriveToolGroupRows([entry], { isStreamingBlockId: null });
  await act(async () => root.render(createElement(ToolGroup, { rows, sessionId: 's' })));
  expect(container.querySelector('[data-slot="thinking-text"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Copy thinking"]')).toBeNull();

  await act(async () => trigger()?.click());
  const copy = container.querySelector<HTMLButtonElement>('button[aria-label="Copy thinking"]');
  expect(copy).not.toBeNull();
  await act(async () => copy?.click());
  // The thought as written, blank lines included (the display drops them).
  expect(writeText).toHaveBeenCalledWith('first\n\nsecond');
  // Copying does not fold the thought.
  expect(container.querySelector('[data-slot="thinking-text"]')).not.toBeNull();
});
