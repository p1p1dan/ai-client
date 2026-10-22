import { describe, expect, it } from 'vitest';
import {
  clampPaneAreaWidth,
  clampSplitRatio,
  closePane,
  deriveAvailablePanes,
  derivePaneGrid,
  deriveTerminalButtonState,
  EMPTY_PANE_LAYOUT,
  focusPane,
  isPaneKind,
  openPane,
  PANE_AREA_DEFAULT_WIDTH,
  PANE_KINDS,
  type PaneKind,
  type PaneLayoutState,
  paneAreaMinWidth,
  paneForIntent,
  paneSlotStyle,
  RESERVED_PANE_KINDS,
  resolvePaneView,
  sanitizePaneSplits,
  surfaceIdForPane,
  toggleExpandedPane,
  togglePane,
} from '../workPanelModel';

/**
 * Layout 5d (user feedback 2026-10-22): the 5a work panel's tabs became pane
 * cards — several open at once, at most 2 columns × 2 rows. Replaces the 5a
 * tab-strip tests (open / toggle / fallback intent kept, retargeted to panes).
 */

const NONE = {
  reviewAvailable: false,
  editorOpen: false,
  terminalAlive: false,
  setupTerminalOpened: false,
  sessionOpen: false,
};

const ALL = {
  reviewAvailable: true,
  editorOpen: true,
  terminalAlive: true,
  setupTerminalOpened: true,
  sessionOpen: true,
};

function openAll(...kinds: PaneKind[]): PaneLayoutState {
  return kinds.reduce(openPane, EMPTY_PANE_LAYOUT);
}

describe('deriveAvailablePanes', () => {
  it('always offers files, git, run and context', () => {
    expect(deriveAvailablePanes(NONE)).toEqual(['files', 'git', 'run', 'context']);
  });

  it('adds changes, editor, terminal, setup and tasks only while each has something', () => {
    expect(deriveAvailablePanes(ALL)).toEqual(
      PANE_KINDS.filter((kind) => !RESERVED_PANE_KINDS.includes(kind))
    );
    expect(deriveAvailablePanes({ ...NONE, editorOpen: true })).toContain('editor');
    expect(deriveAvailablePanes({ ...NONE, terminalAlive: true })).toContain('terminal');
    expect(deriveAvailablePanes({ ...NONE, sessionOpen: true })).toContain('tasks');
  });

  it('never offers the reserved browser / plan / subagent slots yet', () => {
    for (const kind of RESERVED_PANE_KINDS) {
      expect(deriveAvailablePanes(ALL)).not.toContain(kind);
      expect(isPaneKind(kind)).toBe(true);
    }
    expect(isPaneKind('chat')).toBe(false);
  });
});

describe('paneForIntent', () => {
  it('maps file opens, the title bar buttons, the change card and the init script', () => {
    expect(paneForIntent({ type: 'open-file' })).toBe('editor');
    expect(paneForIntent({ type: 'review' })).toBe('changes');
    expect(paneForIntent({ type: 'terminal' })).toBe('terminal');
    expect(paneForIntent({ type: 'tasks' })).toBe('tasks');
    expect(paneForIntent({ type: 'initialization-terminal' })).toBe('setup');
  });

  it('maps the retired rail surfaces (the files id stays `editor`)', () => {
    expect(paneForIntent({ type: 'surface', surfaceId: 'editor' })).toBe('files');
    expect(paneForIntent({ type: 'surface', surfaceId: 'git' })).toBe('git');
    expect(paneForIntent({ type: 'surface', surfaceId: 'context' })).toBe('context');
    expect(paneForIntent({ type: 'surface', surfaceId: 'run' })).toBe('run');
  });

  it('never opens the init terminal or a registry-only slot as navigation', () => {
    expect(paneForIntent({ type: 'surface', surfaceId: 'terminal' })).toBeNull();
    expect(paneForIntent({ type: 'surface', surfaceId: 'pr' })).toBeNull();
  });

  it('round-trips the surfaces a pane renders', () => {
    expect(surfaceIdForPane('files')).toBe('editor');
    expect(surfaceIdForPane('git')).toBe('git');
    expect(surfaceIdForPane('setup')).toBe('terminal');
    for (const kind of ['changes', 'editor', 'terminal', 'tasks'] as PaneKind[]) {
      expect(surfaceIdForPane(kind)).toBeNull();
    }
  });
});

