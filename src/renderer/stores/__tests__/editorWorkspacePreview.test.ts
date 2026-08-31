import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from '../editor';

function reset() {
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
}

beforeEach(reset);

describe('workspace preview tab behavior', () => {
  it('opens, activates, reorders and closes ordinary file tabs', () => {
    const store = useEditorStore.getState();
    store.openFile({ path: '/repo/a.ts', content: 'a', isDirty: false });
    store.openFile({ path: '/repo/b.md', content: 'b', isDirty: false });
    store.openFile({ path: '/repo/c.txt', content: 'c', isDirty: false });
    expect(useEditorStore.getState().tabs.map((tab) => tab.path)).toEqual([
      '/repo/a.ts',
      '/repo/b.md',
      '/repo/c.txt',
    ]);

    useEditorStore.getState().setActiveFile('/repo/a.ts');
    useEditorStore.getState().reorderTabs(2, 0);
    expect(useEditorStore.getState().tabs.map((tab) => tab.path)).toEqual([
      '/repo/c.txt',
      '/repo/a.ts',
      '/repo/b.md',
    ]);
    expect(useEditorStore.getState().activeTabPath).toBe('/repo/a.ts');

    useEditorStore.getState().closeFile('/repo/a.ts');
    expect(useEditorStore.getState().activeTabPath).toBe('/repo/b.md');
  });

  it('restores each workspace tab order, active tab, dirty content and preview metadata', () => {
    useEditorStore.getState().switchWorktree('/repo-a');
    useEditorStore
      .getState()
      .openFile({ path: '/repo-a/a.ts', content: 'original', isDirty: false });
    useEditorStore.getState().openFile({
      path: '/repo-a/huge.log',
      content: '',
      isDirty: false,
      isTooLarge: true,
      byteLength: 10_000_000,
      maxPreviewBytes: 8_388_608,
    });
    useEditorStore.getState().updateFileContent('/repo-a/a.ts', 'edited', true);
    useEditorStore.getState().setActiveFile('/repo-a/a.ts');

    useEditorStore.getState().switchWorktree('/repo-b');
    useEditorStore.getState().openFile({ path: '/repo-b/b.ts', content: 'b', isDirty: false });
    expect(useEditorStore.getState().tabs.map((tab) => tab.path)).toEqual(['/repo-b/b.ts']);

    useEditorStore.getState().switchWorktree('/repo-a');
    const state = useEditorStore.getState();
    expect(state.tabs.map((tab) => tab.path)).toEqual(['/repo-a/a.ts', '/repo-a/huge.log']);
    expect(state.activeTabPath).toBe('/repo-a/a.ts');
    expect(state.tabs[0]).toMatchObject({ content: 'edited', isDirty: true });
    expect(state.tabs[1]).toMatchObject({ isTooLarge: true, byteLength: 10_000_000 });
  });
});
