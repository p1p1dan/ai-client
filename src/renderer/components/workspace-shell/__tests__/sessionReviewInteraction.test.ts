// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { isDiffTabActive } from '@/stores/diffTabTarget';
import { useEditorStore } from '@/stores/editor';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { SessionReviewPanel } from '../SessionReviewPanel';
import type { SessionReviewEntry } from '../sessionReview';

vi.mock('../useWorkspaceRootPath', () => ({ readWorkspaceRootPath: () => '/repo' }));

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

it('expands diffs and opens a real diff tab without touching files', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const editorBefore = useEditorStore.getState();
  const intentBefore = useFileOpenIntentStore.getState().intent;
  useEditorStore.setState({ tabs: [], activeTabPath: null });
  const onOpenDiff = vi.fn();
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
    entries: Array.from({ length: 12 }, (_, index) => ({
      ...entry,
      id: `entry-${index}`,
      path: `/repo/file-${index}.txt`,
    })),
    onOpenDiff,
  };
  try {
    await act(async () => root.render(createElement(SessionReviewPanel, props)));
    expect(element.textContent).not.toContain('+abc');
    const triggers = element.querySelectorAll<HTMLButtonElement>(
      '[data-slot="collapsible-trigger"]'
    );
    expect(triggers).toHaveLength(12);
    expect(
      [...triggers].every((trigger) => trigger.getAttribute('aria-expanded') === 'false')
    ).toBe(true);
    await act(async () =>
      element.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')!.click()
    );
    expect(element.textContent).toContain('+abc');
    expect(triggers[0].getAttribute('aria-expanded')).toBe('true');
    expect(triggers[1].getAttribute('aria-expanded')).toBe('false');
    expect(triggers[0].tagName).toBe('BUTTON');
    triggers[0].focus();
    expect(document.activeElement).toBe(triggers[0]);
    const added = element.querySelector('[data-diff-line="add"]');
    expect(added?.querySelector('[data-line-number="old"]')?.textContent).toBe('');
    expect(added?.querySelector('[data-line-number="new"]')?.textContent).toBe('2');
    await act(async () =>
      element.querySelector<HTMLButtonElement>('button[aria-label="Open file"]')!.click()
    );
    expect(useFileOpenIntentStore.getState().intent).toBe(intentBefore);
    const editor = useEditorStore.getState();
    expect(editor.activeTabPath).toBe('git-diff://workdir/unstaged/file-0.txt');
    expect(editor.tabs[0].diffTarget).toEqual({
      kind: 'workdir',
      path: 'file-0.txt',
      staged: false,
      status: 'M',
    });
    expect(isDiffTabActive(editor.tabs, editor.activeTabPath)).toBe(true);
    // Layout 5d: opening a diff asks for the editor pane; the review stays.
    expect(onOpenDiff).toHaveBeenCalledOnce();
    expect(triggers[0].getAttribute('aria-expanded')).toBe('true');
    await act(async () =>
      element.querySelector<HTMLButtonElement>('button[aria-label="Open file"]')!.click()
    );
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(onOpenDiff).toHaveBeenCalledTimes(2);
    // Layout 5d: no header of its own — the pane card has the one close / expand.
    expect(element.querySelector('button[aria-label="Close review"]')).toBeNull();
    expect(element.querySelector('button[aria-label="Expand panel"]')).toBeNull();
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
    useEditorStore.setState(editorBefore, true);
    vi.unstubAllGlobals();
  }
});

it('groups changes by file, and the change card expands and marks its file (layout 5c/5d)', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    callback();
    return 0;
  });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const change = (id: string, path: string, patch: string): SessionReviewEntry => ({
    id,
    path,
    status: 'modified',
    patch,
    added: 1,
    removed: 0,
  });
  const entries = [
    change('m1:a', '/repo/src/a.ts', '@@ -1 +1,2 @@\n one\n+first'),
    change('m1:b', '/repo/src/b.ts', '@@ -1 +1,2 @@\n one\n+other'),
    change('m2:a', '/repo/src/a.ts', '@@ -2 +2,2 @@\n two\n+second'),
  ];
  useShellLayoutStore.setState({ changeFocus: null });
  try {
    await act(async () =>
      root.render(
        createElement(SessionReviewPanel, { sessionId: 's', entries, onOpenDiff: vi.fn() })
      )
    );
    const files = element.querySelectorAll('[data-review-file]');
    expect([...files].map((file) => file.getAttribute('data-review-file'))).toEqual([
      '/repo/src/a.ts',
      '/repo/src/b.ts',
    ]);
    // Both of a.ts's changes add up on its row.
    expect(files[0]?.textContent).toContain('+2');
    expect(element.textContent).not.toContain('+second');
    await act(async () =>
      useShellLayoutStore.getState().revealChange({ entryId: 'm2:a', path: '/repo/src/a.ts' })
    );
    const trigger = files[0]?.querySelector('[data-slot="collapsible-trigger"]');
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(element.textContent).toContain('+first');
    expect(element.textContent).toContain('+second');
    expect(
      files[1]?.querySelector('[data-slot="collapsible-trigger"]')?.getAttribute('aria-expanded')
    ).toBe('false');
    // By path when the entry is unknown (an older page not loaded yet).
    await act(async () =>
      useShellLayoutStore.getState().revealChange({ entryId: 'gone', path: '/repo/src/b.ts' })
    );
    expect(
      files[1]?.querySelector('[data-slot="collapsible-trigger"]')?.getAttribute('aria-expanded')
    ).toBe('true');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    useShellLayoutStore.setState({ changeFocus: null, panes: [], paneFocus: [] });
    vi.unstubAllGlobals();
  }
});
