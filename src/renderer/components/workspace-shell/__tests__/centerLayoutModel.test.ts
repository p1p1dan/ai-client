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

  it('echoes the panel choice, and the rail is its exact complement', () => {
    expect(vis({ panelOpen: true })).toMatchObject({ panelVisible: true, railVisible: false });
    expect(vis({ panelOpen: false })).toMatchObject({ panelVisible: false, railVisible: true });
  });

  it('shows chat unless the editor head explicitly hid it', () => {
    expect(vis({ manualChat: null }).chatVisible).toBe(true);
    expect(vis({ manualChat: true }).chatVisible).toBe(true);
    expect(vis({ manualChat: false }).chatVisible).toBe(false);
  });

  it('takes no width at all — a window size can no longer hide anything', () => {
    // The structural guarantee behind the ruling, stated as a type-level fact:
    // there is no width to pass, so no threshold can exist.
    expect(Object.keys(vis())).toEqual([
      'sidebarCollapsed',
      'panelVisible',
      'railVisible',
      'chatVisible',
    ]);
  });
});

// ── clip, don`t collapse ────────────────────────────────────────────────

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
    railVisible: false,
    ...overrides,
  });

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

  it('never puts chat below its floor, however little room is left', () => {
    for (const shellWidth of [2000, 1200, 900, 700, 500, 300, 120]) {
      for (const editorOpen of [false, true]) {
        for (const panelWidth of [PANEL, 900, 1400]) {
          const result = alloc({ shellWidth, editorOpen, panelWidth });
          expect(result.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
        }
      }
    }
  });

  it('never puts the editor below its floor either', () => {
    for (const shellWidth of [2000, 1200, 900, 700, 300]) {
      const result = alloc({ shellWidth, editorOpen: true });
      expect(result.editorWidth).toBeGreaterThanOrEqual(EDITOR_MIN_WIDTH);
    }
  });

  it('gives chat the whole center row when no file is open', () => {
    const result = alloc({ shellWidth: 2000 });
    expect(result.chatWidth).toBe(result.centerWidth);
    expect(result.editorWidth).toBe(0);
    expect(result.centerWidth).toBe(2000 - SIDEBAR - PANEL);
  });

  it('splits the center row by the ratio when a file is open', () => {
    const result = alloc({ shellWidth: 2000, editorOpen: true, editorRatio: 0.5 });
    expect(result.chatWidth + result.editorWidth).toBe(result.centerWidth);
    expect(result.chatWidth).toBe(Math.round(result.centerWidth * 0.5));
  });

  it('gives the row to the editor alone when the user hid chat', () => {
    const result = alloc({ shellWidth: 2000, editorOpen: true, chatVisible: false });
    expect(result.chatWidth).toBe(0);
    expect(result.editorWidth).toBe(result.centerWidth);
  });

  it('reserves the rail when it is showing — it is the only way back', () => {
    const withRail = alloc({ shellWidth: 2000, panelVisible: false, railVisible: true });
    expect(withRail.centerWidth).toBe(2000 - SIDEBAR - RAIL_RESERVE);
    expect(withRail.panelWidth).toBe(0);
  });
});

