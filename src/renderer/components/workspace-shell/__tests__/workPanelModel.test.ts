import { describe, expect, it } from 'vitest';
import {
  clampWorkPanelWidth,
  closeWorkPanel,
  deriveTerminalButtonState,
  deriveWorkPanelTabs,
  isWorkPanelTab,
  openWorkPanelTab,
  resolveWorkPanelView,
  surfaceIdForTab,
  tabForIntent,
  toggleWorkPanelTab,
  WORK_PANEL_DEFAULT_WIDTH,
  WORK_PANEL_MIN_WIDTH,
  WORK_PANEL_TAB_ORDER,
  type WorkPanelState,
  type WorkPanelTab,
} from '../workPanelModel';

/**
 * Design system v2 / layout 5a (ui-cohesion §6, rulings L3/L4): the work
 * panel replaces the dock's surface switcher and the right column's three
 * stacked occupants (`rightColumnModel.ts`, retired with this file's arrival).
 */

const NONE = {
  reviewAvailable: false,
  editorOpen: false,
  terminalAlive: false,
  setupTerminalOpened: false,
};

const closed: WorkPanelState = { open: false, tab: 'files', history: [] };

describe('deriveWorkPanelTabs', () => {
  it('always offers files, git, run and context, in strip order', () => {
    expect(deriveWorkPanelTabs(NONE)).toEqual(['files', 'git', 'run', 'context']);
  });

  it('adds changes, editor, terminal and setup only while each has something', () => {
    expect(
      deriveWorkPanelTabs({
        reviewAvailable: true,
        editorOpen: true,
        terminalAlive: true,
        setupTerminalOpened: true,
      })
    ).toEqual([...WORK_PANEL_TAB_ORDER]);
    expect(deriveWorkPanelTabs({ ...NONE, editorOpen: true })).toContain('editor');
    expect(deriveWorkPanelTabs({ ...NONE, terminalAlive: true })).toContain('terminal');
    expect(deriveWorkPanelTabs({ ...NONE, reviewAvailable: true })[0]).toBe('changes');
  });
});

describe('tabForIntent', () => {
  it('opening a file from anywhere means the editor tab', () => {
    expect(tabForIntent({ type: 'open-file' })).toBe('editor');
  });

  it('maps the title bar buttons and the init script', () => {
    expect(tabForIntent({ type: 'review' })).toBe('changes');
    expect(tabForIntent({ type: 'terminal' })).toBe('terminal');
    expect(tabForIntent({ type: 'initialization-terminal' })).toBe('setup');
  });

  it('maps the retired rail surfaces to their tabs (the files id stays `editor`)', () => {
    expect(tabForIntent({ type: 'surface', surfaceId: 'editor' })).toBe('files');
    expect(tabForIntent({ type: 'surface', surfaceId: 'git' })).toBe('git');
    expect(tabForIntent({ type: 'surface', surfaceId: 'context' })).toBe('context');
    expect(tabForIntent({ type: 'surface', surfaceId: 'run' })).toBe('run');
  });

  it('never opens the init terminal or a registry-only slot as navigation', () => {
    expect(tabForIntent({ type: 'surface', surfaceId: 'terminal' })).toBeNull();
    expect(tabForIntent({ type: 'surface', surfaceId: 'pr' })).toBeNull();
  });

  it('round-trips the surfaces a tab renders', () => {
    expect(surfaceIdForTab('files')).toBe('editor');
    expect(surfaceIdForTab('git')).toBe('git');
    expect(surfaceIdForTab('setup')).toBe('terminal');
    for (const tab of ['changes', 'editor', 'terminal'] as WorkPanelTab[]) {
      expect(surfaceIdForTab(tab)).toBeNull();
    }
  });
});

