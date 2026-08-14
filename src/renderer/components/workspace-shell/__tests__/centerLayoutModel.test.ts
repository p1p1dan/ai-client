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
  PANEL_MIN_USEFUL_WIDTH,
  RAIL_RESERVE,
  resolveChatColumnWidth,
  resolveShellAllocation,
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

describe('contentFloor', () => {
  it('reserves chat alone, chat + editor, or editor alone', () => {
    expect(contentFloor({ chatWanted: true, editorOpen: false })).toBe(CHAT_MIN_WIDTH);
    expect(contentFloor({ chatWanted: true, editorOpen: true })).toBe(
      CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH
    );
    expect(contentFloor({ chatWanted: false, editorOpen: true })).toBe(EDITOR_MIN_WIDTH);
  });
});

/**
 * ## OVERTURNED DESIGN — what used to be asserted here
 *
 * This block replaced 30 cases across four describes, all of them pinning
 * behavior the user overturned on 2026-08-05 (round-11 GUI review):
 *
 *  - `resolveShellChrome — yield order is sidebar → panel → chat` (11) — T-32's
 *    L0/L1/L2 ladder, A08 a08:1421-1422's `1580` / `1244` thresholds;
 *  - `reduceChromeIntent` (5) and `resolveShellChrome — expanding either column
 *    is symmetric` (9) — round-10's fix for the ladder's asymmetry;
 *  - `resolveShellChrome — the ladder judges the panel at its floor` (4) — the
 *    round-10 ② repair, whose PROPERTY survives below in a stronger form (a
 *    drag can still never make the panel disappear — now because nothing can).
 *
 * They are deleted rather than skipped: every one of them asserts that the
 * model overrules a visibility the user chose, which is the single thing the
 * ruling forbids. A zombie `it.skip` here would read as "temporarily off".
 *
 * The ruling: 「优先保证左侧栏目和 chat（无论多大都可以显示并且正常控制折叠），然后
 * 右侧栏目在空间不足时也不要自动缩起，而是正常显示，只是 UI 大小不足时无法显示出来，
 * 将 UI 拖长后根据拖得长度显示被遮盖隐藏的内容。」
 */
describe('resolveShellChrome — visibility is the user`s, verbatim', () => {
  const vis = (overrides: Partial<Parameters<typeof resolveShellChrome>[0]> = {}) =>
    resolveShellChrome({
      sidebarUserCollapsed: false,
      panelOpen: true,
      manualChat: null,
      ...overrides,
    });

  it('echoes the sidebar toggle without ever second-guessing it', () => {
    expect(vis({ sidebarUserCollapsed: false }).sidebarCollapsed).toBe(false);
    expect(vis({ sidebarUserCollapsed: true }).sidebarCollapsed).toBe(true);
  });

  it('echoes the panel choice', () => {
    expect(vis({ panelOpen: true }).panelVisible).toBe(true);
    expect(vis({ panelOpen: false }).panelVisible).toBe(false);
  });

  it('shows chat unless the editor head explicitly hid it', () => {
    expect(vis({ manualChat: null }).chatVisible).toBe(true);
    expect(vis({ manualChat: true }).chatVisible).toBe(true);
    expect(vis({ manualChat: false }).chatVisible).toBe(false);
  });

  it('no longer reports rail visibility — round 12 made it permanent, D34 retired it into MainHeader', () => {
    // OVERTURNED (round 12): A08「展开时右缘无图标」made the rail the panel's
    // complement; round-12 made it the one always-present switcher instead, so
    // a `railVisible` field could only ever be `true` — a zombie by
    // construction. OVERTURNED again (D34): the rail is gone entirely (its
    // icons moved into MainHeader), so there is even less to report.
    expect(vis()).not.toHaveProperty('railVisible');
    expect(Object.keys(vis())).toEqual(['sidebarCollapsed', 'panelVisible', 'chatVisible']);
  });

  it('takes no width at all — a window size can no longer hide anything', () => {
    expect(Object.keys(vis())).not.toContain('shellWidth');
  });
});

// ── compress, don`t clip (round 12) ─────────────────────────────────────

const alloc = (overrides: Partial<Parameters<typeof resolveShellAllocation>[0]> = {}) =>
  resolveShellAllocation({
    shellWidth: 2000,
    sidebarWidth: SIDEBAR,
    sidebarCollapsed: false,
    chatVisible: true,
    editorOpen: false,
    editorRatio: DEFAULT_EDITOR_RATIO,
    panelVisible: true,
    panelWidth: PANEL,
    ...overrides,
  });

