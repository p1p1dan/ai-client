/**
 * T-32 (D27 / open-q #28 ①): the center column's geometry — `chat ║ editor`
 * side by side (A08 a08:1208-1241), with a grip between them.
 *
 * S3 lands the ratio math here; S4 adds the L0/L1/L2 level ladder that decides
 * whether the panel and the chat column exist at all. Pure so vitest (node env,
 * `.ts` only) can cover it — `shellLayoutModel.ts` pattern.
 */

/** A08 a08:1421 — the minimum widths its degradation thresholds are built from. */
export const CHAT_MIN_WIDTH = 400;
export const EDITOR_MIN_WIDTH = 520;

export const DEFAULT_EDITOR_RATIO = 0.5;
export const MIN_EDITOR_RATIO = 0.25;
export const MAX_EDITOR_RATIO = 0.75;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 0.25..0.75; non-finite → DEFAULT_EDITOR_RATIO. */
export function clampEditorRatio(ratio: number): number {
  if (!isFiniteNumber(ratio)) {
    return DEFAULT_EDITOR_RATIO;
  }
  return clamp(ratio, MIN_EDITOR_RATIO, MAX_EDITOR_RATIO);
}

export interface ResolveChatColumnWidthInput {
  /** Measured width of chat + editor (NOT including the panel or the rail). */
  centerWidth: number;
  /** Persisted share of the center row given to the editor. */
  editorRatio: number;
}

/**
 * Chat's pixel width when the editor column is open.
 *
 * **Chat is never squeezed below its floor.** m-T32 (user round 1: 「聊天页面
 * 极度变形」): this used to let chat absorb the shortfall — at a 800px center
 * row it returned 280px of chat, a deformed strip nobody can read. Both floors
 * are hard; when they cannot both hold, the answer is not a squeezed chat but
 * NO chat, and that is the ladder's job (`resolveShellLevel` drops to L2 at
 * exactly the width where both stop fitting). So this function assumes chat is
 * visible and always returns ≥ CHAT_MIN_WIDTH; callers must consult
 * `deriveChatVisible` first.
 */
export function resolveChatColumnWidth(input: ResolveChatColumnWidthInput): number {
  const { centerWidth, editorRatio } = input;
  if (!isFiniteNumber(centerWidth) || centerWidth <= 0) {
    return CHAT_MIN_WIDTH;
  }

  const max = centerWidth - EDITOR_MIN_WIDTH;
  if (max <= CHAT_MIN_WIDTH) {
    // Too narrow for both. Chat keeps its floor and the editor takes the
    // overflow for the frame or two before the ladder hides chat entirely —
    // never the other way round.
    return CHAT_MIN_WIDTH;
  }

  const desired = Math.round(centerWidth * (1 - clampEditorRatio(editorRatio)));
  return clamp(desired, CHAT_MIN_WIDTH, max);
}

export interface ChatWidthToEditorRatioInput {
  /** Chat width the user just dragged to. */
  chatWidth: number;
  centerWidth: number;
}

/** Inverse of `resolveChatColumnWidth`, for committing a grip drag. */
export function chatWidthToEditorRatio(input: ChatWidthToEditorRatioInput): number {
  const { chatWidth, centerWidth } = input;
  if (!isFiniteNumber(centerWidth) || centerWidth <= 0 || !isFiniteNumber(chatWidth)) {
    return DEFAULT_EDITOR_RATIO;
  }
  return clampEditorRatio(1 - chatWidth / centerWidth);
}

/**
 * "Is a file open" — the single fact the shell keys the whole center column
 * off. Taking the tab count (not `activeTab`) keeps it true during the frame
 * where a tab exists but none is active yet.
 */
export function deriveEditorOpen(openTabCount: number): boolean {
  return isFiniteNumber(openTabCount) && openTabCount > 0;
}

/**
 * A08 §06-4: the user's in-session override of the automatic yielding, cleared
 * when the file closes. `null` means "no override" — A08 writes these as
 * booleans, but a two-state flag cannot say "cleared" without also saying
 * "hidden", which is how an override would outlive the file that scoped it.
 */
export type ManualOverride = boolean | null;