describe('open / toggle / close', () => {
  it('opens on the asked tab and records it last in the history', () => {
    const next = openWorkPanelTab(openWorkPanelTab(closed, 'git'), 'files');
    expect(next).toEqual({ open: true, tab: 'files', history: ['git', 'files'] });
    // Asking again moves it to the end instead of repeating it.
    expect(openWorkPanelTab(next, 'git').history).toEqual(['files', 'git']);
  });

  it('a button for the tab on screen closes the panel; any other switches', () => {
    const open = openWorkPanelTab(closed, 'files');
    expect(toggleWorkPanelTab(open, 'files', 'files').open).toBe(false);
    expect(toggleWorkPanelTab(open, 'git', 'files')).toMatchObject({ open: true, tab: 'git' });
    expect(toggleWorkPanelTab(closed, 'files', null)).toMatchObject({ open: true, tab: 'files' });
  });

  it('toggles against what is SHOWN, which a fallback can make differ from the stored tab', () => {
    // Stored `terminal`, but its shell ended and the panel fell back to git:
    // pressing git closes, pressing terminal reopens the terminal.
    const state = { open: true, tab: 'terminal', history: ['git', 'terminal'] } as WorkPanelState;
    expect(toggleWorkPanelTab(state, 'git', 'git').open).toBe(false);
    expect(toggleWorkPanelTab(state, 'terminal', 'git').open).toBe(true);
  });

  it('close keeps the remembered tab', () => {
    const next = closeWorkPanel(openWorkPanelTab(closed, 'run'));
    expect(next).toMatchObject({ open: false, tab: 'run' });
    expect(closeWorkPanel(closed)).toBe(closed);
  });
});

describe('resolveWorkPanelView — what happens when the active tab disappears', () => {
  const visible = deriveWorkPanelTabs({ ...NONE, editorOpen: true });

  it('is closed while the state is closed, whatever is visible', () => {
    expect(resolveWorkPanelView(closed, visible)).toEqual({ open: false, tab: null });
  });

  it('shows the asked tab while it exists', () => {
    expect(resolveWorkPanelView(openWorkPanelTab(closed, 'editor'), visible)).toEqual({
      open: true,
      tab: 'editor',
    });
  });

  it('falls back to the most recent tab still there (decision 126 rule 1)', () => {
    // Files under the terminal: the shell ends, the same files come back.
    const state = openWorkPanelTab(openWorkPanelTab(closed, 'editor'), 'terminal');
    expect(resolveWorkPanelView(state, visible)).toEqual({ open: true, tab: 'editor' });
  });

  it('closes when nothing it showed is left', () => {
    const state = openWorkPanelTab(closed, 'terminal');
    expect(resolveWorkPanelView(state, visible)).toEqual({ open: false, tab: null });
  });

  it('brings the tab back by itself when it reappears (no write-back)', () => {
    const state = openWorkPanelTab(openWorkPanelTab(closed, 'git'), 'terminal');
    expect(resolveWorkPanelView(state, visible).tab).toBe('git');
    const withShell = deriveWorkPanelTabs({ ...NONE, terminalAlive: true });
    expect(resolveWorkPanelView(state, withShell).tab).toBe('terminal');
  });
});

describe('widths (reference file panel: 480 default, 320 min)', () => {
  it('pins the numbers', () => {
    expect(WORK_PANEL_DEFAULT_WIDTH).toBe(480);
    expect(WORK_PANEL_MIN_WIDTH).toBe(320);
  });

  it('clamps, rounds and falls back to the default', () => {
    expect(clampWorkPanelWidth(100)).toBe(320);
    expect(clampWorkPanelWidth(5000)).toBe(1400);
    expect(clampWorkPanelWidth(500.4)).toBe(500);
    expect(clampWorkPanelWidth(Number.NaN)).toBe(480);
  });

  it('recognises only its own tab ids', () => {
    expect(isWorkPanelTab('files')).toBe(true);
    expect(isWorkPanelTab('chat')).toBe(false);
    expect(isWorkPanelTab(3)).toBe(false);
  });
});

// Carried over from `rightColumnModel.test.ts`.
describe('deriveTerminalButtonState', () => {
  it('is unavailable without a folder, whatever else holds', () => {
    expect(deriveTerminalButtonState({ available: false, alive: true, visible: true })).toBe(
      'unavailable'
    );
  });

  it('is open while the terminal tab shows', () => {
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
