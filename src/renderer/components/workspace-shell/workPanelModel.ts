/**
 * Layout 5d (ui-cohesion §6, user feedback 2026-10-22): the panes to the right
 * of the chat.
 *
 * 5a had ONE work panel with a tab strip; the user read it as "a page inside a
 * page" (two title rows). Each view is now its own card — a pane — with one
 * header, and several can be open at once, as in the reference desktop app.
 *
 * Layout rule (deterministic, `derivePaneGrid`): at most 2 columns × 2 rows.
 * Panes take slots in the order they were opened —
 *   1st fills the area; 2nd opens a second column; 3rd stacks under column 1;
 *   4th stacks under column 2.
 * Opening a 5th replaces the least recently focused pane in its slot. Closing
 * a pane compacts the rest (they keep their order and move up a slot).
 *
 * A pane whose content is gone only for a while (another conversation's folder
 * has no shell, the last file closed) is skipped at render time and never
 * written back — it comes back by itself when its content does, as the old
 * stacked column and the 5a panel did.
 *
 * The file keeps its 5a name so existing importers (`nextChangeFocus`) hold.
 * Pure so vitest's node environment covers it.
 */
import type { ContextSurfaceId } from './surfaceRegistry';

export type PaneKind =
  | 'changes'
  | 'files'
  | 'editor'
  | 'git'
  | 'terminal'
  // The worktree init-script terminal (`openInitializationTerminal`): the
  // multi-tab `TerminalPanel`, which is what consumes a pending init script.
  | 'setup'
  | 'run'
  | 'context'
  | 'tasks'
  // Reserved for the reference's other panes; no view yet, never available.
  | 'browser'
  | 'plan'
  | 'subagent';

/** Every kind, in a fixed order: the cards' DOM order (stable keys, no remounts). */
export const PANE_KINDS: readonly PaneKind[] = [
  'changes',
  'files',
  'editor',
  'git',
  'terminal',
  'setup',
  'run',
  'context',
  'tasks',
  'browser',
  'plan',
  'subagent',
];

export const RESERVED_PANE_KINDS: readonly PaneKind[] = ['browser', 'plan', 'subagent'];

/** English source strings = i18n keys. */
export const PANE_LABEL_KEYS: Record<PaneKind, string> = {
  changes: 'Session changes',
  files: 'Files',
  editor: 'Editor',
  git: 'Git',
  terminal: 'Terminal',
  setup: 'Workspace terminal',
  run: 'Run',
  context: 'Context',
  tasks: 'Background tasks',
  browser: 'Browser',
  plan: 'Plan',
  subagent: 'Subagent',
};

export function isPaneKind(value: unknown): value is PaneKind {
  return typeof value === 'string' && (PANE_KINDS as readonly string[]).includes(value);
}

export const MAX_OPEN_PANES = 4;

// ── geometry ────────────────────────────────────────────────────────────
/** Between two cards, and from the cards to the window's edges. */
export const PANE_GAP = 8;
export const PANE_MIN_WIDTH = 320;
export const PANE_MIN_HEIGHT = 120;
export const PANE_HEADER_HEIGHT = 36;

export type PaneColumns = 1 | 2;

/**
 * The pane area's width INCLUDES its edge margins (8 on each side, the left
 * one is where the resize grip sits): one column 480 + 16, two columns
 * 2 × 420 + 8 + 16. Each column count remembers its own width, so adding a
 * second pane widens the area and closing it gives the room back.
 */
export const PANE_AREA_DEFAULT_WIDTH: Record<PaneColumns, number> = {
  1: 480 + 2 * PANE_GAP,
  2: 2 * 420 + PANE_GAP + 2 * PANE_GAP,
};
export const PANE_AREA_MAX_WIDTH = 2400;

export function paneAreaMinWidth(columns: PaneColumns): number {
  return columns * PANE_MIN_WIDTH + (columns - 1) * PANE_GAP + 2 * PANE_GAP;
}

/** min..2400, rounded; non-finite → the column count's default. */
export function clampPaneAreaWidth(width: number, columns: PaneColumns): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return PANE_AREA_DEFAULT_WIDTH[columns];
  }
  return Math.round(Math.min(Math.max(width, paneAreaMinWidth(columns)), PANE_AREA_MAX_WIDTH));
}

/** Where the column split and each column's row split sit, as fractions. */
export interface PaneSplits {
  column: number;
  rows: [number, number];
}

export const DEFAULT_PANE_SPLITS: PaneSplits = { column: 0.5, rows: [0.5, 0.5] };

