import { beforeEach, describe, expect, it } from 'vitest';
import { diffTabPath } from '../diffTabTarget';
import { useEditorStore } from '../editor';

/**
 * D34-E: `openDiffTab` reuses the ordinary tab machinery (`tabs`,
 * `activeTabPath`) instead of a parallel store — these tests pin the
 * open/reuse decision and confirm the tab is otherwise an ordinary
 * `EditorTab` (so close/reorder/worktree isolation need zero changes to
 * carry it, per `EditorColumn.tsx`'s D34-E doc note).
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

  it('a staged and an unstaged diff of the SAME file are two distinct tabs', () => {
    useEditorStore.getState().openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: false });
    useEditorStore.getState().openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: true });

    expect(useEditorStore.getState().tabs).toHaveLength(2);
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

  it('closeFile removes a diff tab the same way it removes a file tab', () => {
    useEditorStore.getState().openDiffTab({ kind: 'workdir', path: 'src/a.ts', staged: false });
    const path = useEditorStore.getState().tabs[0].path;

    useEditorStore.getState().closeFile(path);

    expect(useEditorStore.getState().tabs).toHaveLength(0);
    expect(useEditorStore.getState().activeTabPath).toBeNull();
  });
});
