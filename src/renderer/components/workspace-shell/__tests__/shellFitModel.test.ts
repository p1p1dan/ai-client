import { describe, expect, it } from 'vitest';
import { CHAT_MIN_WIDTH, PANE_DRAWER_PEEK } from '../centerLayoutModel';
import { SESSION_RAIL_MIN_CHAT_WIDTH, SESSION_RAIL_WIDTH } from '../sessionRail/sessionRailModel';
import { fitShell, type ShellFitInput, type ShellSlot } from '../shellFitModel';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH } from '../shellLayoutModel';
import { SIDE_CHAT_DOCK_WIDTH, SIDE_CHAT_MIN_CHAT_WIDTH } from '../sideChat/sideChatModel';
import {
  PANE_AREA_DEFAULT_WIDTH,
  type PaneKind,
  type PaneView,
  paneAreaMinWidth,
} from '../workPanelModel';

/**
 * Decision 209 (§4, §5): the rail stays beside open panes, and a narrowing
 * window gives way in a fixed order — sidebar, then two pane columns into one,
 * then a drawer over the chat; the rail leaves only when even squeezed panes
 * would leave the conversation under 480.
 */
const RAIL: ShellSlot = { width: SESSION_RAIL_WIDTH, minChat: SESSION_RAIL_MIN_CHAT_WIDTH };
const DOCK: ShellSlot = { width: SIDE_CHAT_DOCK_WIDTH, minChat: SIDE_CHAT_MIN_CHAT_WIDTH };
const ONE = PANE_AREA_DEFAULT_WIDTH[1];
const TWO = PANE_AREA_DEFAULT_WIDTH[2];

function view(panes: PaneKind[]): PaneView {
  return {
    panes,
    expanded: null,
    focused: panes.at(-1) ?? null,
    columns: panes.length === 0 ? 0 : panes.length === 1 ? 1 : 2,
  };
}

function fitAt(
  shellWidth: number,
  panes: PaneKind[],
  slot: ShellSlot | null,
  over: Partial<ShellFitInput> = {}
) {
  return fitShell({
    base: {
      shellWidth,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      sidebarCollapsed: false,
      chatVisible: true,
      panelVisible: false,
      panelWidth: 0,
    },
    view: view(panes),
    focus: panes,
    paneWidths: PANE_AREA_DEFAULT_WIDTH,
    slot,
    ...over,
  });
}

describe('fitShell — the rail beside open panes (decision 209 §4)', () => {
  it('1536 wide (1920 at 125%) with one pane: conversation, rail and pane all fit as they are', () => {
    const result = fitAt(1536, ['changes'], RAIL);
    expect(result.slotFits).toBe(true);
    expect(result.allocation.editorWidth).toBe(ONE);
    expect(result.allocation.chatWidth - SESSION_RAIL_WIDTH).toBe(508);
  });

  it('squeezes the panes toward their floor before the rail gives up', () => {
    const result = fitAt(1366, ['changes'], RAIL);
    expect(result.slotFits).toBe(true);
    expect(result.allocation.editorWidth).toBeLessThan(ONE);
    expect(result.allocation.editorWidth).toBeGreaterThanOrEqual(paneAreaMinWidth(1));
    expect(result.allocation.chatWidth - SESSION_RAIL_WIDTH).toBe(SESSION_RAIL_MIN_CHAT_WIDTH);
  });

  it('leaves the panes at their own width when even the floor would not make room', () => {
    const result = fitAt(1280, ['changes'], RAIL);
    expect(result.slotFits).toBe(false);
    expect(result.allocation.editorWidth).toBe(ONE);
  });

  it('two columns: room for the rail from about 1680 (sidebar 272)', () => {
    const edge =
      SIDEBAR_DEFAULT_WIDTH +
      paneAreaMinWidth(2) +
      SESSION_RAIL_WIDTH +
      SESSION_RAIL_MIN_CHAT_WIDTH;
    expect(edge).toBe(1676);
    expect(fitAt(edge, ['changes', 'files'], RAIL).slotFits).toBe(true);
    expect(fitAt(edge - 1, ['changes', 'files'], RAIL).slotFits).toBe(false);
    expect(fitAt(1920, ['changes', 'files'], RAIL).allocation.editorWidth).toBe(TWO);
  });

  it('no panes: the rail needs 260 + 480 of conversation', () => {
    const edge = SIDEBAR_DEFAULT_WIDTH + SESSION_RAIL_WIDTH + SESSION_RAIL_MIN_CHAT_WIDTH;
    expect(fitAt(edge, [], RAIL).slotFits).toBe(true);
    expect(fitAt(edge - 1, [], RAIL).slotFits).toBe(false);
  });

  it('a docked side chat is the same kind of slot, wider', () => {
    const edge =
      SIDEBAR_DEFAULT_WIDTH + paneAreaMinWidth(1) + SIDE_CHAT_DOCK_WIDTH + SIDE_CHAT_MIN_CHAT_WIDTH;
    expect(edge).toBe(1468);
    expect(fitAt(edge, ['changes'], DOCK).slotFits).toBe(true);
    expect(fitAt(edge - 1, ['changes'], DOCK).slotFits).toBe(false);
    // The narrower rail still fits there.
    expect(fitAt(edge - 1, ['changes'], RAIL).slotFits).toBe(true);
  });

  it('nothing wants the slot, or the chat is hidden: it does not fit', () => {
    expect(fitAt(2400, [], null).slotFits).toBe(false);
    const hidden = fitAt(2400, ['editor'], RAIL, {
      base: {
        shellWidth: 2400,
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
        sidebarCollapsed: false,
        chatVisible: false,
        panelVisible: false,
        panelWidth: 0,
      },
    });
    expect(hidden.slotFits).toBe(false);
  });
});

