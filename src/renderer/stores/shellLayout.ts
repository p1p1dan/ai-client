/**
 * T-22 (D19): shell layout store — a thin zustand + persist wrapper around the
 * pure model in `components/workspace-shell/shellLayoutModel.ts`. Every
 * decision (clamps, the surface state machine, persistence hygiene) lives in
 * that pure module; this file only wires actions to `set`/`get` so the store
 * can never behave differently than the pure functions it delegates to.
 *
 * localStorage (not `electronStorage`): localStorage is synchronous, so there
 * is no hydration-flicker frame before the persisted layout applies.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  clampEditorRatio,
  type ManualOverride,
} from '@/components/workspace-shell/centerLayoutModel';
import {
  clampContextPanelWidth,
  clampSidebarWidth,
  defaultShellLayout,
  nextReadingWidthMode,
  type PersistedShellLayout,
  readingColumnClass,
  reduceShellSurface,
  type ShellSurfaceState,
  sanitizeShellLayoutPersisted,
} from '@/components/workspace-shell/shellLayoutModel';
import type { ContextSurfaceId } from '@/components/workspace-shell/surfaceRegistry';
import { sortSurfaces } from '@/components/workspace-shell/surfaceRegistry';

/**
 * T-32 (D27): A08 §06-4 scopes the manual overrides to the open file — they are
 * deliberately NOT in `PersistedShellLayout`, so a restart cannot resurrect an
 * override for a file that is no longer open.
 */
export interface ShellSessionOverrides {
  manualPanel: ManualOverride;
  manualChat: ManualOverride;
}

export const initialSessionOverrides: ShellSessionOverrides = {
  manualPanel: null,
  manualChat: null,
};

export interface ShellLayoutState extends PersistedShellLayout, ShellSessionOverrides {
  // sidebar
  setSidebarWidth: (width: number) => void;
  // context panel
  selectSurface: (id: ContextSurfaceId) => void;
  openSurface: (id?: ContextSurfaceId) => void;
  closeSurface: () => void;
  toggleContextPanel: () => void;
  toggleExpanded: () => void;
  setPanelWidth: (width: number, availableWidth?: number | null) => void;
  /** T-32: commits an `ed-grip` drag as a share of the center row. */
  setEditorRatio: (ratio: number) => void;
  /** T-32: the user overriding the level ladder while a file is open. */
  setManualPanel: (visible: boolean) => void;
  setManualChat: (visible: boolean) => void;
  /** T-32 (A08 §06-4): the file closed — the overrides it scoped go with it. */
  clearManualOverrides: () => void;
  /** Reserved for rail drag-sort (postponed); already sanitized through the registry. */
  setRailOrder: (order: readonly string[]) => void;
  // reading column
  toggleReadingWidthMode: () => void;
}

/**
 * Stamps a reducer result with the manual override it implies: the user just
 * said what they want, so the ladder must yield until the file closes.
 */
function withManualPanel(next: ShellSurfaceState): ShellSurfaceState & { manualPanel: boolean } {
  return { ...next, manualPanel: next.activeSurfaceId !== null };
}

/** Projects the store's persisted fields onto the pure reducer's smaller state shape. */
function surfaceStateOf(state: PersistedShellLayout): ShellSurfaceState {
  return {
    activeSurfaceId: state.activeSurfaceId,
    lastSurfaceId: state.lastSurfaceId,
    expanded: state.expanded,
  };
}

