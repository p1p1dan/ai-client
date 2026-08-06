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
export const RAIL_RESERVE = 44;
export const PANEL_MIN_RESERVE = 380;
export const SIDEBAR_COLLAPSED_RESERVE = 48;

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
  panelVisible: boolean;
  chatVisible: boolean;
  railVisible: boolean;
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
  const panelVisible = input.panelOpen;
  return {
    sidebarCollapsed: input.sidebarUserCollapsed,
    panelVisible,
    // A08「展开时右缘无图标」: the rail is the collapsed-state switcher, so it
    // is the exact complement of the panel and never both.
    railVisible: !panelVisible,
    chatVisible: input.manualChat !== null ? input.manualChat : true,
  };
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
  panelVisible: boolean;
  /** The user's panel width, already 380..1400-clamped by the store. */
  panelWidth: number;
  railVisible: boolean;
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
  /** The user's width, never reduced — it is clipped instead. 0 when closed. */
  panelWidth: number;
  /** px pushed past the shell's right edge and clipped away; 0 = everything fits. */
  clippedWidth: number;
  clipped: boolean;
}

/**
 * Lay the columns out left to right and let the right edge cut off whatever
 * does not fit. The caller renders this into fixed, non-shrinking widths inside
 * an `overflow-clip` row — the clip is the whole mechanism, so a child that is
 * allowed to shrink would silently defeat it.
 *
 * Order of satisfaction, straight from the ruling:
 *  - sidebar takes its width (or 48 collapsed) — never compressed, never hidden;
 *  - the rail, when shown, is reserved too: it is 44px and it is the only way
 *    to bring the panel back, so clipping it would strand the user;
 *  - chat and the editor share what is left, down to their floors;
 *  - the panel keeps the width the user set and absorbs the shortfall by
 *    hanging off the right edge.
 *
 * Before measurement everything is granted as requested and nothing is
 * reported clipped: a first paint that guesses wrong would flash a cut-off
 * layout, and one frame later the real width arrives anyway.
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
    railVisible,
  } = input;

  const sidebar = sidebarCollapsed ? SIDEBAR_COLLAPSED_RESERVE : Math.max(0, sidebarWidth);
  const panel = panelVisible ? Math.max(0, panelWidth) : 0;
  const floors = contentFloor({ chatWanted: chatVisible, editorOpen });

  const split = (centerWidth: number): ShellAllocation => {
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
      clippedWidth: 0,
      clipped: false,
    };
  };

  if (!isFiniteNumber(shellWidth) || shellWidth <= 0) {
    return split(floors);
  }

  const rail = railVisible ? RAIL_RESERVE : 0;
  const row = Math.max(0, shellWidth - sidebar - rail);
  // `Math.max(floors, …)` is the entire priority rule: when the panel's width
  // would push chat/the editor under their floors, the floors win and the
  // panel is what ends up past the edge — never the other way round.
  const centerWidth = Math.max(floors, row - panel);
  const clippedWidth = Math.max(0, centerWidth + panel - row);

  return { ...split(centerWidth), clippedWidth, clipped: clippedWidth > 0 };
}

/**
 * The largest panel width a DRAG may reach — the point past which dragging
 * stops doing anything visible.
 *
 * Survives the clip-don't-collapse rewrite with a narrowed job. It no longer
 * caps what the panel RENDERS at: under the new model the panel always renders
 * at the width the user set and the right edge clips the remainder
 * (`resolveShellAllocation`). But the panel's grip is on its LEFT edge, so
 * widening it moves that edge leftward only while chat/the editor still have
 * room to give. Once `centerWidth` bottoms out at `contentFloor`, the edge
 * stops and every further pixel of drag goes straight off the right edge,
 * invisible. Clamping there is what keeps the drag what-you-see-is-what-you-get
 * (the one principle carried over from the round-10 fix).
 *
 * Window SHRINK is deliberately not clamped this way — that is the case the
 * user's ruling is about, and there the panel keeps its width and gets cut off.
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
