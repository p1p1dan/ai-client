import { describe, expect, it } from 'vitest';
import {
  CHAT_MIN_WIDTH,
  chatWidthToEditorRatio,
  clampEditorRatio,
  contentFloor,
  DEFAULT_EDITOR_RATIO,
  deriveEditorOpen,
  EDITOR_MIN_WIDTH,
  MAX_EDITOR_RATIO,
  MIN_EDITOR_RATIO,
  maxPanelWidth,
  PANEL_MIN_RESERVE,
  RAIL_RESERVE,
  reduceChromeIntent,
  resolveChatColumnWidth,
  resolveShellChrome,
  SIDEBAR_COLLAPSED_RESERVE,
} from '../centerLayoutModel';

describe('clampEditorRatio', () => {
  it('keeps a ratio inside 0.25..0.75', () => {
    expect(clampEditorRatio(0.5)).toBe(0.5);
    expect(clampEditorRatio(0.1)).toBe(MIN_EDITOR_RATIO);
    expect(clampEditorRatio(0.99)).toBe(MAX_EDITOR_RATIO);
  });

  it('falls back to the default for anything non-finite', () => {
    expect(clampEditorRatio(Number.NaN)).toBe(DEFAULT_EDITOR_RATIO);
    expect(clampEditorRatio(Number.POSITIVE_INFINITY)).toBe(DEFAULT_EDITOR_RATIO);
    expect(clampEditorRatio(undefined as unknown as number)).toBe(DEFAULT_EDITOR_RATIO);
  });
});

describe('resolveChatColumnWidth', () => {
  const roomy = CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH + 400; // 1320

  it('splits the row by the ratio when the ratio is reachable', () => {
    // 2000 wide: chat may run 400..1480, so a 0.5 split is reachable.
    expect(resolveChatColumnWidth({ centerWidth: 2000, editorRatio: 0.5 })).toBe(1000);
    expect(resolveChatColumnWidth({ centerWidth: 2000, editorRatio: 0.6 })).toBe(800);
  });

  it('lets the editor floor beat the persisted ratio, not the other way round', () => {
    // The floors are hard and the ratio is a preference. At 1000 wide a 0.5
    // split wants 500 for chat, but that leaves the editor 500 — under its
    // 520 floor — so chat gets 480 instead. The persisted ratio is NOT
    // rewritten; widen the window and the 0.5 split comes back.
    expect(resolveChatColumnWidth({ centerWidth: 1000, editorRatio: 0.5 })).toBe(480);
    expect(resolveChatColumnWidth({ centerWidth: roomy, editorRatio: 0.25 })).toBe(
      roomy - EDITOR_MIN_WIDTH
    );
  });

  it('keeps the editor at or above its floor for every width where chat renders', () => {
    // "Where chat renders" is the qualifier that matters: at or above the L1
    // threshold both floors fit, so neither column is ever squeezed. Below it
    // the ladder is at L2 and chat is not rendered at all, which is why
    // `resolveChatColumnWidth` may stop honouring the editor floor down there.
    for (const centerWidth of [920, 1000, 1320, 2400]) {
      const chat = resolveChatColumnWidth({ centerWidth, editorRatio: MIN_EDITOR_RATIO });
      expect(chat).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
      expect(centerWidth - chat).toBeGreaterThanOrEqual(EDITOR_MIN_WIDTH);
    }
  });

  it('holds chat`s floor while there is room for both', () => {
    const width = resolveChatColumnWidth({ centerWidth: 1000, editorRatio: MAX_EDITOR_RATIO });
    expect(width).toBe(CHAT_MIN_WIDTH);
  });

  it('NEVER squeezes chat below its floor — the ladder hides it instead (m-T32)', () => {
    // User report: 「聊天页面极度变形」. 800 < 400 + 520, and the old behaviour
    // handed chat the 280px shortfall. A deformed strip is worse than no
    // strip: at this width `resolveShellLevel` is already L2, so chat is not
    // rendered at all — and if it ever is, it is readable.
    for (const centerWidth of [800, 700, EDITOR_MIN_WIDTH, 100]) {
      expect(resolveChatColumnWidth({ centerWidth, editorRatio: 0.5 })).toBeGreaterThanOrEqual(
        CHAT_MIN_WIDTH
      );
    }
  });

  it('hands the shortfall to the editor, which can scroll, not to chat', () => {
    expect(resolveChatColumnWidth({ centerWidth: 800, editorRatio: 0.5 })).toBe(CHAT_MIN_WIDTH);
  });

  it('falls back to the chat floor before the first measurement', () => {
    expect(resolveChatColumnWidth({ centerWidth: 0, editorRatio: 0.5 })).toBe(CHAT_MIN_WIDTH);
    expect(resolveChatColumnWidth({ centerWidth: Number.NaN, editorRatio: 0.5 })).toBe(
      CHAT_MIN_WIDTH
    );
  });
});