// ── clip, don't collapse (user ruling, 2026-08-05) ──────────────────────

/**
 * ## OVERTURNED DESIGN — read this before re-adding a threshold
 *
 * Two shipped models were overturned by one user ruling on 2026-08-05
 * (round-11 GUI review). Both are gone from this file on purpose; neither is
 * to be reintroduced without a new ruling.
 *
 * **① T-32's L0/L1/L2 degradation ladder** (A08 a08:1421-1422, thresholds
 * `L0 = 1580 = 280 + 400 + 520 + 380` and `L1 = 1244 = 280 + 400 + 520 + 44`).
 * It auto-collapsed the sidebar, then hid the panel, then hid chat, as the
 * window narrowed.
 *
 * **② The round-10 `ChromeIntent` / rung-1a fix**, which made the ladder
 * reorder itself around whichever column the user had last asked for. It made
 * sidebar-vs-panel symmetric and it worked — but it was a patch on the wrong
 * model, and it only ever mirrored the PANEL. The editor was never in the
 * yield order at all, so the same defect survived one seat over: with the
 * sidebar collapsed and `chat + editor` showing, expanding the sidebar still
 * did nothing until the user hid chat by hand to free the room.
 *
 * The ruling (verbatim): 「我感觉这块的逻辑是不是得好好捋一捋。优先保证左侧栏目和
 * chat（无论多大都可以显示并且正常控制折叠），然后右侧栏目在空间不足时也不要自动缩起，
 * 而是正常显示，只是 UI 大小不足时无法显示出来，将 UI 拖长后根据拖得长度显示被遮盖
 * 隐藏的内容。」
 *
 * The root disagreement is not about ORDER, it is about AUTHORITY. Every
 * version of the ladder answered "the window is too narrow" by overruling a
 * visibility the user had chosen — and a user who clicks "expand" and watches
 * the thing collapse again reads the button as broken, which is exactly the
 * bug report we got three rounds running. The user's model removes the
 * question: nothing is ever auto-hidden, and a window too small to show
 * everything simply shows less of it.
 *
 * ## The model now
 *
 *  1. **Visibility is user-owned, full stop.** `resolveShellChrome` echoes the
 *     user's flags and computes nothing. No input can make a column disappear
 *     except the user's own toggle.
 *  2. **Sidebar and chat are satisfied first**, from the left, always at or
 *     above their widths/floors.
 *  3. **Everything else is clipped by the right edge**, not collapsed
 *     (`resolveShellAllocation`). Chat and the editor compress to their floors
 *     first; past that the panel goes off the edge, then the editor. Widening
 *     the window reveals it again, proportionally — no thresholds, no
 *     hysteresis, no state.
 *
 * The reserve constants below survive both models: they are just widths.
 */
/**
 * Round-12: the rail is PERMANENT, so this is reserved at every width.
 *
 * OVERTURNED: A08「展开 = 右缘无图标；收起 = Rail 出现」(a08:1430-1432) made the
 * rail the collapsed-state affordance and gave the panel a horizontal tab
 * strip while open. The user overturned it on 2026-08-06: 「那个展开后的 tab
 * 标签是不是很占位置，要不就使用右侧竖置的图标当切换标签？这样标签是恒定存在的，
 * 只用压缩右侧栏目的展示内容」. One switcher, always in the same place, costing
 * 44px of chrome instead of a 36px-tall strip inside every panel — and it is
 * what makes a 0-width panel recoverable, since the rail survives when
 * nothing else does.
 */
export const RAIL_RESERVE = 44;
/** The panel's PREFERRED width (round-12 demoted it from a hard floor). */
export const PANEL_MIN_RESERVE = 380;
export const SIDEBAR_COLLAPSED_RESERVE = 48;

/**
 * Below this the panel yields its width entirely and only the rail represents
 * it. A 60px stub is all chrome and no content — worse than an honest absence,
 * and it steals room chat still needs.
 */
export const PANEL_MIN_USEFUL_WIDTH = 150;

/** Content the shell refuses to shrink below, given what is open. */
export function contentFloor(input: { chatWanted: boolean; editorOpen: boolean }): number {
  return (input.chatWanted ? CHAT_MIN_WIDTH : 0) + (input.editorOpen ? EDITOR_MIN_WIDTH : 0);
}