/** Room the panel is competing for at a given shell width, chat-only shell. */
const roomFor = (shellWidth: number, sidebar = SIDEBAR) =>
  shellWidth - sidebar - RAIL_RESERVE - CHAT_MIN_WIDTH;

describe('resolveShellAllocation — sidebar and chat are satisfied first', () => {
  it('grants the sidebar its full width at every shell width', () => {
    for (const shellWidth of [2000, 1200, 900, 700, 500, 300]) {
      expect(alloc({ shellWidth }).sidebarWidth).toBe(SIDEBAR);
    }
  });

  it('grants the collapsed sidebar its 48px, never less', () => {
    for (const shellWidth of [2000, 700, 300]) {
      expect(alloc({ shellWidth, sidebarCollapsed: true }).sidebarWidth).toBe(
        SIDEBAR_COLLAPSED_RESERVE
      );
    }
  });

  it('never puts chat or the editor below their floors, at any width', () => {
    for (const shellWidth of [2000, 1200, 900, 700, 500, 300, 120]) {
      for (const editorOpen of [false, true]) {
        for (const panelWidth of [PANEL, 900, 1400]) {
          const result = alloc({ shellWidth, editorOpen, panelWidth });
          expect(result.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
          if (editorOpen) {
            expect(result.editorWidth).toBeGreaterThanOrEqual(EDITOR_MIN_WIDTH);
          }
        }
      }
    }
  });

  it('centerWidth`s formula still carries the (now zero) rail term (D34)', () => {
    // D34: the rail retired into MainHeader, so RAIL_RESERVE is 0 — this pin
    // stays to prove the formula still SUBTRACTS the term (symbolically, via
    // the constant) rather than having dropped it, in case a future column
    // fills the role again.
    expect(alloc({ shellWidth: 2000 }).centerWidth).toBe(2000 - SIDEBAR - RAIL_RESERVE - PANEL);
    expect(alloc({ shellWidth: 2000, panelVisible: false }).centerWidth).toBe(
      2000 - SIDEBAR - RAIL_RESERVE
    );
  });

  it('gives chat the whole center row when no file is open', () => {
    const result = alloc({ shellWidth: 2000 });
    expect(result.chatWidth).toBe(result.centerWidth);
    expect(result.editorWidth).toBe(0);
  });

  it('splits the center row by the ratio when a file is open', () => {
    const result = alloc({ shellWidth: 2000, editorOpen: true, editorRatio: 0.5 });
    expect(result.chatWidth + result.editorWidth).toBe(result.centerWidth);
  });

  it('gives the row to the editor alone when the user hid chat', () => {
    const result = alloc({ shellWidth: 2000, editorOpen: true, chatVisible: false });
    expect(result.chatWidth).toBe(0);
    expect(result.editorWidth).toBe(result.centerWidth);
  });
});

describe('resolveShellAllocation — the panel compresses, it is never cut', () => {
  it('honours the preferred width whenever the room exists', () => {
    const result = alloc({ shellWidth: 2000, panelWidth: 700 });
    expect(result.panelWidth).toBe(700);
    expect(result.panelCompressed).toBe(false);
    expect(result.panelSuppressed).toBe(false);
  });

  it('compresses to exactly the room left after chat`s floor', () => {
    // 1000 - 280 sidebar - 0 rail (D34: retired into MainHeader) - 400 chat =
    // 320 for a panel that wants 380.
    const result = alloc({ shellWidth: 1000 });
    expect(result.panelWidth).toBe(roomFor(1000));
    expect(result.panelCompressed).toBe(true);
    expect(result.chatWidth).toBe(CHAT_MIN_WIDTH);
  });

  it('never reports overflow while the panel still has room to give', () => {
    // The round-11 failure mode: a panel with a slice cut off its right side.
    for (const shellWidth of [2000, 1400, 1200, 1000, 900, 800]) {
      expect(alloc({ shellWidth }).overflowWidth).toBe(0);
    }
  });

  it('yields the last sliver rather than showing a stub of chrome', () => {
    // Just under the useful floor, the panel takes nothing at all.
    const shellWidth = SIDEBAR + RAIL_RESERVE + CHAT_MIN_WIDTH + PANEL_MIN_USEFUL_WIDTH - 1;
    const result = alloc({ shellWidth });
    expect(result.panelWidth).toBe(0);
    expect(result.panelSuppressed).toBe(true);
    // One more pixel and it is worth showing again.
    const wider = alloc({ shellWidth: shellWidth + 1 });
    expect(wider.panelWidth).toBe(PANEL_MIN_USEFUL_WIDTH);
    expect(wider.panelSuppressed).toBe(false);
  });

  it('a suppressed panel is still the user`s active surface, not a closed one', () => {
    // Round-11's rule survives: only the user closes a panel. Zero width is a
    // width outcome and `resolveShellChrome` is untouched by it.
    const result = alloc({ shellWidth: 600 });
    expect(result.panelWidth).toBe(0);
    expect(result.panelSuppressed).toBe(true);
    expect(
      resolveShellChrome({ sidebarUserCollapsed: false, panelOpen: true, manualChat: null })
        .panelVisible
    ).toBe(true);
  });

  it('restores the panel linearly as the window grows back', () => {
    // 「将 UI 拖长后根据拖得长度显示被遮盖隐藏的内容」— one pixel of panel per
    // pixel of window, with no step and no hysteresis, up to the preference.
    const base = SIDEBAR + RAIL_RESERVE + CHAT_MIN_WIDTH;
    for (const room of [PANEL_MIN_USEFUL_WIDTH, 200, 250, 300, 379]) {
      expect(alloc({ shellWidth: base + room }).panelWidth).toBe(room);
    }
    // …and stops growing once the user`s preference is met.
    expect(alloc({ shellWidth: base + PANEL }).panelWidth).toBe(PANEL);
    expect(alloc({ shellWidth: base + PANEL + 500 }).panelWidth).toBe(PANEL);
  });

  it('only chat and the editor can ever overflow, and only past their floors', () => {
    // 500 - 280 - 0 (D34: no rail reserve) = 220 for a 400px chat floor: the
    // panel is long gone, and what is left over is chat`s own overflow inside
    // the clipped row.
    const result = alloc({ shellWidth: 500 });
    expect(result.panelWidth).toBe(0);
    expect(result.chatWidth).toBe(CHAT_MIN_WIDTH);
    expect(result.overflowWidth).toBe(CHAT_MIN_WIDTH - (500 - SIDEBAR - RAIL_RESERVE));
  });

  it('widening the panel by drag only ever compresses it back, never hides it', () => {
    for (const panelWidth of [PANEL, 500, 800, 1400]) {
      const result = alloc({ shellWidth: 1200, panelWidth });
      expect(result.panelWidth).toBeLessThanOrEqual(panelWidth);
      expect(result.panelWidth).toBeGreaterThan(0);
      expect(result.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
    }
  });

  it('grants every preference before the first measurement', () => {
    const result = alloc({ shellWidth: null, editorOpen: true });
    expect(result.panelWidth).toBe(PANEL);
    expect(result.panelCompressed).toBe(false);
    expect(result.overflowWidth).toBe(0);
  });
});

describe('resolveShellAllocation — the round-11 report still holds', () => {
  /**
   * Regression guard for the symptom that produced round-11's ruling: sidebar
   * collapsed, a file open, chat showing, and expanding the sidebar did
   * nothing. Round-12 changed how the shortfall is ABSORBED (compress, was
   * clip); it must not have brought the old behaviour back.
   */
  const NARROW = 1100;
  const collapsed = {
    shellWidth: NARROW,
    sidebarCollapsed: true,
    chatVisible: true,
    editorOpen: true,
    panelVisible: false,
  } as const;

  it('expanding the sidebar takes effect and STAYS, with chat still shown', () => {
    const before = alloc(collapsed);
    const after = alloc({ ...collapsed, sidebarCollapsed: false });
    expect(after.sidebarWidth).toBe(SIDEBAR);
    expect(after.sidebarWidth).toBeGreaterThan(before.sidebarWidth);
    expect(after.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
    expect(after.editorWidth).toBeGreaterThanOrEqual(EDITOR_MIN_WIDTH);
  });

  it('the user can still collapse it again — control is never taken away', () => {
    expect(alloc({ ...collapsed, sidebarCollapsed: true }).sidebarWidth).toBe(
      SIDEBAR_COLLAPSED_RESERVE
    );
  });

  it('holds for the panel-open variant, which now compresses the panel', () => {
    const after = alloc({ ...collapsed, sidebarCollapsed: false, panelVisible: true });
    expect(after.sidebarWidth).toBe(SIDEBAR);
    expect(after.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
    // 1100 - 280 - 0 (D34: no rail reserve) - 920 floors = -100: no room, so
    // the panel yields it all rather than cutting into chat or the editor.
    expect(after.panelWidth).toBe(0);
    expect(after.panelSuppressed).toBe(true);
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
  it('mirrors the collapsed-sidebar width, and the rail reserve is retired (D34)', () => {
    // D34: the rail migrated into MainHeader's top bar, which sits outside
    // this allocator's row — there is nothing left in the content row to
    // reserve width for.
    expect(RAIL_RESERVE).toBe(0);
    expect(SIDEBAR_COLLAPSED_RESERVE).toBe(48);
  });
});