describe('resolveShellAllocation — the right edge clips, nothing collapses', () => {
  it('reports no clipping while everything fits', () => {
    const result = alloc({ shellWidth: 2000 });
    expect(result.clipped).toBe(false);
    expect(result.clippedWidth).toBe(0);
  });

  it('keeps the panel at the width the user set and clips the overflow', () => {
    // 900 - 280 sidebar = 620 for chat + panel, but chat`s floor is 400 and
    // the panel wants 380: 160px has to go off the edge.
    const result = alloc({ shellWidth: 900 });
    expect(result.panelWidth).toBe(PANEL);
    expect(result.chatWidth).toBe(CHAT_MIN_WIDTH);
    expect(result.clippedWidth).toBe(CHAT_MIN_WIDTH + PANEL - (900 - SIDEBAR));
    expect(result.clipped).toBe(true);
  });

  it('reveals the hidden part pixel for pixel as the window widens', () => {
    // 「将 UI 拖长后根据拖得长度显示被遮盖隐藏的内容」— one revealed pixel per
    // gained pixel, with no step, no threshold and no hysteresis anywhere.
    let previous = alloc({ shellWidth: 800 }).clippedWidth;
    expect(previous).toBe(CHAT_MIN_WIDTH + PANEL - (800 - SIDEBAR));
    for (const shellWidth of [850, 900, 950, 1000]) {
      const next = alloc({ shellWidth }).clippedWidth;
      expect(next).toBe(previous - 50);
      previous = next;
    }
    // 280 + 400 + 380 = 1060 is where the last clipped pixel disappears — a
    // CONSEQUENCE of the three widths, not a threshold anyone wrote down.
    expect(alloc({ shellWidth: 1060 }).clipped).toBe(false);
    expect(alloc({ shellWidth: 1059 }).clippedWidth).toBe(1);
  });

  it('never hides a column to avoid clipping — the columns are all still there', () => {
    for (const shellWidth of [2000, 1200, 900, 700, 500, 300, 120]) {
      for (const editorOpen of [false, true]) {
        const result = alloc({ shellWidth, editorOpen });
        expect(result.sidebarWidth).toBeGreaterThan(0);
        expect(result.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
        expect(result.panelWidth).toBe(PANEL);
        if (editorOpen) {
          expect(result.editorWidth).toBeGreaterThanOrEqual(EDITOR_MIN_WIDTH);
        }
      }
    }
  });

  it('clips the editor too once the panel alone cannot absorb the shortfall', () => {
    // 700 - 280 = 420 for chat(400) + editor(520) + panel(380): the panel is
    // entirely off the edge and the editor is partly off it as well.
    const result = alloc({ shellWidth: 700, editorOpen: true });
    expect(result.chatWidth).toBe(CHAT_MIN_WIDTH);
    expect(result.editorWidth).toBe(EDITOR_MIN_WIDTH);
    expect(result.clippedWidth).toBe(CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH + PANEL - 420);
  });

  it('widening the panel by drag never removes anything, it only clips more', () => {
    // The round-10 ② property, restated for the new model: the failure mode it
    // fixed (drag → panel disappears) is now structurally impossible.
    let previous = alloc({ shellWidth: 1200, panelWidth: PANEL });
    for (const panelWidth of [500, 800, 1100, 1400]) {
      const next = alloc({ shellWidth: 1200, panelWidth });
      expect(next.panelWidth).toBe(panelWidth);
      expect(next.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
      expect(next.clippedWidth).toBeGreaterThanOrEqual(previous.clippedWidth);
      previous = next;
    }
  });

  it('grants everything as requested before the first measurement', () => {
    // A first paint that guessed would flash a cut-off layout for one frame.
    const result = alloc({ shellWidth: null, editorOpen: true });
    expect(result.clipped).toBe(false);
    expect(result.chatWidth).toBe(CHAT_MIN_WIDTH);
    expect(result.editorWidth).toBe(EDITOR_MIN_WIDTH);
    expect(result.panelWidth).toBe(PANEL);
  });
});

describe('resolveShellAllocation — the round-11 report, end to end', () => {
  /**
   * The exact symptom that triggered the ruling: sidebar collapsed, a file
   * open so chat and the editor share the center row, and clicking "expand
   * sidebar" did nothing — the user had to hide chat by hand to free the room
   * first. Under the ladder the click WAS registered and then reverted; under
   * round-10`s ChromeIntent it was still reverted, because the intent fix only
   * ever mirrored the panel and the editor was never in the yield order.
   */
  const NARROW = 1100;
  const collapsed = {
    shellWidth: NARROW,
    sidebarCollapsed: true,
    chatVisible: true,
    editorOpen: true,
    panelVisible: false,
    railVisible: true,
  } as const;

  it('expanding the sidebar takes effect and STAYS, with chat still shown', () => {
    const before = alloc(collapsed);
    const after = alloc({ ...collapsed, sidebarCollapsed: false });

    // The whole bug: this used to come back collapsed again.
    expect(after.sidebarWidth).toBe(SIDEBAR);
    expect(after.sidebarWidth).toBeGreaterThan(before.sidebarWidth);
    // …and chat is not sacrificed to pay for it.
    expect(after.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
  });

  it('the right edge absorbs the cost — nothing is hidden to make room', () => {
    const after = alloc({ ...collapsed, sidebarCollapsed: false });
    const chrome = resolveShellChrome({
      sidebarUserCollapsed: false,
      panelOpen: false,
      manualChat: null,
    });
    expect(chrome.sidebarCollapsed).toBe(false);
    expect(chrome.chatVisible).toBe(true);

    // The 232px the sidebar just claimed are paid for out of the right edge:
    // first the slack the row happened to have, then real clipping. Nothing
    // is hidden and nothing is squeezed below a floor to fund it.
    const before = alloc(collapsed);
    expect(before.clipped).toBe(false);
    const rowAfter = NARROW - SIDEBAR - RAIL_RESERVE;
    expect(after.clippedWidth).toBe(CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH - rowAfter);
    expect(after.clipped).toBe(true);
    // Conservation: every pixel the sidebar gained is accounted for as either
    // room the row already had spare, or room now past the edge.
    expect(before.centerWidth - after.centerWidth + after.clippedWidth).toBe(
      SIDEBAR - SIDEBAR_COLLAPSED_RESERVE
    );
  });

  it('the user can still collapse it again — control is never taken away', () => {
    const reCollapsed = alloc({ ...collapsed, sidebarCollapsed: true });
    expect(reCollapsed.sidebarWidth).toBe(SIDEBAR_COLLAPSED_RESERVE);
  });

  it('holds for the panel-open variant of the same scene', () => {
    const after = alloc({
      ...collapsed,
      sidebarCollapsed: false,
      panelVisible: true,
      railVisible: false,
    });
    expect(after.sidebarWidth).toBe(SIDEBAR);
    expect(after.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_WIDTH);
    expect(after.panelWidth).toBe(PANEL);
    expect(after.clipped).toBe(true);
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
