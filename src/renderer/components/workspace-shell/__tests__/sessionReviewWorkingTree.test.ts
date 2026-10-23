// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/stores/editor';

/**
 * User, 2026-10-23 (preview part 2, option 2): the 「改动」 pane's 「工作区」
 * view — `git status`, whatever made the change. A row opens the Git pane's
 * own diff target; the footer links to the Git pane for staging.
 */
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../useWorkspaceRootPath', () => ({
  readWorkspaceRootPath: () => '/repo',
  useWorkspaceRootPath: () => '/repo',
}));
vi.mock('@/hooks/useSourceControl', () => ({
  useFileChanges: () => ({
    data: {
      changes: [
        { path: 'src/a.ts', status: 'M', staged: false },
        { path: 'notes.md', status: 'U', staged: false },
        { path: 'src/b.ts', status: 'A', staged: true },
      ],
    },
    error: null,
  }),
}));

import { WorkspaceChangesList } from '../WorkspaceChangesList';

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const editorBefore = useEditorStore.getState();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useEditorStore.setState({ tabs: [], activeTabPath: null });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  useEditorStore.setState(editorBefore, true);
  vi.unstubAllGlobals();
});

it('lists the working tree, staged first, and opens a row as a workdir diff', async () => {
  const onOpenDiff = vi.fn();
  const onOpenGit = vi.fn();
  await act(async () =>
    root.render(createElement(WorkspaceChangesList, { onOpenDiff, onOpenGit }))
  );
  const rows = element.querySelectorAll<HTMLButtonElement>('[data-workspace-change]');
  expect([...rows].map((row) => row.dataset.workspaceChange)).toEqual([
    'src/b.ts',
    'src/a.ts',
    'notes.md',
  ]);
  expect(rows[0]?.textContent).toContain('Staged');
  await act(async () => rows[1]?.click());
  expect(useEditorStore.getState().tabs[0]?.diffTarget).toEqual({
    kind: 'workdir',
    path: 'src/a.ts',
    staged: false,
    status: 'M',
  });
  expect(onOpenDiff).toHaveBeenCalledOnce();
  const toGit = [...element.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent === 'Stage and commit in Git'
  );
  await act(async () => toGit?.click());
  expect(onOpenGit).toHaveBeenCalledOnce();
});