describe('chatWidthToEditorRatio', () => {
  it('inverts resolveChatColumnWidth for every ratio that row can actually reach', () => {
    // At 1600 the reachable band is 0.325 (chat pinned at 1600-520) to 0.75
    // (chat pinned at its own 400 floor). Inside it the round trip is exact;
    // outside it `resolveChatColumnWidth` has already clamped, so asking the
    // inverse to return the unreachable input would be asserting a lie.
    const centerWidth = 1600;
    for (const ratio of [0.4, 0.5, 0.6, 0.75]) {
      const width = resolveChatColumnWidth({ centerWidth, editorRatio: ratio });
      expect(chatWidthToEditorRatio({ chatWidth: width, centerWidth })).toBeCloseTo(ratio, 2);
    }
  });

  it('clamps a drag past either end instead of persisting an unusable ratio', () => {
    expect(chatWidthToEditorRatio({ chatWidth: 1590, centerWidth: 1600 })).toBe(MIN_EDITOR_RATIO);
    expect(chatWidthToEditorRatio({ chatWidth: 10, centerWidth: 1600 })).toBe(MAX_EDITOR_RATIO);
  });

  it('falls back to the default for an unmeasured row', () => {
    expect(chatWidthToEditorRatio({ chatWidth: 500, centerWidth: 0 })).toBe(DEFAULT_EDITOR_RATIO);
    expect(chatWidthToEditorRatio({ chatWidth: Number.NaN, centerWidth: 1600 })).toBe(
      DEFAULT_EDITOR_RATIO
    );
  });
});

describe('deriveEditorOpen', () => {
  it('is true from the first tab, before one is active', () => {
    expect(deriveEditorOpen(0)).toBe(false);
    expect(deriveEditorOpen(1)).toBe(true);
    expect(deriveEditorOpen(7)).toBe(true);
  });

  it('is false for garbage counts rather than throwing', () => {
    expect(deriveEditorOpen(Number.NaN)).toBe(false);
    expect(deriveEditorOpen(-1)).toBe(false);
  });
});

// ── chrome yields, content has a floor (m5) ─────────────────────────────

const SIDEBAR = 280;
const PANEL = 380;

function chrome(overrides: Partial<Parameters<typeof resolveShellChrome>[0]> = {}) {
  return resolveShellChrome({
    shellWidth: 2000,
    sidebarWidth: SIDEBAR,
    sidebarUserCollapsed: false,
    panelWidth: PANEL,
    editorOpen: false,
    panelOpen: true,
    manualPanel: null,
    manualChat: null,
    ...overrides,
  });
}

describe('contentFloor', () => {
  it('reserves chat alone, chat + editor, or editor alone', () => {
    expect(contentFloor({ chatWanted: true, editorOpen: false })).toBe(CHAT_MIN_WIDTH);
    expect(contentFloor({ chatWanted: true, editorOpen: true })).toBe(
      CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH
    );
    expect(contentFloor({ chatWanted: false, editorOpen: true })).toBe(EDITOR_MIN_WIDTH);
  });
});

