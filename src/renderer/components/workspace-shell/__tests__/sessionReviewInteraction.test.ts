// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { SessionReviewPanel } from '../SessionReviewPanel';
import type { SessionReviewEntry } from '../sessionReview';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

it('expands diffs, opens a real file intent, and closes without touching files', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const onClose = vi.fn();
  const onShowFiles = vi.fn();
  const entry: SessionReviewEntry = {
    id: 'one',
    path: '/repo/test.txt',
    status: 'modified',
    patch: '@@ -1,1 +1,2 @@\n pong\n+abc',
    added: 1,
    removed: 0,
  };
  const props = {
    sessionId: 's',
    entries: [entry],
    onClose,
    onShowFiles,
    filesOpen: true,
    expanded: false,
    onToggleExpanded: vi.fn(),
  };
  try {
    await act(async () => root.render(createElement(SessionReviewPanel, props)));
    expect(element.textContent).toContain('+abc');
    await act(async () =>
      element.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    );
    expect(element.textContent).not.toContain('+abc');
    await act(async () =>
      element.querySelector<HTMLButtonElement>('button[aria-label="Open file"]')!.click()
    );
    expect(useFileOpenIntentStore.getState().intent).toMatchObject({ path: '/repo/test.txt' });
    expect(onShowFiles).toHaveBeenCalledOnce();
    await act(async () =>
      element.querySelector<HTMLButtonElement>('button[aria-label="Close review"]')!.click()
    );
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(
        createElement(SessionReviewPanel, {
          ...props,
          key: 'other',
          sessionId: 'other',
          entries: [],
        })
      )
    );
    expect(element.textContent).not.toContain('test.txt');
    expect(element.textContent).toContain('No file changes recorded');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});
