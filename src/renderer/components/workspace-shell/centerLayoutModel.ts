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

// ── the level ladder (A08 §「画幅降级梯」, a08:1412-1422) ─────────────────

/**
 * A08 states the thresholds as WHOLE-WINDOW widths — `L0 = 1580 = 280 sidebar
 * + 400 chat + 520 editor + 380 panel`, `L1 = 1244 = 280 + 400 + 520 + 44 rail`
 * (a08:1421-1422). Ours drop the sidebar term.
 *
 * Why (registered as an adaptation, NOT an override of A08): A08 assumes a
 * fixed 280px sidebar. This shell's sidebar is user-dragged 280–500 and can
 * collapse to 48 (`shellLayoutModel.ts`), so a whole-window threshold
 * mis-fires in both directions — a 1600px window with a 500px sidebar has less
 * room than A08's arithmetic claims, and the same window with the sidebar
 * collapsed has far more. Measuring the content row instead makes the ladder
 * immune to both. With a 280px sidebar the two are exactly equivalent.
 */
export const LEVEL_L0_MIN_CONTENT = CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH + 380; // 1300, panel = 380
/**
 * m-T32 fix: this was `+ 44` for the rail, double-counting it. The measured
 * row (`contentRowRef`) spans chat + editor + panel ONLY — the rail is its
 * sibling, outside the measurement — so at L1, where the panel is gone, the
 * row has to fit exactly chat + editor and nothing else.
 */
export const LEVEL_L1_MIN_CONTENT = CHAT_MIN_WIDTH + EDITOR_MIN_WIDTH; // 920

export type ShellLevel = 'L0' | 'L1' | 'L2';

export interface ResolveShellLevelInput {
  /** Measured width of chat + editor + panel/rail — the sidebar is NOT included. */
  contentWidth: number | null;
  editorOpen: boolean;
}

/**
 * L0 everything fits · L1 the panel gives way · L2 chat gives way.
 *
 * Pinned: with no file open this is ALWAYS 'L0'. A08's state table gates the
 * whole ladder on `editor open` (a08:1454) and the reason is structural — the
 * 520px editor reservation is what makes the arithmetic bite, and with no
 * editor there is nothing to reserve. Without this branch a narrow window
 * would start hiding the panel from a chat-only shell, which is a regression
 * against the pre-T-32 behaviour, not a feature.
 */
export function resolveShellLevel(input: ResolveShellLevelInput): ShellLevel {
  const { contentWidth, editorOpen } = input;
  if (!editorOpen) {
    return 'L0';
  }
  if (!isFiniteNumber(contentWidth) || contentWidth <= 0) {
    // Not measured yet: assume roomy rather than flashing a degraded layout
    // on the first frame and then expanding.
    return 'L0';
  }
  if (contentWidth >= LEVEL_L0_MIN_CONTENT) {
    return 'L0';
  }
  return contentWidth >= LEVEL_L1_MIN_CONTENT ? 'L1' : 'L2';
}

/**
 * A08 §06-4: `manualPanel` / `manualChat` are the user's in-session override of
 * the automatic ladder, cleared when the file closes. `null` means "no
 * override" — A08 writes them as booleans, but a two-state flag cannot say
 * "cleared" without also saying "hidden", which is how an override would
 * silently outlive the file that scoped it.
 */
export type ManualOverride = boolean | null;

export interface DerivePanelVisibleInput {
  level: ShellLevel;
  editorOpen: boolean;
  /** Persisted preference used whenever the editor is closed. */
  panelOpen: boolean;
  manualPanel: ManualOverride;
}

export function derivePanelVisible(input: DerivePanelVisibleInput): boolean {
  const { level, editorOpen, panelOpen, manualPanel } = input;
  if (!editorOpen) {
    return panelOpen;
  }
  if (manualPanel !== null) {
    return manualPanel;
  }
  return level === 'L0';
}

export interface DeriveChatVisibleInput {
  level: ShellLevel;
  editorOpen: boolean;
  manualChat: ManualOverride;
}

export function deriveChatVisible(input: DeriveChatVisibleInput): boolean {
  const { level, editorOpen, manualChat } = input;
  if (!editorOpen) {
    // Chat IS the shell when no file is open; nothing may hide it.
    return true;
  }
  if (manualChat !== null) {
    return manualChat;
  }
  return level !== 'L2';
}