describe('resolveShellChrome — yield order is sidebar → panel → chat', () => {
  it('honours every preference when the width allows', () => {
    expect(chrome({ shellWidth: 2000 })).toMatchObject({
      sidebarCollapsed: false,
      panelVisible: true,
      chatVisible: true,
      railVisible: false,
    });
  });

  it('collapses the SIDEBAR first, before touching the panel', () => {
    // 900 = 280 sidebar + 380 panel leaves 240 for chat, under its 400 floor.
    // Collapsing the sidebar frees 232 and brings chat back over the line, so
    // the panel must survive untouched.
    const result = chrome({ shellWidth: 900 });
    expect(result.sidebarCollapsed).toBe(true);
    expect(result.sidebarAutoCollapsed).toBe(true);
    expect(result.panelVisible).toBe(true);
    expect(result.chatVisible).toBe(true);
  });

  it('gives up the panel only after the collapsed sidebar is still not enough', () => {
    // 48 + 380 + 400 = 828; below that the panel is what goes next.
    const result = chrome({ shellWidth: 800 });
    expect(result.sidebarCollapsed).toBe(true);
    expect(result.panelVisible).toBe(false);
    expect(result.railVisible).toBe(true);
    expect(result.chatVisible).toBe(true);
  });

  it('never hides chat when no file is open — chat IS the shell then', () => {
    for (const shellWidth of [700, 500, 300, 120]) {
      expect(chrome({ shellWidth, editorOpen: false }).chatVisible).toBe(true);
    }
  });

  it('hides chat last, and only with an editor to fall back to', () => {
    // 48 + 44 + 400 + 520 = 1012 needed to keep both; below it chat goes.
    const result = chrome({ shellWidth: 700, editorOpen: true });
    expect(result.chatVisible).toBe(false);
    expect(result.panelVisible).toBe(false);
    expect(result.sidebarCollapsed).toBe(true);
  });

  it('does not auto-collapse a sidebar the user already collapsed', () => {
    const result = chrome({ shellWidth: 800, sidebarUserCollapsed: true });
    expect(result.sidebarCollapsed).toBe(true);
    // The distinction matters: `sidebarAutoCollapsed` drives an affordance and
    // must not claim credit for the user's own toggle.
    expect(result.sidebarAutoCollapsed).toBe(false);
  });

  it('lets an explicit panel summon outrank the yield (user round 1, m2)', () => {
    // The exact report: on a narrow window the panel could not be summoned
    // back at all, because the automatic rung kept overruling the click.
    const result = chrome({ shellWidth: 800, manualPanel: true });
    expect(result.panelVisible).toBe(true);
  });

  it('lets an explicit chat un-hide outrank the yield too', () => {
    const result = chrome({ shellWidth: 700, editorOpen: true, manualChat: true });
    expect(result.chatVisible).toBe(true);
  });

  it('respects an explicit close even when there is plenty of room', () => {
    expect(chrome({ shellWidth: 2000, manualPanel: false }).panelVisible).toBe(false);
    expect(chrome({ shellWidth: 2000, editorOpen: true, manualChat: false }).chatVisible).toBe(
      false
    );
  });

  it('honours every preference before the first measurement', () => {
    const result = chrome({ shellWidth: null });
    expect(result).toMatchObject({
      sidebarCollapsed: false,
      panelVisible: true,
      chatVisible: true,
    });
  });

  it('keeps rail and panel visibility exact complements at every width', () => {
    for (const shellWidth of [2000, 1200, 900, 800, 700, 400]) {
      for (const editorOpen of [false, true]) {
        const result = chrome({ shellWidth, editorOpen });
        expect(result.railVisible).toBe(!result.panelVisible);
      }
    }
  });
});

// ── round-10 GUI review ① — symmetric expand ────────────────────────────

describe('reduceChromeIntent', () => {
  const both = (sidebarExpanded: boolean, panelOpen: boolean) => ({ sidebarExpanded, panelOpen });

  it('records whichever column the user just asked for', () => {
    expect(reduceChromeIntent(null, both(false, false), both(true, false))).toBe('sidebar');
    expect(reduceChromeIntent(null, both(false, false), both(false, true))).toBe('panel');
  });

  it('lets the newer ask take over from the older one', () => {
    expect(reduceChromeIntent('sidebar', both(true, false), both(true, true))).toBe('panel');
    expect(reduceChromeIntent('panel', both(false, true), both(true, true))).toBe('sidebar');
  });

  it('clears the intent when the column it favoured retreats', () => {
    // Collapsing the sidebar again removes the contention, so the panel must
    // be free to come back on its own.
    expect(reduceChromeIntent('sidebar', both(true, true), both(false, true))).toBeNull();
    expect(reduceChromeIntent('panel', both(true, true), both(true, false))).toBeNull();
  });

  it('holds steady when nothing transitioned (idempotent under StrictMode)', () => {
    for (const prev of ['sidebar', 'panel', null] as const) {
      const snapshot = both(true, true);
      expect(reduceChromeIntent(prev, snapshot, snapshot)).toBe(prev);
    }
  });

  it('resolves a same-tick swap to the panel, matching A08`s default order', () => {
    expect(reduceChromeIntent(null, both(false, false), both(true, true))).toBe('panel');
  });
});