export const useShellLayoutStore = create<ShellLayoutState>()(
  persist(
    (set) => ({
      ...defaultShellLayout,
      ...initialSessionOverrides,

      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),

      // T-32 m2: every EXPLICIT panel action also records a manual override.
      // Without this the level ladder wins forever: at L1 it hides the panel,
      // and clicking a rail icon only set `activeSurfaceId` — visibility stayed
      // false, so the panel could never be summoned back on a narrow window
      // (user report: "页面较小时打开文件无法唤出右侧栏骨架").
      // `manualPanel` mirrors the resulting intent, so an explicit close at L0
      // is equally respected. Cleared when the file closes (A08 §06-4).
      selectSurface: (id) =>
        set((state) =>
          withManualPanel(
            reduceShellSurface(surfaceStateOf(state), { type: 'select', surfaceId: id })
          )
        ),
      openSurface: (id) =>
        set((state) =>
          withManualPanel(
            reduceShellSurface(surfaceStateOf(state), { type: 'open', surfaceId: id })
          )
        ),
      closeSurface: () =>
        set((state) =>
          withManualPanel(reduceShellSurface(surfaceStateOf(state), { type: 'close' }))
        ),
      toggleContextPanel: () =>
        set((state) =>
          withManualPanel(reduceShellSurface(surfaceStateOf(state), { type: 'toggle-panel' }))
        ),
      toggleExpanded: () =>
        set((state) => reduceShellSurface(surfaceStateOf(state), { type: 'toggle-expanded' })),

      setPanelWidth: (width, availableWidth) =>
        set({ panelWidth: clampContextPanelWidth(width, availableWidth) }),

      setEditorRatio: (ratio) => set({ editorRatio: clampEditorRatio(ratio) }),

      setManualPanel: (visible) => set({ manualPanel: visible }),
      setManualChat: (visible) => set({ manualChat: visible }),
      clearManualOverrides: () => set({ ...initialSessionOverrides }),

      setRailOrder: (order) => set({ railOrder: sortSurfaces(order).map((surface) => surface.id) }),

      toggleReadingWidthMode: () =>
        set((state) => ({ readingWidthMode: nextReadingWidthMode(state.readingWidthMode) })),
    }),
    {
      name: 'aiclient-shell-layout',
      version: 3,
      storage: createJSONStorage(() => localStorage),
      // Only the persisted data fields — actions are never serialized.
      partialize: (state): PersistedShellLayout => ({
        sidebarWidth: state.sidebarWidth,
        activeSurfaceId: state.activeSurfaceId,
        lastSurfaceId: state.lastSurfaceId,
        expanded: state.expanded,
        panelWidth: state.panelWidth,
        railOrder: state.railOrder,
        readingWidthMode: state.readingWidthMode,
        editorRatio: state.editorRatio,
      }),
      // v1 → v2 (T-32): `railOrder` was persisted before the registry moved to
      // A08's tab order, so a v1 profile pins the OLD order — the tab strip
      // rendered `context|git|editor|terminal` while the digits followed the
      // new one. `widthBySurface` is likewise gone (one panel width now).
      //
      // v2 → v3 (D08): same trap, new cause. `chat` moved to the FRONT of the
      // registry, but `sortSurfaces` honours a persisted order first and only
      // appends what is missing — so a v2 profile would render the dock as
      // `git|files|context|run|chat`, with the session list last. The old
      // `shellColumnMode` goes too (the mode no longer exists), and the dock is
      // forced open on `chat`: a v2 user's left column was ALWAYS the session
      // list, so landing them on a collapsed rail would read as data loss.
      migrate: (persisted, version) => {
        const raw = persisted as Record<string, unknown> | null;
        if (version < 3 && raw && typeof raw === 'object') {
          const {
            railOrder: _staleOrder,
            widthBySurface: _staleWidths,
            shellColumnMode: _retiredMode,
            ...rest
          } = raw;
          return sanitizeShellLayoutPersisted({
            ...rest,
            activeSurfaceId: 'chat',
            lastSurfaceId: 'chat',
            // `expanded` is only legal while a surface is active; the sanitiser
            // would keep a stale `true` now that one always is.
            expanded: false,
          });
        }
        return sanitizeShellLayoutPersisted(persisted);
      },
      merge: (persisted, current) => ({ ...current, ...sanitizeShellLayoutPersisted(persisted) }),
    }
  )
);

/** Single hook used by chat components so they never import the shell dir. */
export function useReadingColumnClass(): string {
  return readingColumnClass(useShellLayoutStore((state) => state.readingWidthMode));
}