const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;

function sanitizeRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  return Math.min(Math.max(value, SPLIT_MIN), SPLIT_MAX);
}

export function sanitizePaneSplits(raw: unknown): PaneSplits {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_PANE_SPLITS, rows: [0.5, 0.5] };
  const record = raw as { column?: unknown; rows?: unknown };
  const rows = Array.isArray(record.rows) ? record.rows : [];
  return {
    column: sanitizeRatio(record.column),
    rows: [sanitizeRatio(rows[0]), sanitizeRatio(rows[1])],
  };
}

/**
 * A dragged split: the pointer's fraction of the box, kept so both sides
 * stay at least `minPx` (half a gap included). A box too small for two
 * minimums splits in half.
 */
export function clampSplitRatio(ratio: number, totalPx: number, minPx: number): number {
  if (!Number.isFinite(ratio) || !Number.isFinite(totalPx) || totalPx <= 0) return 0.5;
  const min = (minPx + PANE_GAP / 2) / totalPx;
  if (min >= 0.5) return 0.5;
  return Math.min(Math.max(ratio, Math.max(min, SPLIT_MIN)), Math.min(1 - min, SPLIT_MAX));
}

// ── which panes can show ────────────────────────────────────────────────
export interface PaneAvailability {
  /** The session review is enabled and a conversation is open. */
  reviewAvailable: boolean;
  /** Editor tabs are open, or a file-open intent is pending (it will be). */
  editorOpen: boolean;
  /** The folder on screen has a running column shell. */
  terminalAlive: boolean;
  /** The init-script terminal was opened this session. */
  setupTerminalOpened: boolean;
  /** A conversation is open (its background tasks can be listed). */
  sessionOpen: boolean;
}

/** Panes whose content exists now. Files, git, run and context always do. */
export function deriveAvailablePanes(input: PaneAvailability): PaneKind[] {
  return PANE_KINDS.filter((kind) => {
    switch (kind) {
      case 'changes':
        return input.reviewAvailable;
      case 'editor':
        return input.editorOpen;
      case 'terminal':
        return input.terminalAlive;
      case 'setup':
        return input.setupTerminalOpened;
      case 'tasks':
        return input.sessionOpen;
      case 'browser':
      case 'plan':
      case 'subagent':
        return false;
      default:
        return true;
    }
  });
}

// ── which pane an intent opens ──────────────────────────────────────────
export type PaneIntent =
  /** A file or a diff asked to be shown (tool row, tree, git pane, search). */
  | { type: 'open-file' }
  /** The title bar's changes button, the chat's change card. */
  | { type: 'review' }
  /** The title bar's terminal button. */
  | { type: 'terminal' }
  /** A worktree's init script is about to run. */
  | { type: 'initialization-terminal' }
  /** The title bar's background-tasks button. */
  | { type: 'tasks' }
  /** A shortcut digit or a menu entry naming a registry surface. */
  | { type: 'surface'; surfaceId: ContextSurfaceId };

/**
 * Surfaces a shortcut, a menu or a persisted pre-5a `lastSurfaceId` may open.
 * The registry's `terminal` surface is deliberately absent: since 2026-09-04
 * only the init script opens it (`initialization-terminal`), never navigation.
 */
const PANE_BY_SURFACE: Partial<Record<ContextSurfaceId, PaneKind>> = {
  // The registry id stays `editor` for the files tree (see surfaceRegistry.ts).
  editor: 'files',
  git: 'git',
  context: 'context',
  run: 'run',
};

export function paneForIntent(intent: PaneIntent): PaneKind | null {
  switch (intent.type) {
    case 'open-file':
      return 'editor';
    case 'review':
      return 'changes';
    case 'terminal':
      return 'terminal';
    case 'initialization-terminal':
      return 'setup';
    case 'tasks':
      return 'tasks';
    case 'surface':
      return PANE_BY_SURFACE[intent.surfaceId] ?? null;
    default:
      return null;
  }
}

/** The registry surface a pane renders through `SURFACE_VIEWS`; null for the rest. */
export function surfaceIdForPane(kind: PaneKind): ContextSurfaceId | null {
  if (kind === 'setup') return 'terminal';
  for (const [surfaceId, mapped] of Object.entries(PANE_BY_SURFACE)) {
    if (mapped === kind) return surfaceId as ContextSurfaceId;
  }
  return null;
}

// ── state ───────────────────────────────────────────────────────────────
export interface PaneLayoutState {
  /** Open panes in slot order (see the layout rule above). */
  panes: PaneKind[];
  /** Open panes, least recently focused first. */
  focus: PaneKind[];
  /** The pane that fills the area (⤢), or null. */
  expanded: PaneKind | null;
}