describe('open order → layout (2 columns × 2 rows)', () => {
  it('1st fills the area; 2nd is a second column; 3rd under column 1; 4th under column 2', () => {
    expect([...derivePaneGrid({ panes: ['changes'], expanded: null })]).toEqual([
      ['changes', { column: 0, row: 0, columns: 1, rows: 1 }],
    ]);
    expect(derivePaneGrid({ panes: ['changes', 'files'], expanded: null }).get('files')).toEqual({
      column: 1,
      row: 0,
      columns: 2,
      rows: 1,
    });
    const three = derivePaneGrid({ panes: ['changes', 'files', 'terminal'], expanded: null });
    expect(three.get('changes')).toEqual({ column: 0, row: 0, columns: 2, rows: 2 });
    expect(three.get('terminal')).toEqual({ column: 0, row: 1, columns: 2, rows: 2 });
    expect(three.get('files')).toEqual({ column: 1, row: 0, columns: 2, rows: 1 });
    const four = derivePaneGrid({ panes: ['changes', 'files', 'terminal', 'git'], expanded: null });
    expect(four.get('git')).toEqual({ column: 1, row: 1, columns: 2, rows: 2 });
  });

  it('opening an open pane focuses it and keeps the slots', () => {
    const state = openAll('changes', 'files', 'git');
    const again = openPane(state, 'changes');
    expect(again.panes).toEqual(['changes', 'files', 'git']);
    expect(again.focus.at(-1)).toBe('changes');
  });

  it('a 5th pane takes the slot of the least recently focused one', () => {
    let state = openAll('changes', 'files', 'terminal', 'git');
    state = focusPane(state, 'changes');
    // Focus order now: files, terminal, git, changes → files goes.
    const next = openPane(state, 'run');
    expect(next.panes).toEqual(['changes', 'run', 'terminal', 'git']);
    expect(next.focus).toEqual(['terminal', 'git', 'changes', 'run']);
  });

  it('closing compacts the rest in their order', () => {
    const next = closePane(openAll('changes', 'files', 'terminal'), 'changes');
    expect(next.panes).toEqual(['files', 'terminal']);
    expect(derivePaneGrid({ panes: next.panes, expanded: null }).get('terminal')?.column).toBe(1);
    expect(closePane(next, 'git')).toBe(next);
  });
});

describe('toggle / focus / expand', () => {
  it('a button for a pane on screen closes it; otherwise it opens', () => {
    const state = openAll('files');
    expect(togglePane(state, 'files', ['files']).panes).toEqual([]);
    expect(togglePane(state, 'git', ['files']).panes).toEqual(['files', 'git']);
  });

  it('toggles against what is SHOWN: a stored pane whose content is away reopens', () => {
    // `terminal` is stored but its folder has no shell on screen.
    const state = openAll('git', 'terminal');
    expect(togglePane(state, 'terminal', ['git']).panes).toEqual(['git', 'terminal']);
  });

  it('focusing the focused pane changes nothing (no store write per click)', () => {
    const state = openAll('files', 'git');
    expect(focusPane(state, 'git')).toBe(state);
    expect(focusPane(state, 'run')).toBe(state);
    expect(focusPane(state, 'files').focus).toEqual(['git', 'files']);
  });

  it('expand makes one pane the whole area and toggles back', () => {
    const state = toggleExpandedPane(openAll('files', 'git'), 'files');
    expect(state.expanded).toBe('files');
    const view = resolvePaneView(state, deriveAvailablePanes(NONE));
    expect(view.columns).toBe(1);
    expect([...derivePaneGrid(view).keys()]).toEqual(['files']);
    expect(toggleExpandedPane(state, 'files').expanded).toBeNull();
    expect(toggleExpandedPane(EMPTY_PANE_LAYOUT, 'files')).toBe(EMPTY_PANE_LAYOUT);
  });

  it('opening another pane, or closing the expanded one, leaves the expanded state', () => {
    const state = toggleExpandedPane(openAll('files', 'git'), 'files');
    expect(openPane(state, 'run').expanded).toBeNull();
    expect(openPane(state, 'files').expanded).toBe('files');
    expect(closePane(state, 'files').expanded).toBeNull();
  });
});

