import { beforeEach, describe, expect, it } from 'vitest';
import { diffTabPath } from '../diffTabTarget';
import { useEditorStore } from '../editor';

/**
 * D34-E: `openDiffTab` reuses the ordinary tab machinery (`tabs`,
 * `activeTabPath`) instead of a parallel store — these tests pin the
 * open/reuse decision and confirm the tab is otherwise an ordinary
 * `EditorTab` (so close/reorder/worktree isolation need zero changes to
 * carry it, per `EditorColumn.tsx`'s D34-E doc note).
 *
 * D35 (user feedback, 2026-08-14, 「一次只看一份，点另一个直接切换，不要多 tab」)
 * tightened the open/reuse rule to a global singleton: at most ONE diff tab
 * ever exists, so opening a SECOND, DIFFERENT target now replaces the first
 * instead of coexisting with it (the pre-D35 "staged and unstaged are two
 * distinct tabs" / "two different files are two distinct tabs" behavior is
 * gone — see the truth-table tests below).
 */

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabPath: null,
    pendingCursor: null,
    currentCursorLine: null,
    navBackStack: [],
    navForwardStack: [],
    worktreeStates: {},
    currentWorktreePath: null,
  });
});

describe('useEditorStore.openDiffTab', () => {
  it('appends a new diff tab and activates it', () => {
    useEditorStore
      .getState()
      .openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: false, status: 'M' });

    const { tabs, activeTabPath } = useEditorStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].title).toBe('a.ts · M');
    expect(tabs[0].isDirty).toBe(false);
    expect(tabs[0].diffTarget).toEqual({
      kind: 'workdir',
      path: 'src/a.ts',
      staged: false,
      status: 'M',
    });
    expect(activeTabPath).toBe(tabs[0].path);
  });

  it('re-clicking the SAME target reuses the tab instead of appending a duplicate ("别开无限 tab")', () => {
    useEditorStore
      .getState()
      .openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: false, status: 'M' });
    useEditorStore
      .getState()
      .openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: false, status: 'M' });

    expect(useEditorStore.getState().tabs).toHaveLength(1);
  });

  it('re-clicking the same target with a CHANGED status updates the existing tab in place', () => {
    useEditorStore
      .getState()
      .openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: false, status: 'M' });
    useEditorStore
      .getState()
      .openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: false, status: 'A' });

    const { tabs } = useEditorStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].title).toBe('a.ts · A');
  });

  it('D35: a staged and an unstaged diff of the SAME file are NO LONGER distinct tabs — the second replaces the first', () => {
    useEditorStore.getState().openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: false });
    useEditorStore.getState().openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: true });

    const { tabs, activeTabPath } = useEditorStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].diffTarget).toEqual({ kind: 'workdir', path: 'src/a.ts', staged: true });
    expect(activeTabPath).toBe(tabs[0].path);
  });

  it('D35: opening a diff for a DIFFERENT file replaces the tab instead of adding a second one — tab count stays 1, title tracks the second file', () => {
    useEditorStore
      .getState()
      .openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: false, status: 'M' });
    useEditorStore
      .getState()
      .openDiffTab({ kind: 'workdir', path: 'src/b.ts', staged: false, status: 'A' });

    const { tabs, activeTabPath } = useEditorStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].title).toBe('b.ts · A');
    expect(tabs[0].diffTarget).toEqual({
      kind: 'workdir',
      path: 'src/b.ts',
      staged: false,
      status: 'A',
    });
    // The replaced tab's `path` (derived from its target) changes too, so
    // `activeTabPath` must be repointed rather than left at the old path —
    // otherwise `tabs.find(t => t.path === activeTabPath)` would silently
    // find nothing (D35 point ④: the diff tab must stay the active one).
    expect(activeTabPath).toBe(tabs[0].path);
    expect(activeTabPath).toBe(diffTabPath({ kind: 'workdir', path: 'src/b.ts', staged: false }));
  });

  it('D35: the singleton replace keeps the tab in its ORIGINAL array slot rather than moving it to the end', () => {
    useEditorStore.getState().openFile({ path: 'src/real.ts', content: 'x', isDirty: false });
    useEditorStore.getState().openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: false });
    // Diff tab is now at index 1: [real.ts, a.ts-diff]
    useEditorStore.getState().openDiffTab({ kind: 'workdir', path: 'src/b.ts', staged: false });

    const { tabs } = useEditorStore.getState();
    expect(tabs.map((t) => t.path)).toEqual([
      'src/real.ts',
      diffTabPath({ kind: 'workdir', path: 'src/b.ts', staged: false }),
    ]);
  });

  it('a commit diff tab coexists with a REAL file tab open for the same path', () => {
    useEditorStore.getState().openFile({ path: 'src/a.ts', content: 'x', isDirty: false });
    useEditorStore.getState().openDiffTab({ kind: 'commit', path: 'src/a.ts', hash: 'abc1234' });

    const { tabs } = useEditorStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.path === 'src/a.ts')?.diffTarget).toBeUndefined();
    expect(
      tabs.find(
        (t) => t.path === diffTabPath({ kind: 'commit', path: 'src/a.ts', hash: 'abc1234' })
      )?.diffTarget?.kind
    ).toBe('commit');
  });

  it('D35 point ④ regression pin: opening a diff tab while a FILE tab is active makes the diff tab the active one', () => {
    useEditorStore.getState().openFile({ path: 'src/real.ts', content: 'x', isDirty: false });
    expect(useEditorStore.getState().activeTabPath).toBe('src/real.ts');

    useEditorStore.getState().openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: false });

    const { activeTabPath, tabs } = useEditorStore.getState();
    const diffTab = tabs.find((t) => t.diffTarget != null);
    expect(activeTabPath).toBe(diffTab?.path);
  });

  it('closeFile removes a diff tab the same way it removes a file tab', () => {
    useEditorStore.getState().openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: false });
    const path = useEditorStore.getState().tabs[0].path;

    useEditorStore.getState().closeFile(path);

    expect(useEditorStore.getState().tabs).toHaveLength(0);
    expect(useEditorStore.getState().activeTabPath).toBeNull();
  });
});