describe('fitShell — a narrowing window (decision 209 §5)', () => {
  it('two columns that do not fit stack into one before covering the chat', () => {
    const result = fitAt(1280, ['changes', 'files'], null);
    expect(result.view.columns).toBe(1);
    expect(result.view.panes).toEqual(['changes', 'files']);
    expect(result.allocation.editorOverlay).toBe(false);
    expect(result.allocation.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
  });

  it('one column that does not fit lies over the chat as a drawer', () => {
    const result = fitAt(SIDEBAR_MIN_WIDTH + CHAT_MIN_WIDTH, ['changes'], RAIL);
    expect(result.allocation.sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(result.allocation.editorOverlay).toBe(true);
    expect(result.allocation.chatWidth).toBe(CHAT_MIN_WIDTH);
    expect(result.allocation.editorWidth).toBe(CHAT_MIN_WIDTH - PANE_DRAWER_PEEK);
    expect(result.allocation.overflowWidth).toBe(0);
    // No rail over a drawer.
    expect(result.slotFits).toBe(false);
  });

  it('two panes on the narrowest window: stacked, in the drawer', () => {
    const result = fitAt(SIDEBAR_MIN_WIDTH + CHAT_MIN_WIDTH, ['changes', 'files'], null);
    expect(result.view.columns).toBe(1);
    expect(result.view.panes).toHaveLength(2);
    expect(result.allocation.editorOverlay).toBe(true);
  });

  it('nothing spills at any window width down to the minimum', () => {
    for (let width = 640; width <= 2000; width += 8) {
      for (const panes of [
        [],
        ['changes'],
        ['changes', 'files'],
        ['changes', 'files', 'git'],
      ] as PaneKind[][]) {
        for (const slot of [null, RAIL, DOCK]) {
          const result = fitAt(width, panes, slot);
          expect(result.allocation.overflowWidth).toBe(0);
          expect(result.allocation.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
          if (result.slotFits && slot) {
            expect(result.allocation.chatWidth - slot.width).toBeGreaterThanOrEqual(slot.minChat);
          }
          if (!result.allocation.editorOverlay) {
            expect(
              result.allocation.sidebarWidth +
                result.allocation.chatWidth +
                result.allocation.editorWidth
            ).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });

  it('a wider window undoes every step (nothing is stored)', () => {
    const narrow = fitAt(900, ['changes', 'files'], RAIL);
    const wide = fitAt(2000, ['changes', 'files'], RAIL);
    expect(narrow.view.columns).toBe(1);
    expect(wide.view.columns).toBe(2);
    expect(wide.slotFits).toBe(true);
  });
});
