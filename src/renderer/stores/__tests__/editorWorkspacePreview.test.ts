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

  it('keeps the disk baseline across edits and only advances it on authoritative replacement', () => {
    useEditorStore.getState().openFile({ path: '/repo/a.ts', content: 'A', isDirty: false });
    useEditorStore.getState().updateFileContent('/repo/a.ts', 'C', true);
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'C', baseContent: 'A' });

    useEditorStore.getState().markExternalChange('/repo/a.ts', 'B');
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'C', baseContent: 'A' });

    useEditorStore.getState().markExternalChange('/repo/a.ts', 'B2');
    useEditorStore.getState().applyExternalChange('/repo/a.ts');
    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      content: 'B2',
      baseContent: 'B2',
      isDirty: false,
    });

    useEditorStore.getState().updateFileContent('/repo/a.ts', 'D', false);
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'D', baseContent: 'D' });
  });

  it('Keep Mine moves the baseline to exactly the disk text the user saw, keeping their edit', () => {
    useEditorStore.getState().openFile({ path: '/repo/a.ts', content: 'A', isDirty: false });
    useEditorStore.getState().updateFileContent('/repo/a.ts', 'C', true);
    useEditorStore.getState().markExternalChange('/repo/a.ts', 'B');

    useEditorStore.getState().keepLocalOverExternalChange('/repo/a.ts');
    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      content: 'C',
      baseContent: 'B',
      isDirty: true,
      hasExternalChange: false,
      externalContent: undefined,
    });

    // A clean tab that chose to keep its text over the disk is dirty again:
    // saving it is now a deliberate overwrite of B.
    useEditorStore.getState().openFile({ path: '/repo/b.ts', content: 'A', isDirty: false });
    useEditorStore.getState().markExternalChange('/repo/b.ts', 'B');
    useEditorStore.getState().keepLocalOverExternalChange('/repo/b.ts');
    expect(useEditorStore.getState().tabs[1]).toMatchObject({
      content: 'A',
      baseContent: 'B',
      isDirty: true,
    });
  });

  it('advances the baseline to the written snapshot without clearing a concurrent edit', () => {
    useEditorStore.getState().openFile({ path: '/repo/a.ts', content: 'A', isDirty: false });
    useEditorStore.getState().updateFileContent('/repo/a.ts', 'C', true);
    useEditorStore.getState().updateFileContent('/repo/a.ts', 'D', true);

    useEditorStore.getState().markFileSaved('/repo/a.ts', 'C');
    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      content: 'D',
      baseContent: 'C',
      isDirty: true,
    });

    useEditorStore.getState().markFileSaved('/repo/a.ts', 'D');
    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      content: 'D',
      baseContent: 'D',
      isDirty: false,
    });
  });

  it('keeps unsaved text across a "no workspace yet" round trip — the App remount shape', () => {
    // This is the fact the sign-in confirmation's copy rests on
    // (`components/auth/signInLossModel.ts`): going to the login screen
    // unmounts `<App/>`, and while everything React-local dies with it, THIS
    // store does not — it is a module singleton, nothing calls
    // `closeAllWorktreeStates`, and `useEditorWorktreeSync` replays the same
    // two calls below when the workspace resolves again.
    //
    // So the dialog says "not written to disk yet" rather than "will be lost".
    // Claiming a loss that does not happen is how a user learns to click
    // through the next warning too.
    useEditorStore.getState().switchWorktree('/repo-a');
    useEditorStore.getState().openFile({ path: '/repo-a/a.ts', content: 'saved', isDirty: false });
    useEditorStore.getState().updateFileContent('/repo-a/a.ts', 'half-written thought', true);

    // Unmount, then remount before the active session has resolved a path.
    useEditorStore.getState().switchWorktree(null);
    expect(useEditorStore.getState().tabs).toEqual([]);

    useEditorStore.getState().switchWorktree('/repo-a');
    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      path: '/repo-a/a.ts',
      content: 'half-written thought',
      isDirty: true,
    });
  });
});
