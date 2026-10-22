/**
 * Layout 5a (ui-cohesion §6, rulings L3/L4): the right work panel.
 *
 * Replaces `rightColumnModel.ts`. The right column used to hold one of three
 * mutually exclusive occupants (review over terminal over files) and the left
 * dock switched five surfaces behind an icon rail. Both collapse into ONE
 * container on the right with a tab strip: changes, files, editor, git,
 * terminal, run, context. It is closed by default and opens on demand.
 *
 * Decision 126 rule 1 ("close the terminal and the file tabs come back exactly
 * as they were") used to hold because the occupants stacked. It now holds
 * through `history`: when the tab on screen disappears (its shell ended, the
 * last file closed, the conversation changed), the panel falls back to the
 * most recent tab that is still there, and closes when there is none.
 *
 * Pure so vitest's node environment covers it.
 */
import type { ContextSurfaceId } from './surfaceRegistry';

export type WorkPanelTab =
  | 'changes'
  | 'files'
  | 'editor'
  | 'git'
  | 'terminal'
  // The worktree init-script terminal (`openInitializationTerminal`): the
  // multi-tab `TerminalPanel`, which is what consumes a pending init script.
  // It only gets a tab once something opened it.
  | 'setup'
  | 'run'
  | 'context';

/** Strip order (ui-cohesion §6 5a). */
export const WORK_PANEL_TAB_ORDER: readonly WorkPanelTab[] = [
  'changes',
  'files',
  'editor',
  'git',
  'terminal',
  'setup',
  'run',
  'context',
];

/** English source strings = i18n keys. */
export const WORK_PANEL_TAB_LABEL_KEYS: Record<WorkPanelTab, string> = {
  changes: 'Session changes',
  files: 'Files',
  editor: 'Editor',
  git: 'Git',
  terminal: 'Terminal',
  setup: 'Workspace terminal',
  run: 'Run',
  context: 'Context',
};

export function isWorkPanelTab(value: unknown): value is WorkPanelTab {
  return typeof value === 'string' && (WORK_PANEL_TAB_ORDER as readonly string[]).includes(value);
}

// ── widths (open-claude-ui docs/v2/04 §4.4: default 480, min 320) ────────
export const WORK_PANEL_DEFAULT_WIDTH = 480;
export const WORK_PANEL_MIN_WIDTH = 320;
export const WORK_PANEL_MAX_WIDTH = 1400;

/** 320..1400, rounded; non-finite → the 480 default. */
export function clampWorkPanelWidth(width: number): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return WORK_PANEL_DEFAULT_WIDTH;
  }
  return Math.round(Math.min(Math.max(width, WORK_PANEL_MIN_WIDTH), WORK_PANEL_MAX_WIDTH));
}

// ── which tabs exist ────────────────────────────────────────────────────
export interface WorkPanelAvailability {
  /** The session review is enabled and a conversation is open. */
  reviewAvailable: boolean;
  /** Editor tabs are open, or a file-open intent is pending (it will be). */
  editorOpen: boolean;
  /** The folder on screen has a running column shell. */
  terminalAlive: boolean;
  /** The init-script terminal was opened this session. */
  setupTerminalOpened: boolean;
}

/** Tabs on the strip, in strip order. Files, git, run and context always exist. */
export function deriveWorkPanelTabs(input: WorkPanelAvailability): WorkPanelTab[] {
  return WORK_PANEL_TAB_ORDER.filter((tab) => {
    switch (tab) {
      case 'changes':
        return input.reviewAvailable;
      case 'editor':
        return input.editorOpen;
      case 'terminal':
        return input.terminalAlive;
      case 'setup':
        return input.setupTerminalOpened;
      default:
        return true;
    }
  });
}

// ── which tab an intent opens ───────────────────────────────────────────
export type WorkPanelIntent =
  /** A file or a diff asked to be shown (tool row, tree, git panel, search). */
  | { type: 'open-file' }
  /** The title bar's changes button. */
  | { type: 'review' }
  /** The title bar's terminal button. */
  | { type: 'terminal' }
  /** A worktree's init script is about to run. */
  | { type: 'initialization-terminal' }
  /** A shortcut digit or a menu entry naming a registry surface. */
  | { type: 'surface'; surfaceId: ContextSurfaceId };

/**
 * Surfaces a shortcut, a menu or a persisted pre-5a `lastSurfaceId` may open.
 * The registry's `terminal` surface is deliberately absent: since 2026-09-04
 * only the init script opens it (`initialization-terminal`), never navigation.
 */