describe('resolveShellChrome — expanding either column is symmetric (round 10 ①)', () => {
  // 900: 280 + 380 + 400 = 1060 needed for all three, so the two columns
  // genuinely contend and exactly one of them has to yield.
  const CONTENDED = 900;

  it('reproduces the report: without an intent the sidebar is the one that yields', () => {
    const result = chrome({ shellWidth: CONTENDED });
    expect(result.sidebarCollapsed).toBe(true);
    expect(result.panelVisible).toBe(true);
  });

  it('expanding the SIDEBAR squeezes the panel out instead of undoing itself', () => {
    const result = chrome({ shellWidth: CONTENDED, chromeIntent: 'sidebar' });
    // The whole defect: this used to come back `sidebarCollapsed: true`, so
    // the expand button looked dead.
    expect(result.sidebarCollapsed).toBe(false);
    expect(result.sidebarAutoCollapsed).toBe(false);
    expect(result.panelVisible).toBe(false);
    expect(result.railVisible).toBe(true);
    expect(result.chatVisible).toBe(true);
  });

  it('expanding the PANEL still collapses the sidebar — the mirror case', () => {
    const result = chrome({ shellWidth: CONTENDED, chromeIntent: 'panel' });
    expect(result.sidebarCollapsed).toBe(true);
    expect(result.panelVisible).toBe(true);
  });

  it('keeps chat last in the yield order under either intent', () => {
    for (const chromeIntent of ['sidebar', 'panel', null] as const) {
      expect(chrome({ shellWidth: CONTENDED, chromeIntent }).chatVisible).toBe(true);
    }
  });

  it('still collapses the sidebar when dropping the panel alone is not enough', () => {
    // 700 - 280 sidebar - 44 rail = 376, under chat's 400 floor: the sidebar
    // has to go too. The intent reorders the rungs, it does not delete one.
    const result = chrome({ shellWidth: 700, chromeIntent: 'sidebar' });
    expect(result.sidebarCollapsed).toBe(true);
    expect(result.panelVisible).toBe(false);
    expect(result.chatVisible).toBe(true);
  });

  it('never overrules an explicitly summoned panel (m2 semantics preserved)', () => {
    const result = chrome({ shellWidth: CONTENDED, chromeIntent: 'sidebar', manualPanel: true });
    expect(result.panelVisible).toBe(true);
    // The sidebar is what yields instead — m2's guarantee outranks the intent.
    expect(result.sidebarCollapsed).toBe(true);
  });

  it('leaves an explicit chat override alone under either intent', () => {
    const result = chrome({
      shellWidth: 700,
      editorOpen: true,
      manualChat: true,
      chromeIntent: 'sidebar',
    });
    expect(result.chatVisible).toBe(true);
  });

  it('changes nothing at a width where everything already fits', () => {
    for (const chromeIntent of ['sidebar', 'panel', null] as const) {
      expect(chrome({ shellWidth: 2000, chromeIntent })).toMatchObject({
        sidebarCollapsed: false,
        panelVisible: true,
        chatVisible: true,
      });
    }
  });

  it('keeps rail and panel exact complements under every intent', () => {
    for (const chromeIntent of ['sidebar', 'panel', null] as const) {
      for (const shellWidth of [2000, 1200, 900, 800, 700, 400]) {
        for (const editorOpen of [false, true]) {
          const result = chrome({ shellWidth, editorOpen, chromeIntent });
          expect(result.railVisible).toBe(!result.panelVisible);
        }
      }
    }
  });
});