export interface ResolveShellChromeInput {
  /** The user's own sidebar toggle. */
  sidebarUserCollapsed: boolean;
  /** `activeSurfaceId !== null` — the user's panel choice. */
  panelOpen: boolean;
  /** The editor head's "hide chat" toggle; `null` = never touched = chat shows. */
  manualChat: ManualOverride;
}

export interface ShellChrome {
  sidebarCollapsed: boolean;
  /**
   * The user's surface choice. Round-12: this is INTENT and no longer implies
   * a non-zero width — a window too narrow to host the panel renders it at 0
   * while this stays true, so widening brings the same surface straight back
   * (`ShellAllocation.panelSuppressed`).
   */
  panelVisible: boolean;
  chatVisible: boolean;
}

/**
 * Visibility = what the user asked for, verbatim.
 *
 * There is deliberately no `shellWidth` parameter. It used to take one, and
 * every defect this function has ever had came from what it did with it. A
 * width cannot make a column invisible any more — it can only make it clipped,
 * which is `resolveShellAllocation`'s job.
 *
 * `sidebarAutoCollapsed` is gone with the ladder: nothing auto-collapses, so
 * there is no such state to report and no affordance to drive from it.
 */
export function resolveShellChrome(input: ResolveShellChromeInput): ShellChrome {
  return {
    sidebarCollapsed: input.sidebarUserCollapsed,
    panelVisible: input.panelOpen,
    chatVisible: input.manualChat !== null ? input.manualChat : true,
  };
  // No `railVisible`: round-12 made the rail permanent (see RAIL_RESERVE).
}

export interface ResolveShellAllocationInput {
  /** Whole shell width. Null before the first measurement. */
  shellWidth: number | null;
  /** The user's sidebar width; ignored while collapsed. */
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  chatVisible: boolean;
  editorOpen: boolean;
  editorRatio: number;
  /** The user's surface choice — intent, not width. */
  panelVisible: boolean;
  /** The width the user dragged the panel to; a PREFERENCE since round-12. */
  panelWidth: number;
}

export interface ShellAllocation {
  /** Priority 1 — granted in full, always. */
  sidebarWidth: number;
  /** The chat+editor row. Never below `contentFloor` for what is shown. */
  centerWidth: number;
  /** 0 when chat is hidden; otherwise never below `CHAT_MIN_WIDTH`. */
  chatWidth: number;
  /** 0 when no file is open. */
  editorWidth: number;
  /** What the panel ACTUALLY gets: the preference, compressed to fit. */
  panelWidth: number;
  /** True when the panel is narrower than the user asked for. */
  panelCompressed: boolean;
  /**
   * True when there was not even `PANEL_MIN_USEFUL_WIDTH` to give, so the
   * panel is 0-wide and only the rail remains. The surface is still ACTIVE —
   * this is a width outcome, never a visibility decision (round-11's rule
   * still holds: only the user closes a panel).
   */
  panelSuppressed: boolean;
  /**
   * px of chat+editor past the row's right edge. Only ever non-zero on a
   * window too narrow for their floors — the panel is already at 0 by then.
   */
  overflowWidth: number;
}

/**
 * ## OVERTURNED DESIGN — round-11's right-edge clipping
 *
 * Round-11 answered "too narrow" by letting the panel keep its width and run
 * off the right edge. The user rejected the RESULT on sight: 「显示不完整很奇怪」.
 * The diagnosis is that clipping cut the panel's own chrome — its border, its
 * header, the scrollbar — so a narrow window produced a panel that looked
 * broken rather than small. Clipping is right for CONTENT and wrong for a
 * container.
 *
 * Round-12 therefore compresses instead: 「空间不足时面板宽度压缩…右缘的 rail
 * 与面板边框永远完整——窗口再窄，看到的也是『一个变窄的面板』而不是『被切掉一块的
 * 面板』」. `CONTEXT_PANEL_MIN_WIDTH` (380) is demoted from a hard floor to a
 * PREFERENCE: honoured whenever the room exists, given up when it does not.
 * Inside the panel the surface's own `overflow-hidden` does the cutting, which
 * is where cutting belongs.
 *
 * What did NOT change from round-11 (and must not): visibility is still the
 * user's alone, chat and the editor still keep their floors ahead of the
 * panel, and the sidebar is still satisfied first.
 */
