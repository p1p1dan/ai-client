// @vitest-environment happy-dom
/**
 * CG-4 (dsh-rebase decision 180, real-gateway evidence 2026-10-11): while a
 * reply streams, its settled segments render one Markdown child each. They
 * were keyed by their text alone, so a reply that repeats a paragraph — a
 * `---` rule, 「示意如下：」 — gave two children one key: React warned on every
 * flush (2,227 times in one stream) and may drop or repeat such a child. Now
 * each repeat is its own child, rendered once, in order.
 *
 * The `electronAPI` stub is hoisted: persisted stores rehydrate at import.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: { onRuntimeEvent: () => () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));

import { TurnTextItem } from '../MessageTimeline';

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function stream(text: string) {
  await act(async () => root?.render(createElement(TurnTextItem, { text, streaming: true })));
}

it('[CG4-MOUNT] a paragraph that comes back is shown again, once each, with no key warning', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const parts = ['示意如下：', '第一段。', '示意如下：', '第二段。', '示意如下：'];
  // Grows as a stream does: every flush ends in a still-open tail.
  for (let shown = 1; shown <= parts.length; shown += 1) {
    await stream(`${parts.slice(0, shown).join('\n\n')}\n\n尾巴`);
  }
  const paragraphs = [...container.querySelectorAll('p')].map((p) => p.textContent);
  expect(paragraphs.filter((text) => text === '示意如下：')).toHaveLength(3);
  expect(paragraphs.filter((text) => text === '第一段。')).toHaveLength(1);
  expect(paragraphs.filter((text) => text === '第二段。')).toHaveLength(1);
  expect(container.textContent?.indexOf('第一段。')).toBeLessThan(
    container.textContent?.indexOf('第二段。') ?? -1
  );
  expect(
    errors.mock.calls.some((call) => String(call[0]).includes('same key')),
    'React key warning'
  ).toBe(false);
});
