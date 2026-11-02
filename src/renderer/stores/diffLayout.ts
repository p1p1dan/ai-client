/**
 * PiLab R2 (FR-07.3; user, 2026-11-02, preview
 * `docs/design/2026-11-02-diff-layout-toggle-preview.html`): how diffs are laid
 * out — 「上下」 (unified) or 「并排」 (split). One choice for every diff (the
 * review pane, the diff tab, a subagent's tool rows), unified by default,
 * switched only from a diff's own header, and kept across restarts the way
 * `runPanelPreferences.ts` keeps its view state.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type DiffLayout = 'unified' | 'split';

/**
 * Below this width a split diff leaves each side under ~30 characters, so a
 * pane this narrow shows it unified without changing the user's choice. The
 * Monaco diff tab keeps its own breakpoint (`sideBySideInlineBreakpoint`).
 */
export const DIFF_SPLIT_MIN_WIDTH = 560;

interface DiffLayoutState {
  layout: DiffLayout;
  setLayout: (layout: DiffLayout) => void;
}

/** A stored value this build understands, else the default. */
export function sanitizeDiffLayout(value: unknown): { layout: DiffLayout } {
  const layout = (value as { layout?: unknown } | null | undefined)?.layout;
  return { layout: layout === 'split' ? 'split' : 'unified' };
}

export const useDiffLayoutStore = create<DiffLayoutState>()(
  persist(
    (set) => ({
      layout: 'unified',
      setLayout: (layout) => set({ layout }),
    }),
    {
      name: 'aiclient-diff-layout',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ layout: state.layout }),
      merge: (persisted, current) => ({ ...current, ...sanitizeDiffLayout(persisted) }),
    }
  )
);

/** Too narrow to split, whatever the choice; `null` (not measured) is not. */
export function diffTooNarrowToSplit(width: number | null): boolean {
  return width !== null && width < DIFF_SPLIT_MIN_WIDTH;
}

/** The layout a diff of this width shows: the user's choice, unless too narrow to split. */
export function effectiveDiffLayout(layout: DiffLayout, width: number | null): DiffLayout {
  return layout === 'split' && !diffTooNarrowToSplit(width) ? 'split' : 'unified';
}
