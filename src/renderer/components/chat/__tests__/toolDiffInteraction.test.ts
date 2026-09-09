// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
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
    await act(async () => root.render(createElement(ToolGroup, { rows: [row], showDiff: false })));
    await act(async () =>
      container.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    );
    expect(container.textContent).not.toContain('before');
    await act(async () => root.render(createElement(ToolGroup, { rows: [row], showDiff: true })));
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
    expect(container.textContent).toContain('not applied');
    expect(container.textContent).toContain('permission denied');
  } finally {
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