// ── round-10 GUI review ② — dragging never hides the panel ──────────────

describe('resolveShellChrome — the ladder judges the panel at its floor (round 10 ②)', () => {
  it('uses the panel floor A08`s own thresholds are built from', () => {
    // `L0 = 1580 = 280 + 400 + 520 + 380` quotes the panel MINIMUM, so the
    // ladder reading a live dragged width was the deviation, not this.
    expect(PANEL).toBe(PANEL_MIN_RESERVE);
  });

  it('does not react to how wide the user dragged the panel', () => {
    // The report: at a width where the panel fits at its 380 floor, dragging
    // it wider used to walk the ladder down and hide it entirely.
    for (const panelWidth of [PANEL, 600, 900, 1400]) {
      const result = chrome({ shellWidth: 1200, panelWidth });
      expect(result.panelVisible).toBe(true);
      expect(result.sidebarCollapsed).toBe(false);
    }
  });

  it('is byte-for-byte identical for every panelWidth at every shell width', () => {
    for (const shellWidth of [2000, 1200, 1060, 900, 828, 800, 700, 400]) {
      for (const editorOpen of [false, true]) {
        const atFloor = chrome({ shellWidth, editorOpen, panelWidth: PANEL });
        for (const panelWidth of [600, 1000, 1400]) {
          expect(chrome({ shellWidth, editorOpen, panelWidth })).toEqual(atFloor);
        }
      }
    }
  });

  it('the widest width the panel may take never re-triggers a downgrade', () => {
    // The end-to-end property behind ②: commit the largest draggable width,
    // feed it back through the ladder, and the panel must still be there.
    for (const shellWidth of [1060, 1200, 1500, 2000]) {
      for (const editorOpen of [false, true]) {
        const first = chrome({ shellWidth, editorOpen });
        if (!first.panelVisible) continue;
        const cap = maxPanelWidth({
          shellWidth,
          sidebarWidth: first.sidebarCollapsed ? SIDEBAR_COLLAPSED_RESERVE : SIDEBAR,
          editorOpen,
          chatVisible: first.chatVisible,
        });
        const dragged = chrome({ shellWidth, editorOpen, panelWidth: cap ?? PANEL });
        expect(dragged.panelVisible).toBe(true);
        expect(dragged).toEqual(first);
      }
    }
  });
});

describe('maxPanelWidth', () => {
  it('never lets the panel eat the content floor (m5, the 65px composer bug)', () => {
    // Screenshot: a 380-min panel had taken ~860px of a 1530px shell, leaving
    // chat 270px and its composer 65px, wrapping one character per line.
    const cap = maxPanelWidth({
      shellWidth: 1530,
      sidebarWidth: 400,
      editorOpen: false,
      chatVisible: true,
    });
    expect(cap).toBe(1530 - 400 - CHAT_MIN_WIDTH);
    expect(1530 - 400 - (cap ?? 0)).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
  });

  it('reserves the editor floor too when a file is open', () => {
    expect(
      maxPanelWidth({ shellWidth: 2000, sidebarWidth: 280, editorOpen: true, chatVisible: true })
    ).toBe(2000 - 280 - CHAT_MIN_WIDTH - EDITOR_MIN_WIDTH);
  });

  it('reserves nothing for a hidden chat', () => {
    expect(
      maxPanelWidth({ shellWidth: 1000, sidebarWidth: 48, editorOpen: true, chatVisible: false })
    ).toBe(1000 - 48 - EDITOR_MIN_WIDTH);
  });

  it('clamps to 0 rather than going negative, and defers before measurement', () => {
    expect(
      maxPanelWidth({ shellWidth: 300, sidebarWidth: 280, editorOpen: false, chatVisible: true })
    ).toBe(0);
    expect(
      maxPanelWidth({ shellWidth: null, sidebarWidth: 280, editorOpen: false, chatVisible: true })
    ).toBeNull();
  });
});

describe('reserve constants match the shell they describe', () => {
  it('mirrors the rail and collapsed-sidebar widths', () => {
    expect(RAIL_RESERVE).toBe(44);
    expect(SIDEBAR_COLLAPSED_RESERVE).toBe(48);
  });
});