export const EMPTY_PANE_LAYOUT: PaneLayoutState = { panes: [], focus: [], expanded: null };

function withFocus(focus: readonly PaneKind[], kind: PaneKind, panes: readonly PaneKind[]) {
  return [...focus.filter((entry) => entry !== kind && panes.includes(entry)), kind];
}

/**
 * Opens (or focuses) a pane. A fifth pane takes the slot of the least
 * recently focused one. Opening another pane leaves an expanded one, so the
 * new pane is never hidden behind it.
 */
export function openPane(prev: PaneLayoutState, kind: PaneKind): PaneLayoutState {
  let panes = prev.panes;
  if (!panes.includes(kind)) {
    if (panes.length < MAX_OPEN_PANES) {
      panes = [...panes, kind];
    } else {
      const victim = prev.focus.find((entry) => panes.includes(entry)) ?? panes[0];
      panes = panes.map((entry) => (entry === victim ? kind : entry));
    }
  }
  return {
    panes,
    focus: withFocus(prev.focus, kind, panes),
    expanded: prev.expanded && prev.expanded !== kind ? null : prev.expanded,
  };
}

export function closePane(prev: PaneLayoutState, kind: PaneKind): PaneLayoutState {
  if (!prev.panes.includes(kind)) return prev;
  return {
    panes: prev.panes.filter((entry) => entry !== kind),
    focus: prev.focus.filter((entry) => entry !== kind),
    expanded: prev.expanded === kind ? null : prev.expanded,
  };
}

/** Same object back when nothing changes, so a click inside a card costs no store write. */
export function focusPane(prev: PaneLayoutState, kind: PaneKind): PaneLayoutState {
  if (!prev.panes.includes(kind) || prev.focus.at(-1) === kind) return prev;
  return { ...prev, focus: withFocus(prev.focus, kind, prev.panes) };
}

/**
 * A title bar button or a shortcut: a pane on screen closes, any other opens.
 * `visible` is what is on screen now (`resolvePaneView`), which can differ
 * from `prev.panes` while a pane's content is away.
 */
export function togglePane(
  prev: PaneLayoutState,
  kind: PaneKind,
  visible: readonly PaneKind[]
): PaneLayoutState {
  return visible.includes(kind) ? closePane(prev, kind) : openPane(prev, kind);
}

/**
 * Dragging one card's header onto another (user, 2026-10-22): the two trade
 * slots. Same object back when either is not open or they are the same pane.
 */
export function swapPanes(
  prev: PaneLayoutState,
  dragged: PaneKind,
  target: PaneKind
): PaneLayoutState {
  if (dragged === target || !prev.panes.includes(dragged) || !prev.panes.includes(target)) {
    return prev;
  }
  return {
    ...prev,
    panes: prev.panes.map((entry) =>
      entry === dragged ? target : entry === target ? dragged : entry
    ),
    focus: withFocus(prev.focus, dragged, prev.panes),
  };
}

export function toggleExpandedPane(prev: PaneLayoutState, kind: PaneKind): PaneLayoutState {
  if (!prev.panes.includes(kind)) return prev;
  return {
    ...prev,
    focus: withFocus(prev.focus, kind, prev.panes),
    expanded: prev.expanded === kind ? null : kind,
  };
}

export interface PaneView {
  /** On screen, in slot order. */
  panes: PaneKind[];
  /** Null unless the expanded pane is on screen. */
  expanded: PaneKind | null;
  /** The most recently focused pane on screen (Esc, Ctrl+\\ close it). */
  focused: PaneKind | null;
  /** 0 when nothing is on screen. */
  columns: 0 | PaneColumns;
}

/** What is on screen, derived at render time and never written back. */
export function resolvePaneView(state: PaneLayoutState, available: readonly PaneKind[]): PaneView {
  const panes = state.panes.filter((kind) => available.includes(kind));
  const expanded = state.expanded && panes.includes(state.expanded) ? state.expanded : null;
  let focused: PaneKind | null = null;
  for (let index = state.focus.length - 1; index >= 0; index -= 1) {
    const candidate = state.focus[index] as PaneKind;
    if (panes.includes(candidate)) {
      focused = candidate;
      break;
    }
  }
  const columns = panes.length === 0 ? 0 : expanded || panes.length === 1 ? 1 : 2;
  return { panes, expanded, focused: focused ?? panes.at(-1) ?? null, columns };
}

