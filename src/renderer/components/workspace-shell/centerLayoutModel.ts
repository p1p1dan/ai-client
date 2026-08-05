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

// ── chrome yields, content has a floor (T-32 m5, user round 1) ──────────

/**
 * A08 states the ladder as whole-window thresholds — `L0 = 1580 = 280 sidebar
 * + 400 chat + 520 editor + 380 panel`, `L1 = 1244 = 280 + 400 + 520 + 44 rail`
 * (a08:1421-1422) — and only ever sacrifices the panel, then chat.
 *
 * The user's round-1 report is that this is the wrong order and the wrong
 * subject: 「chat 页面应该设置一个最小宽度，可用宽度低于这个宽度，则优先折叠左侧，
 * 其次是右边栏，然后根据情况决定是显示文件编辑还是 chat 页面」. Two changes fall
 * out of that:
 *
 *  1. **Content has a hard floor and chrome yields to it.** Previously the
 *     panel could take the whole row (screenshot: chat squeezed to ~270px with
 *     a 65px composer wrapping one character per line). Now the panel is capped
 *     so chat — and the editor when open — always keep their minimums.
 *  2. **The sidebar joins the ladder, and goes FIRST.** It was outside it, so
 *     a 280–500px sidebar was untouchable while chat got crushed.
 *
 * Yield order: sidebar → panel → chat. Anything the user did by hand wins over
 * every rung (`manualPanel` / `manualChat`, and the sidebar's own toggle).
 */
export const RAIL_RESERVE = 44;
export const PANEL_MIN_RESERVE = 380;
export const SIDEBAR_COLLAPSED_RESERVE = 48;

/** Content the shell refuses to shrink below, given what is open. */
export function contentFloor(input: { chatWanted: boolean; editorOpen: boolean }): number {
  return (input.chatWanted ? CHAT_MIN_WIDTH : 0) + (input.editorOpen ? EDITOR_MIN_WIDTH : 0);
}

export interface ResolveShellChromeInput {
  /** Whole shell width — sidebar + content + panel/rail. Null before measurement. */
  shellWidth: number | null;
  /** Width the sidebar would take if honoured (already 48 when the user collapsed it). */
  sidebarWidth: number;
  /** The user's own collapse toggle; an auto-collapse never writes it. */
  sidebarUserCollapsed: boolean;
  /** Width the panel would take if honoured. */
  panelWidth: number;
  editorOpen: boolean;
  /** `activeSurfaceId !== null` — intent, not visibility. */
  panelOpen: boolean;
  manualPanel: ManualOverride;
  manualChat: ManualOverride;
}

export interface ShellChrome {
  /** True when the user collapsed it OR the shell had to. */
  sidebarCollapsed: boolean;
  /** True only because the shell had to — drives the "auto" affordance, never persisted. */
  sidebarAutoCollapsed: boolean;
  panelVisible: boolean;
  chatVisible: boolean;
  railVisible: boolean;
}

/**
 * Successive relaxations, in the user's stated order. Each rung is tried only
 * because the one before it did not free enough room, so the shell never gives
 * up more chrome than the width actually demands.
 */
export function resolveShellChrome(input: ResolveShellChromeInput): ShellChrome {
  const {
    shellWidth,
    sidebarWidth,
    sidebarUserCollapsed,
    panelWidth,
    editorOpen,
    panelOpen,
    manualPanel,
    manualChat,
  } = input;

  const wantPanel = manualPanel !== null ? manualPanel : panelOpen;
  const wantChat = manualChat !== null ? manualChat : true;

  const base: ShellChrome = {
    sidebarCollapsed: sidebarUserCollapsed,
    sidebarAutoCollapsed: false,
    panelVisible: wantPanel,
    chatVisible: wantChat,
    railVisible: !wantPanel,
  };

  // Unmeasured: honour every preference rather than flashing a degraded shell.
  if (!isFiniteNumber(shellWidth) || shellWidth <= 0) {
    return base;
  }

  const sidebarNow = sidebarUserCollapsed ? SIDEBAR_COLLAPSED_RESERVE : sidebarWidth;
  const chromeFor = (sidebar: number, panelShown: boolean) =>
    sidebar + (panelShown ? panelWidth : RAIL_RESERVE);
  const fits = (sidebar: number, panelShown: boolean, chatShown: boolean) =>
    shellWidth - chromeFor(sidebar, panelShown) >=
    contentFloor({ chatWanted: chatShown, editorOpen });

  // Rung 0 — everything the user asked for.
  if (fits(sidebarNow, base.panelVisible, base.chatVisible)) {
    return base;
  }

  // Rung 1 — collapse the sidebar (unless the user already did).
  if (
    !sidebarUserCollapsed &&
    fits(SIDEBAR_COLLAPSED_RESERVE, base.panelVisible, base.chatVisible)
  ) {
    return { ...base, sidebarCollapsed: true, sidebarAutoCollapsed: true };
  }

  const sidebarFloor = SIDEBAR_COLLAPSED_RESERVE;
  const autoCollapsed = !sidebarUserCollapsed;

  // Rung 2 — give up the panel. An explicit `manualPanel: true` outranks this:
  // the user summoned it on a narrow window and must not be overruled.
  if (base.panelVisible && manualPanel !== true && fits(sidebarFloor, false, base.chatVisible)) {
    return {
      ...base,
      sidebarCollapsed: true,
      sidebarAutoCollapsed: autoCollapsed,
      panelVisible: false,
      railVisible: true,
    };
  }

  // Rung 3 — give up chat, but only when there is an editor to fall back to.
  // With no file open chat IS the shell; it is never the thing that goes.
  if (editorOpen && base.chatVisible && manualChat !== true) {
    return {
      ...base,
      sidebarCollapsed: true,
      sidebarAutoCollapsed: autoCollapsed,
      panelVisible: manualPanel === true && base.panelVisible,
      railVisible: !(manualPanel === true && base.panelVisible),
      chatVisible: false,
    };
  }

  // Nothing left to yield: keep the sidebar collapsed and let the content
  // scroll rather than silently dropping the user's last explicit choice.
  return { ...base, sidebarCollapsed: true, sidebarAutoCollapsed: autoCollapsed };
}

/**
 * The panel may never eat the content floor (T-32 m5). Returns the largest
 * width the panel may take, or 0 when even the floor cannot be met — the
 * caller has already decided visibility via `resolveShellChrome`.
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