export function resolveShellAllocation(input: ResolveShellAllocationInput): ShellAllocation {
  const {
    shellWidth,
    sidebarWidth,
    sidebarCollapsed,
    chatVisible,
    editorOpen,
    editorRatio,
    panelVisible,
    panelWidth,
  } = input;

  const sidebar = sidebarCollapsed ? SIDEBAR_COLLAPSED_RESERVE : Math.max(0, sidebarWidth);
  const preferred = panelVisible ? Math.max(0, panelWidth) : 0;
  const floors = contentFloor({ chatWanted: chatVisible, editorOpen });

  const build = (centerWidth: number, panel: number, overflowWidth: number): ShellAllocation => {
    let chatWidth = 0;
    let editorWidth = 0;
    if (chatVisible && editorOpen) {
      chatWidth = resolveChatColumnWidth({ centerWidth, editorRatio });
      editorWidth = Math.max(EDITOR_MIN_WIDTH, centerWidth - chatWidth);
    } else if (chatVisible) {
      chatWidth = centerWidth;
    } else if (editorOpen) {
      editorWidth = centerWidth;
    }
    return {
      sidebarWidth: sidebar,
      centerWidth,
      chatWidth,
      editorWidth,
      panelWidth: panel,
      panelCompressed: panelVisible && panel < preferred,
      panelSuppressed: panelVisible && panel === 0,
      overflowWidth,
    };
  };

  // Unmeasured: grant every preference rather than flash a compressed shell.
  if (!isFiniteNumber(shellWidth) || shellWidth <= 0) {
    return build(floors, preferred, 0);
  }

  // Round-12: the rail is PERMANENT, so its 44px is reserved unconditionally.
  // It is also outside the clip, which is what guarantees the user can always
  // reach a surface no matter how narrow the window gets.
  const row = Math.max(0, shellWidth - sidebar - RAIL_RESERVE);
  // Chat and the editor are served first; whatever is left is what the panel
  // may have. This is the priority rule, unchanged from round-11 — only the
  // panel's response to losing changed (compress, was clip).
  const roomForPanel = Math.max(0, row - floors);
  let panel = Math.min(preferred, roomForPanel);
  // A sliver of panel is worse than none: below this there is not enough room
  // for its chrome to read as a panel at all, so it yields the space entirely
  // and the rail alone represents it.
  if (panel < PANEL_MIN_USEFUL_WIDTH) {
    panel = 0;
  }
  const centerWidth = Math.max(floors, row - panel);
  return build(centerWidth, panel, Math.max(0, centerWidth + panel - row));
}

/**
 * The largest panel width a DRAG may reach — the point past which dragging
 * stops doing anything visible.
 *
 * Survives both rewrites with a narrowed job. It no longer caps what the panel
 * RENDERS at: since round-12 the render width is `resolveShellAllocation`'s
 * compressed outcome, not the drag's. But the panel's grip is on its LEFT
 * edge, so widening it moves that edge leftward only while chat/the editor
 * still have room to give. Once `centerWidth` bottoms out at `contentFloor`,
 * the edge stops and every further pixel of drag is invisible. Clamping there
 * is what keeps the drag what-you-see-is-what-you-get (the one principle
 * carried over from the round-10 fix).
 *
 * Window SHRINK is deliberately not clamped this way — shrink compresses the
 * rendered panel while the stored preference stays put, so widening restores.
 */
export function maxPanelWidth(input: {
  shellWidth: number | null;
  sidebarWidth: number;
  editorOpen: boolean;
  chatVisible: boolean;
}): number | null {
  const { shellWidth, sidebarWidth, editorOpen, chatVisible } = input;
  if (!isFiniteNumber(shellWidth) || shellWidth <= 0) {
    return null;
  }
  const room = shellWidth - sidebarWidth - contentFloor({ chatWanted: chatVisible, editorOpen });
  return Math.max(0, room);
}
