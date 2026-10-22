/**
 * T-22 (D19): shell layout store — a thin zustand + persist wrapper around the
 * pure models in `components/workspace-shell/` (`shellLayoutModel.ts` for the
 * sidebar and persistence, `workPanelModel.ts` for the panes on the right).
 * Every decision lives in those pure modules; this file only wires actions to
 * `set` so the store cannot behave differently from them.
 *
 * Layout 5a (ui-cohesion §6): the icon rail and its surface switcher are gone.
 * The sidebar is the chat list and collapses entirely. Layout 5d: git / files /
 * context / run, the review, the terminal, the editor and the background
 * tasks are pane cards to the right of the chat, several open at once.
 *
 * localStorage (not `electronStorage`): localStorage is synchronous, so there
 * is no hydration-flicker frame before the persisted layout applies.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ManualOverride } from '@/components/workspace-shell/centerLayoutModel';
import {
  clampSidebarWidth,
  defaultShellLayout,
  migrateShellLayoutPersisted,
  nextReadingWidthMode,
  type PersistedShellLayout,
  readingColumnClass,
  SHELL_LAYOUT_VERSION,
  sanitizeShellLayoutPersisted,
} from '@/components/workspace-shell/shellLayoutModel';
import { type ContextSurfaceId, getSurface } from '@/components/workspace-shell/surfaceRegistry';
import {
  clampPaneAreaWidth,
  closePane,
  focusPane,
  nextChangeFocus,
  openPane,
  type PaneColumns,
  type PaneKind,
  type PaneLayoutState,
  paneForIntent,
  sanitizePaneSplits,
  surfaceIdForPane,
  swapPanes,
  toggleExpandedPane,
  togglePane,
  type WorkPanelChangeFocus,
} from '@/components/workspace-shell/workPanelModel';

/**
 * T-32 (D27): A08 §06-4 scopes the manual chat override to the open file — it
 * is deliberately NOT persisted, so a restart cannot resurrect an override for
 * a file that is no longer open.
 */
export interface ShellSessionOverrides {
  manualChat: ManualOverride;
}

export const initialSessionOverrides: ShellSessionOverrides = {
  manualChat: null,
};

/** Session-only pane state (ruling L3: every start begins with no pane open). */
export interface PaneSessionState {
  /** Open panes in slot order (`workPanelModel.ts`'s layout rule). */
  panes: PaneKind[];
  /** Open panes, least recently focused first. */
  paneFocus: PaneKind[];
  /** The pane that fills the area (⤢). */
  expandedPane: PaneKind | null;
  /** The init-script terminal was opened; from then on it can show. */
  setupTerminalOpened: boolean;
  /** Bumped by Ctrl/Cmd+1; the sidebar focuses its chat list on change. */
  chatListFocusSeq: number;
}

const initialPaneSession: PaneSessionState = {
  panes: [],
  paneFocus: [],
  expandedPane: null,
  setupTerminalOpened: false,
  chatListFocusSeq: 0,
};

export interface ShellLayoutState
  extends PersistedShellLayout,
    ShellSessionOverrides,
    PaneSessionState {
  // sidebar
  setSidebarWidth: (width: number) => void;
  /** Ctrl/Cmd+B and the sidebar / title bar toggles. */
  toggleSidebar: () => void;
  /** Ctrl/Cmd+1: expand the sidebar if needed and focus the chat list. */
  focusChatList: () => void;
  // panes
  openPane: (kind: PaneKind) => void;
  /** `visible` is what is on screen now (`resolvePaneView`). */
  togglePane: (kind: PaneKind, visible: readonly PaneKind[]) => void;
  closePane: (kind: PaneKind) => void;
  focusPane: (kind: PaneKind) => void;
  toggleExpandedPane: (kind: PaneKind) => void;
  /** A card's header dropped on another card: the two trade slots. */
  swapPanes: (dragged: PaneKind, target: PaneKind) => void;
  /** Opens a registry surface's pane; surfaces that are not navigable are ignored. */
  openSurface: (id: ContextSurfaceId) => void;
  openInitializationTerminal: () => void;
  setPaneAreaWidth: (columns: PaneColumns, width: number) => void;
  setPaneColumnSplit: (ratio: number) => void;
  setPaneRowSplit: (column: 0 | 1, ratio: number) => void;
  setManualChat: (visible: boolean) => void;
  /** T-32 (A08 §06-4): the file closed — the override it scoped goes with it. */
  clearManualOverrides: () => void;
  // reading column
  toggleReadingWidthMode: () => void;
  // layout 5c: the timeline's change card (session-only, never persisted)
  /** The last file the change card asked the changes pane to show. */
  changeFocus: WorkPanelChangeFocus | null;
  /** Opens the changes pane and asks it to show `target`. */
  revealChange: (target: { entryId: string; path: string }) => void;
}

function layoutOf(state: ShellLayoutState): PaneLayoutState {
  return { panes: state.panes, focus: state.paneFocus, expanded: state.expandedPane };
}

