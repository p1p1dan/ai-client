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
  toggleSidebarCollapsed: () => void;
  setSidebarWidth: (width: number) => void;
  // context panel
  selectSurface: (id: ContextSurfaceId) => void;
  openSurface: (id?: ContextSurfaceId) => void;
  closeSurface: () => void;
  toggleContextPanel: () => void;
  toggleExpanded: () => void;
  setSurfaceWidth: (id: ContextSurfaceId, width: number, availableWidth?: number | null) => void;
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

      toggleSidebarCollapsed: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),

      selectSurface: (id) =>
        set((state) =>
          reduceShellSurface(surfaceStateOf(state), { type: 'select', surfaceId: id })
        ),
      openSurface: (id) =>
        set((state) => reduceShellSurface(surfaceStateOf(state), { type: 'open', surfaceId: id })),
      closeSurface: () =>
        set((state) => reduceShellSurface(surfaceStateOf(state), { type: 'close' })),
      toggleContextPanel: () =>
        set((state) => reduceShellSurface(surfaceStateOf(state), { type: 'toggle-panel' })),
      toggleExpanded: () =>
        set((state) => reduceShellSurface(surfaceStateOf(state), { type: 'toggle-expanded' })),

      setSurfaceWidth: (id, width, availableWidth) =>
        set((state) => ({
          widthBySurface: {
            ...state.widthBySurface,
            [id]: clampContextPanelWidth(width, availableWidth),
          },
        })),

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
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Only the persisted data fields — actions are never serialized.
      partialize: (state): PersistedShellLayout => ({
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        activeSurfaceId: state.activeSurfaceId,
        lastSurfaceId: state.lastSurfaceId,
        expanded: state.expanded,
        widthBySurface: state.widthBySurface,
        railOrder: state.railOrder,
        readingWidthMode: state.readingWidthMode,
        editorRatio: state.editorRatio,
      }),
      // No real migration yet (version stays 1) — this only protects a future
      // bump (e.g. per-directory keys) from ever seeing un-sanitized data.
      migrate: (persisted) => sanitizeShellLayoutPersisted(persisted),
      merge: (persisted, current) => ({ ...current, ...sanitizeShellLayoutPersisted(persisted) }),
    }
  )
);

/** Single hook used by chat components so they never import the shell dir. */
export function useReadingColumnClass(): string {
  return readingColumnClass(useShellLayoutStore((state) => state.readingWidthMode));
}