// ── grid ────────────────────────────────────────────────────────────────
export interface PaneSlot {
  column: 0 | 1;
  row: 0 | 1;
  /** Columns in the grid (1 or 2). */
  columns: PaneColumns;
  /** Panes in this pane's column (1 or 2). */
  rows: 1 | 2;
}

/**
 * Slot order 0..3 → column 0 row 0, column 1 row 0, column 0 row 1,
 * column 1 row 1. An expanded pane gets the whole area alone.
 */
export function derivePaneGrid(
  view: Pick<PaneView, 'panes' | 'expanded'>
): Map<PaneKind, PaneSlot> {
  const grid = new Map<PaneKind, PaneSlot>();
  if (view.expanded) {
    grid.set(view.expanded, { column: 0, row: 0, columns: 1, rows: 1 });
    return grid;
  }
  const panes = view.panes.slice(0, MAX_OPEN_PANES);
  const columns: PaneColumns = panes.length >= 2 ? 2 : 1;
  panes.forEach((kind, index) => {
    const column = (index % 2) as 0 | 1;
    const row = (index >= 2 ? 1 : 0) as 0 | 1;
    const inColumn = panes.filter((_, other) => other % 2 === column).length as 1 | 2;
    grid.set(kind, { column, row, columns, rows: inColumn });
  });
  return grid;
}

/**
 * A card's box inside the area, in CSS. The splits are CSS variables on the
 * area (`--pane-col`, `--pane-row-0`, `--pane-row-1`), so a drag rewrites
 * three properties on one node and no React render runs.
 */
export function paneSlotStyle(slot: PaneSlot): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  const half = PANE_GAP / 2;
  const x0 = slot.column === 0 ? '0' : 'var(--pane-col)';
  const x1 = slot.columns === 1 || slot.column === 1 ? '1' : 'var(--pane-col)';
  const xInset =
    (slot.column === 1 ? half : 0) + (slot.columns === 2 && slot.column === 0 ? half : 0);
  const rowVar = `var(--pane-row-${slot.column})`;
  const y0 = slot.row === 0 ? '0' : rowVar;
  const y1 = slot.rows === 1 || slot.row === 1 ? '1' : rowVar;
  const yInset = (slot.row === 1 ? half : 0) + (slot.rows === 2 && slot.row === 0 ? half : 0);
  return {
    left: `calc(${x0} * 100% + ${slot.column === 1 ? half : 0}px)`,
    top: `calc(${y0} * 100% + ${slot.row === 1 ? half : 0}px)`,
    width: `calc((${x1} - ${x0}) * 100% - ${xInset}px)`,
    height: `calc((${y1} - ${y0}) * 100% - ${yInset}px)`,
  };
}

// ── the title bar's terminal button (moved from rightColumnModel.ts) ────
/**
 * - `unavailable`: the conversation has no folder (decision 126 rule 2) — the
 *   button is disabled and says why; there is no fallback directory.
 * - `closed`: no shell for this folder yet; a click starts one.
 * - `hidden`: the folder's shell runs but its pane is closed; a click brings
 *   the same shell back. Marked, so a running process is never invisible.
 * - `open`: the terminal pane is on screen; a click closes it.
 */
export type TerminalButtonState = 'unavailable' | 'closed' | 'hidden' | 'open';

export function deriveTerminalButtonState(input: {
  /** The conversation resolves to a folder with a usable path. */
  available: boolean;
  /** A shell for that folder is running. */
  alive: boolean;
  /** The terminal pane is on screen. */
  visible: boolean;
}): TerminalButtonState {
  if (!input.available) return 'unavailable';
  if (input.visible) return 'open';
  return input.alive ? 'hidden' : 'closed';
}

// ── layout 5c: the timeline's change card asks for one file ─────────────
/**
 * A request to show one file in the changes pane (the timeline's per-turn
 * change card). The pane reads it, expands the file and scrolls to it; `seq`
 * rises on every request so a repeated click on the same card re-reveals.
 */
export interface WorkPanelChangeFocus {
  /** `SessionReviewEntry.id` (`${messageId}:${toolCallId}`) of the file's first change in the turn. */
  entryId: string;
  /** The file's path as the tool recorded it, for a pane that matches by path. */
  path: string;
  seq: number;
}

export function nextChangeFocus(
  prev: WorkPanelChangeFocus | null,
  target: { entryId: string; path: string }
): WorkPanelChangeFocus {
  return { entryId: target.entryId, path: target.path, seq: (prev?.seq ?? 0) + 1 };
}