/** Writes a model result back; an unchanged result writes nothing. */
function fromLayout(prev: ShellLayoutState, next: PaneLayoutState): Partial<ShellLayoutState> {
  if (
    next.panes === prev.panes &&
    next.focus === prev.paneFocus &&
    next.expanded === prev.expandedPane
  ) {
    return {};
  }
  return { panes: next.panes, paneFocus: next.focus, expandedPane: next.expanded };
}

/**
 * Selector for the registry surface of the most recently focused open pane,
 * or null. The surface views do not read it (each pane tells its view whether
 * it is on screen); kept for non-React callers and tests.
 */
export function selectActiveSurfaceId(state: ShellLayoutState): ContextSurfaceId | null {
  for (let index = state.paneFocus.length - 1; index >= 0; index -= 1) {
    const surface = surfaceIdForPane(state.paneFocus[index] as PaneKind);
    if (surface) return surface;
  }
  return null;
}

export const useShellLayoutStore = create<ShellLayoutState>()(
  persist(
    (set) => ({
      ...defaultShellLayout,
      ...initialSessionOverrides,
      ...initialPaneSession,

      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      focusChatList: () =>
        set((state) => ({
          sidebarCollapsed: false,
          chatListFocusSeq: state.chatListFocusSeq + 1,
        })),

      openPane: (kind) => set((state) => fromLayout(state, openPane(layoutOf(state), kind))),
      togglePane: (kind, visible) =>
        set((state) => fromLayout(state, togglePane(layoutOf(state), kind, visible))),
      closePane: (kind) => set((state) => fromLayout(state, closePane(layoutOf(state), kind))),
      focusPane: (kind) => set((state) => fromLayout(state, focusPane(layoutOf(state), kind))),
      toggleExpandedPane: (kind) =>
        set((state) => fromLayout(state, toggleExpandedPane(layoutOf(state), kind))),
      swapPanes: (dragged, target) =>
        set((state) => fromLayout(state, swapPanes(layoutOf(state), dragged, target))),
      openSurface: (id) =>
        set((state) => {
          if (getSurface(id)?.registeredOnly !== false) return {};
          const kind = paneForIntent({ type: 'surface', surfaceId: id });
          return kind ? fromLayout(state, openPane(layoutOf(state), kind)) : {};
        }),
      openInitializationTerminal: () =>
        set((state) => ({
          setupTerminalOpened: true,
          ...fromLayout(state, openPane(layoutOf(state), 'setup')),
        })),
      setPaneAreaWidth: (columns, width) =>
        set(
          columns === 1
            ? { paneAreaWidth: clampPaneAreaWidth(width, 1) }
            : { paneAreaSplitWidth: clampPaneAreaWidth(width, 2) }
        ),
      setPaneColumnSplit: (ratio) =>
        set((state) => ({
          paneSplits: sanitizePaneSplits({ ...state.paneSplits, column: ratio }),
        })),
      setPaneRowSplit: (column, ratio) =>
        set((state) => {
          const rows: [number, number] = [...state.paneSplits.rows];
          rows[column] = ratio;
          return { paneSplits: sanitizePaneSplits({ ...state.paneSplits, rows }) };
        }),

      setManualChat: (visible) => set({ manualChat: visible }),
      clearManualOverrides: () => set({ ...initialSessionOverrides }),

      toggleReadingWidthMode: () =>
        set((state) => ({ readingWidthMode: nextReadingWidthMode(state.readingWidthMode) })),

      changeFocus: null,
      revealChange: (target) =>
        set((state) => ({
          ...fromLayout(state, openPane(layoutOf(state), 'changes')),
          changeFocus: nextChangeFocus(state.changeFocus, target),
        })),
    }),
    {
      name: 'aiclient-shell-layout',
      version: SHELL_LAYOUT_VERSION,
      storage: createJSONStorage(() => localStorage),
      // Only the persisted data fields — actions and session state never are.
      partialize: (state): PersistedShellLayout => ({
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        paneAreaWidth: state.paneAreaWidth,
        paneAreaSplitWidth: state.paneAreaSplitWidth,
        paneSplits: state.paneSplits,
        readingWidthMode: state.readingWidthMode,
      }),
      // v1–v4 → v5 (layout 5d): see `migrateShellLayoutPersisted` — the 5a
      // panel width becomes the one-column pane area width, its last tab is
      // dropped (panes start closed).
      migrate: (persisted, version) => migrateShellLayoutPersisted(persisted, version),
      merge: (persisted, current) => ({ ...current, ...sanitizeShellLayoutPersisted(persisted) }),
    }
  )
);

/** Single hook used by chat components so they never import the shell dir. */
export function useReadingColumnClass(): string {
  return readingColumnClass(useShellLayoutStore((state) => state.readingWidthMode));
}

/** Layout 5c: the change card's click — chat reads it here, never from the shell dir. */
export function useRevealChange(): (target: { entryId: string; path: string }) => void {
  return useShellLayoutStore((state) => state.revealChange);
}
