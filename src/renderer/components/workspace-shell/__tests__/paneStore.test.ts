// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { selectActiveSurfaceId, useShellLayoutStore } from '@/stores/shellLayout';

/**
 * Layout 5d: the store only wires the pane model's actions; these pin the
 * wiring — what each entry point opens, and what is (not) persisted.
 */
const store = useShellLayoutStore;

beforeEach(() => {
  store.setState({ panes: [], paneFocus: [], expandedPane: null, changeFocus: null });
});

describe('pane store wiring', () => {
  it('the change card opens the changes pane beside what is open and records the focus', () => {
    store.getState().openPane('files');
    store.getState().revealChange({ entryId: 'm:c1', path: 'src/a.ts' });
    const state = store.getState();
    expect(state.panes).toEqual(['files', 'changes']);
    expect(state.paneFocus.at(-1)).toBe('changes');
    expect(state.changeFocus).toEqual({ entryId: 'm:c1', path: 'src/a.ts', seq: 1 });
    store.getState().revealChange({ entryId: 'm:c1', path: 'src/a.ts' });
    expect(store.getState().panes).toEqual(['files', 'changes']);
    expect(store.getState().changeFocus?.seq).toBe(2);
  });

  it('a surface opens its pane; the init terminal is not navigation', () => {
    store.getState().openSurface('git');
    store.getState().openSurface('terminal');
    expect(store.getState().panes).toEqual(['git']);
    expect(selectActiveSurfaceId(store.getState())).toBe('git');
    store.getState().openInitializationTerminal();
    expect(store.getState().panes).toEqual(['git', 'setup']);
    expect(store.getState().setupTerminalOpened).toBe(true);
    expect(selectActiveSurfaceId(store.getState())).toBe('terminal');
  });

  it('focusing the focused pane writes nothing', () => {
    store.getState().openPane('files');
    const before = store.getState().paneFocus;
    store.getState().focusPane('files');
    expect(store.getState().paneFocus).toBe(before);
  });

  it('widths are kept per column count, splits are clamped', () => {
    store.getState().setPaneAreaWidth(1, 10);
    store.getState().setPaneAreaWidth(2, 1000);
    expect(store.getState().paneAreaWidth).toBe(336);
    expect(store.getState().paneAreaSplitWidth).toBe(1000);
    store.getState().setPaneColumnSplit(0.99);
    store.getState().setPaneRowSplit(1, 0.3);
    expect(store.getState().paneSplits).toEqual({ column: 0.85, rows: [0.5, 0.3] });
  });

  it('persists the geometry, never which panes are open', () => {
    store.getState().openPane('git');
    const persisted = JSON.parse(localStorage.getItem('aiclient-shell-layout') ?? '{}');
    expect(persisted.version).toBe(5);
    expect(Object.keys(persisted.state).sort()).toEqual([
      'paneAreaSplitWidth',
      'paneAreaWidth',
      'paneSplits',
      'readingWidthMode',
      'sidebarCollapsed',
      'sidebarWidth',
    ]);
  });
});