describe('resolvePaneView — panes whose content comes and goes', () => {
  it('shows nothing while nothing is open', () => {
    expect(resolvePaneView(EMPTY_PANE_LAYOUT, deriveAvailablePanes(ALL))).toEqual({
      panes: [],
      expanded: null,
      focused: null,
      columns: 0,
    });
  });

  it('skips a pane whose content is away, and brings it back by itself (no write-back)', () => {
    const state = openAll('editor', 'terminal');
    const noShell = deriveAvailablePanes({ ...NONE, editorOpen: true });
    expect(resolvePaneView(state, noShell)).toMatchObject({
      panes: ['editor'],
      focused: 'editor',
      columns: 1,
    });
    const withShell = deriveAvailablePanes({ ...NONE, editorOpen: true, terminalAlive: true });
    expect(resolvePaneView(state, withShell)).toMatchObject({
      panes: ['editor', 'terminal'],
      focused: 'terminal',
      columns: 2,
    });
  });

  it('drops an expanded pane that is away', () => {
    const state = toggleExpandedPane(openAll('git', 'terminal'), 'terminal');
    expect(resolvePaneView(state, deriveAvailablePanes(NONE)).expanded).toBeNull();
  });
});

describe('geometry', () => {
  it('pins the sizes: one column 480, two 2 × 420, 320 minimum, 8px gaps and margins', () => {
    expect(PANE_AREA_DEFAULT_WIDTH[1]).toBe(496);
    expect(PANE_AREA_DEFAULT_WIDTH[2]).toBe(864);
    expect(paneAreaMinWidth(1)).toBe(336);
    expect(paneAreaMinWidth(2)).toBe(664);
  });

  it('clamps area widths per column count, rounds, and falls back to the default', () => {
    expect(clampPaneAreaWidth(100, 1)).toBe(336);
    expect(clampPaneAreaWidth(100, 2)).toBe(664);
    expect(clampPaneAreaWidth(700.4, 2)).toBe(700);
    expect(clampPaneAreaWidth(Number.NaN, 2)).toBe(864);
  });

  it('keeps both sides of a dragged split at the minimum, or halves a box too small', () => {
    expect(clampSplitRatio(0.05, 1000, 320)).toBeCloseTo(0.324);
    expect(clampSplitRatio(0.6, 1000, 320)).toBe(0.6);
    expect(clampSplitRatio(0.3, 500, 320)).toBe(0.5);
    expect(clampSplitRatio(Number.NaN, 1000, 320)).toBe(0.5);
  });

  it('sanitizes persisted splits', () => {
    expect(sanitizePaneSplits(null)).toEqual({ column: 0.5, rows: [0.5, 0.5] });
    expect(sanitizePaneSplits({ column: 2, rows: [0.3, 'x'] })).toEqual({
      column: 0.85,
      rows: [0.3, 0.5],
    });
  });

  it('places cards from the split variables, with half a gap on each inner edge', () => {
    expect(paneSlotStyle({ column: 0, row: 0, columns: 1, rows: 1 })).toEqual({
      left: 'calc(0 * 100% + 0px)',
      top: 'calc(0 * 100% + 0px)',
      width: 'calc((1 - 0) * 100% - 0px)',
      height: 'calc((1 - 0) * 100% - 0px)',
    });
    expect(paneSlotStyle({ column: 1, row: 1, columns: 2, rows: 2 })).toEqual({
      left: 'calc(var(--pane-col) * 100% + 4px)',
      top: 'calc(var(--pane-row-1) * 100% + 4px)',
      width: 'calc((1 - var(--pane-col)) * 100% - 4px)',
      height: 'calc((1 - var(--pane-row-1)) * 100% - 4px)',
    });
    expect(paneSlotStyle({ column: 0, row: 0, columns: 2, rows: 2 })).toMatchObject({
      width: 'calc((var(--pane-col) - 0) * 100% - 4px)',
      height: 'calc((var(--pane-row-0) - 0) * 100% - 4px)',
    });
  });
});

// Carried over from `rightColumnModel.test.ts`.
describe('deriveTerminalButtonState', () => {
  it('is unavailable without a folder, whatever else holds', () => {
    expect(deriveTerminalButtonState({ available: false, alive: true, visible: true })).toBe(
      'unavailable'
    );
  });

  it('is open while the terminal pane shows', () => {
    expect(deriveTerminalButtonState({ available: true, alive: true, visible: true })).toBe('open');
  });

  it('is hidden while the shell runs out of sight, closed when there is none', () => {
    expect(deriveTerminalButtonState({ available: true, alive: true, visible: false })).toBe(
      'hidden'
    );
    expect(deriveTerminalButtonState({ available: true, alive: false, visible: false })).toBe(
      'closed'
    );
  });
});