const TAB_BY_SURFACE: Partial<Record<ContextSurfaceId, WorkPanelTab>> = {
  // The registry id stays `editor` for the files tree (see surfaceRegistry.ts).
  editor: 'files',
  git: 'git',
  context: 'context',
  run: 'run',
};

export function tabForIntent(intent: WorkPanelIntent): WorkPanelTab | null {
  switch (intent.type) {
    case 'open-file':
      return 'editor';
    case 'review':
      return 'changes';
    case 'terminal':
      return 'terminal';
    case 'initialization-terminal':
      return 'setup';
    case 'surface':
      return TAB_BY_SURFACE[intent.surfaceId] ?? null;
    default:
      return null;
  }
}

/** The registry surface a tab renders through `SURFACE_VIEWS`; null for the rest. */
export function surfaceIdForTab(tab: WorkPanelTab): ContextSurfaceId | null {
  if (tab === 'setup') return 'terminal';
  for (const [surfaceId, mapped] of Object.entries(TAB_BY_SURFACE)) {
    if (mapped === tab) return surfaceId as ContextSurfaceId;
  }
  return null;
}

// ── state ───────────────────────────────────────────────────────────────
export interface WorkPanelState {
  open: boolean;
  /** The tab last asked for; survives a close so the strip remembers it. */
  tab: WorkPanelTab;
  /** Tabs asked for, oldest first, no repeats — the fallback order. */
  history: WorkPanelTab[];
}

const HISTORY_LIMIT = WORK_PANEL_TAB_ORDER.length;

export function openWorkPanelTab(prev: WorkPanelState, tab: WorkPanelTab): WorkPanelState {
  const history = [...prev.history.filter((entry) => entry !== tab), tab].slice(-HISTORY_LIMIT);
  return { open: true, tab, history };
}

export function closeWorkPanel(prev: WorkPanelState): WorkPanelState {
  return prev.open ? { ...prev, open: false } : prev;
}

/**
 * A title bar button or a shortcut: the tab on screen closes the panel, any
 * other tab opens on it. `shownTab` is what the panel shows NOW
 * (`resolveWorkPanelView`), which can differ from `prev.tab` after a fallback.
 */
export function toggleWorkPanelTab(
  prev: WorkPanelState,
  tab: WorkPanelTab,
  shownTab: WorkPanelTab | null
): WorkPanelState {
  if (prev.open && shownTab === tab) return closeWorkPanel(prev);
  return openWorkPanelTab(prev, tab);
}

export interface WorkPanelView {
  open: boolean;
  /** Null exactly when `open` is false. */
  tab: WorkPanelTab | null;
}

/**
 * What the panel shows, derived at render time and never written back: a tab
 * that disappears only for a while (another conversation's folder has no
 * shell) comes back by itself when it reappears, as the stacked column did.
 */
export function resolveWorkPanelView(
  state: WorkPanelState,
  visible: readonly WorkPanelTab[]
): WorkPanelView {
  if (!state.open) return { open: false, tab: null };
  if (visible.includes(state.tab)) return { open: true, tab: state.tab };
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const candidate = state.history[index] as WorkPanelTab;
    if (candidate !== state.tab && visible.includes(candidate)) {
      return { open: true, tab: candidate };
    }
  }
  return { open: false, tab: null };
}

// ── the title bar's terminal button (moved from rightColumnModel.ts) ────
/**
 * - `unavailable`: the conversation has no folder (decision 126 rule 2) — the
 *   button is disabled and says why; there is no fallback directory.
 * - `closed`: no shell for this folder yet; a click starts one.
 * - `hidden`: the folder's shell runs but another tab (or nothing) is on
 *   screen; a click brings the same shell back. Marked, so a running process
 *   is never invisible.
 * - `open`: the terminal tab is what the panel shows; a click closes the panel.
 */
export type TerminalButtonState = 'unavailable' | 'closed' | 'hidden' | 'open';

export function deriveTerminalButtonState(input: {
  /** The conversation resolves to a folder with a usable path. */
  available: boolean;
  /** A shell for that folder is running. */
  alive: boolean;
  /** The panel shows the terminal tab. */
  visible: boolean;
}): TerminalButtonState {
  if (!input.available) return 'unavailable';
  if (input.visible) return 'open';
  return input.alive ? 'hidden' : 'closed';
}
