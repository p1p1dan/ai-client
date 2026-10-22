/**
 * T-22 (D19): shell layout store — a thin zustand + persist wrapper around the
 * pure models in `components/workspace-shell/` (`shellLayoutModel.ts` for the
 * sidebar and persistence, `workPanelModel.ts` for the right work panel).
 * Every decision lives in those pure modules; this file only wires actions to
 * `set` so the store cannot behave differently from them.
 *
 * Layout 5a (ui-cohesion §6): the icon rail and its surface switcher are gone.
 * The sidebar is the chat list and collapses entirely; git / files / context /
 * run, the review, the terminal and the editor are tabs of one work panel.
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
  clampWorkPanelWidth,
  closeWorkPanel,
  nextChangeFocus,
  openWorkPanelTab,
  tabForIntent,
  toggleWorkPanelTab,
  type WorkPanelChangeFocus,
  type WorkPanelState,
  type WorkPanelTab,
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

/** Session-only work panel state (ruling L3: every start begins closed). */
export interface WorkPanelSessionState {
  workPanelOpen: boolean;
  workPanelHistory: WorkPanelTab[];
  /** The panel covers the whole center row (the expand button). */
  expanded: boolean;
  /** The init-script terminal was opened; from then on it has a tab. */
  setupTerminalOpened: boolean;
  /** Bumped by Ctrl/Cmd+1; the sidebar focuses its chat list on change. */
  chatListFocusSeq: number;
}

const initialWorkPanelSession: WorkPanelSessionState = {
  workPanelOpen: false,
  workPanelHistory: [],
  expanded: false,
  setupTerminalOpened: false,
  chatListFocusSeq: 0,
};

export interface ShellLayoutState
  extends PersistedShellLayout,
    ShellSessionOverrides,
    WorkPanelSessionState {
  // sidebar
  setSidebarWidth: (width: number) => void;
  /** Ctrl/Cmd+B and the sidebar / title bar toggles. */
  toggleSidebar: () => void;
  /** Ctrl/Cmd+1: expand the sidebar if needed and focus the chat list. */
  focusChatList: () => void;
  // work panel
  openWorkPanel: (tab: WorkPanelTab) => void;
  /** `shownTab` is what the panel shows now (`resolveWorkPanelView`). */
  toggleWorkPanel: (tab: WorkPanelTab, shownTab: WorkPanelTab | null) => void;
  closeWorkPanel: () => void;
  /** Opens a registry surface's tab; surfaces that are not navigable are ignored. */
  openSurface: (id: ContextSurfaceId) => void;
  openInitializationTerminal: () => void;
  toggleExpanded: () => void;
  setWorkPanelWidth: (width: number) => void;
  setManualChat: (visible: boolean) => void;
  /** T-32 (A08 §06-4): the file closed — the override it scoped goes with it. */
  clearManualOverrides: () => void;
  // reading column
  toggleReadingWidthMode: () => void;
  // layout 5c: the timeline's change card (session-only, never persisted)
  /** The last file the change card asked the changes tab to show. */
  changeFocus: WorkPanelChangeFocus | null;
  /** Opens the changes tab and asks it to show `target`. */
  revealChange: (target: { entryId: string; path: string }) => void;
}

function panelStateOf(state: ShellLayoutState): WorkPanelState {
  return { open: state.workPanelOpen, tab: state.workPanelTab, history: state.workPanelHistory };
}

/** Writes a model result back; closing also leaves the expanded overlay. */
function fromPanelState(next: WorkPanelState): Partial<ShellLayoutState> {
  return {
    workPanelOpen: next.open,
    workPanelTab: next.tab,
    workPanelHistory: next.history,
    ...(next.open ? {} : { expanded: false }),
  };
}

/**
 * Selector for the registry surface the panel shows, or null. The surface
 * views no longer read it (they take `active` from the panel); kept for
 * non-React callers and tests.
 */
export function selectActiveSurfaceId(state: ShellLayoutState): ContextSurfaceId | null {
  if (!state.workPanelOpen) return null;
  switch (state.workPanelTab) {
    case 'files':
      return 'editor';
    case 'git':
    case 'context':
    case 'run':
      return state.workPanelTab;
    case 'setup':
      return 'terminal';
    default:
      return null;
  }
}

export const useShellLayoutStore = create<ShellLayoutState>()(
  persist(
    (set) => ({
      ...defaultShellLayout,
      ...initialSessionOverrides,
      ...initialWorkPanelSession,

      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      focusChatList: () =>
        set((state) => ({
          sidebarCollapsed: false,
          chatListFocusSeq: state.chatListFocusSeq + 1,
        })),

      openWorkPanel: (tab) =>
        set((state) => fromPanelState(openWorkPanelTab(panelStateOf(state), tab))),
      toggleWorkPanel: (tab, shownTab) =>
        set((state) => fromPanelState(toggleWorkPanelTab(panelStateOf(state), tab, shownTab))),
      closeWorkPanel: () => set((state) => fromPanelState(closeWorkPanel(panelStateOf(state)))),
      openSurface: (id) =>
        set((state) => {
          if (getSurface(id)?.registeredOnly !== false) return {};
          const tab = tabForIntent({ type: 'surface', surfaceId: id });
          return tab ? fromPanelState(openWorkPanelTab(panelStateOf(state), tab)) : {};
        }),
      openInitializationTerminal: () =>
        set((state) => ({
          setupTerminalOpened: true,
          ...fromPanelState(openWorkPanelTab(panelStateOf(state), 'setup')),
        })),
      toggleExpanded: () =>
        set((state) => (state.workPanelOpen ? { expanded: !state.expanded } : {})),
      setWorkPanelWidth: (width) => set({ workPanelWidth: clampWorkPanelWidth(width) }),

      setManualChat: (visible) => set({ manualChat: visible }),
      clearManualOverrides: () => set({ ...initialSessionOverrides }),

      toggleReadingWidthMode: () =>
        set((state) => ({ readingWidthMode: nextReadingWidthMode(state.readingWidthMode) })),

      changeFocus: null,
      revealChange: (target) =>
        set((state) => ({
          ...fromPanelState(openWorkPanelTab(panelStateOf(state), 'changes')),
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
        workPanelTab: state.workPanelTab,
        workPanelWidth: state.workPanelWidth,
        readingWidthMode: state.readingWidthMode,
      }),
      // v1–v3 → v4 (layout 5a): see `migrateShellLayoutPersisted` — the rail
      // width leaves the sidebar width, the rail order / per-surface widths /
      // editor ratio are dropped, a surface that moved to the work panel
      // becomes its last tab.
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
