// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useDiffLayoutStore } from '@/stores/diffLayout';
import { ToolGroup } from '../ToolRows';
import { deriveToolRowView, type ToolRun } from '../toolCard';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
it('toggles persisted-setting input and expands actual diff, preserving failure status', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const run: ToolRun = {
    toolCallId: 't',
    blockIndex: 0,
    blockId: 'b',
    toolName: 'edit',
    input: { path: 'a.ts', oldText: 'before', newText: 'after' },
    status: 'ok',
  };
  const row = deriveToolRowView(run);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    // PiLab R2: where diffs are hidden, a row whose only body is its diff does
    // not offer to open onto nothing.
    await act(async () => root.render(createElement(ToolGroup, { rows: [row], showDiff: false })));
    expect(container.querySelector('[data-slot="collapsible-trigger"]')).toBeNull();
    expect(container.textContent).not.toContain('before');
    await act(async () => root.render(createElement(ToolGroup, { rows: [row], showDiff: true })));
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    );
    expect(container.textContent).toContain('before');
    expect(container.textContent).toContain('Successful edit');
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    );
    expect(container.textContent).not.toContain('before');
    const failed = deriveToolRowView({
      ...run,
      status: 'failed',
      errorText: 'permission denied',
      output: 'permission denied',
    });
    await act(async () =>
      root.render(createElement(ToolGroup, { rows: [failed], showDiff: true }))
    );
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    );
    expect(container.textContent).toContain('application unconfirmed');
    expect(container.textContent).toContain('permission denied');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('[PILAB-R2-DIFF] a call that was never applied is a preview, not a successful edit', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const row = deriveToolRowView({
    toolCallId: 't',
    blockIndex: 0,
    blockId: 'b',
    toolName: 'edit',
    input: { path: 'a.ts', oldText: 'before', newText: 'after' },
    status: 'failed',
    result: { details: { notStarted: true } },
  });
  expect(row.outcome).toBe('notStarted');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ToolGroup, { rows: [row], showDiff: true })));
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    );
    expect(container.textContent).toContain('before');
    expect(container.textContent).not.toContain('Successful edit');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('[PILAB-R2-SPLIT] the header switches the diff between stacked and side by side', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const row = deriveToolRowView({
    toolCallId: 't',
    blockIndex: 0,
    blockId: 'b',
    toolName: 'edit',
    input: { path: 'a.ts', oldText: 'before', newText: 'after' },
    status: 'ok',
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  useDiffLayoutStore.setState({ layout: 'unified' });
  try {
    await act(async () => root.render(createElement(ToolGroup, { rows: [row], showDiff: true })));
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    );
    expect(container.querySelector('[data-diff-pair]')).toBeNull();
    await act(async () =>
      container.querySelector<HTMLElement>('button[aria-label="Side by side"]')!.click()
    );
    expect(useDiffLayoutStore.getState().layout).toBe('split');
    expect(container.querySelector('[data-split-side="old"]')?.textContent).toContain('before');
    expect(container.querySelector('[data-split-side="new"]')?.textContent).toContain('after');
    await act(async () =>
      container.querySelector<HTMLElement>('button[aria-label="Stacked"]')!.click()
    );
    expect(container.querySelector('[data-diff-pair]')).toBeNull();
  } finally {
    useDiffLayoutStore.setState({ layout: 'unified' });
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([
  'read',
  'edit',
  'write',
])('the real Pi %s path produces an editor intent', async (toolName) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const { useFileOpenIntentStore } = await import('@/stores/fileOpenIntent');
  const row = deriveToolRowView({
    toolCallId: 't',
    blockIndex: 0,
    blockId: 'b',
    toolName,
    input: { path: 'C:\\repo\\a.ts', offset: 8 },
    status: 'ok',
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ToolGroup, { rows: [row] })));
    await act(async () => container.querySelector<HTMLButtonElement>('button[title]')!.click());
    expect(useFileOpenIntentStore.getState().intent).toMatchObject({
      path: 'C:\\repo\\a.ts',
      line: 8,
      source: 'tool-row',
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
