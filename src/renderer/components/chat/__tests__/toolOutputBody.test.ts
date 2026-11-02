// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ToolGroup, toolOutputLineCount } from '../ToolRows';
import { deriveToolRowView } from '../toolCard';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? '')),
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('counts lines without the trailing newline', () => {
  expect(toolOutputLineCount('')).toBe(0);
  expect(toolOutputLineCount('a\nb\n')).toBe(2);
  expect(toolOutputLineCount('a\n\nb')).toBe(3);
});

it('[PILAB-R2-OUTPUT] copies all of a settled output and opens it whole when it overflows', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  // happy-dom lays nothing out: make every <pre> taller than its box.
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
  const row = deriveToolRowView({
    toolCallId: 't',
    blockIndex: 0,
    blockId: 'b',
    toolName: 'read',
    input: { path: 'a.log' },
    status: 'ok',
    output,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ToolGroup, { rows: [row] })));
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    );
    expect(container.textContent).toContain('40 lines');
    await act(async () =>
      container
        .querySelector<HTMLElement>(
          '[data-slot="tool-output-copy"] button[aria-label="Copy all output"]'
        )!
        .click()
    );
    expect(writeText).toHaveBeenCalledWith(output);
    const viewAll = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'View all'
    );
    expect(viewAll).toBeDefined();
    await act(async () => viewAll!.click());
    const all = document.querySelector('[data-slot="tool-output-all"]');
    expect(all?.children).toHaveLength(40);
    expect(all?.lastElementChild?.textContent).toBe('40line 40');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('says on the copy button when the engine kept only the end', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const row = deriveToolRowView({
    toolCallId: 't',
    blockIndex: 0,
    blockId: 'b',
    toolName: 'read',
    input: { path: 'a.log' },
    status: 'ok',
    output: 'tail 1\ntail 2',
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(ToolGroup, { rows: [{ ...row, outputHeadOmitted: { bytes: 48 * 1024 } }] })
      )
    );
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    );
    expect(
      container.querySelector('button[aria-label="Copy all output (start omitted)"]')
    ).not.toBeNull();
    // A short output fits its box: no line count, no 「查看全部」 (user, 2026-11-02).
    expect(container.textContent).not.toContain('2 lines');
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent === 'View all')
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
