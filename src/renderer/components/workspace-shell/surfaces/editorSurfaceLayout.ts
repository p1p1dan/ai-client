/**
 * T-13: width-driven layout for the editor surface (spec §3). Pure so vitest
 * (node env, `.ts` only) can cover it — same pattern as `shellLayoutModel.ts`.
 *
 * The surface never gets its own `expanded` branch: `ContextPanel` already
 * measures the real box (`resolveContextPanelWidth` returns the full row
 * width when `expanded`), and `EditorSurfaceView` re-measures that same box
 * with its own `ResizeObserver` (no new store field — panel width is an
 * existing seam, not new state). So `expanded` only ever shows up here as a
 * bigger `panelWidth`, never as a fourth input.
 */

/** Fixed width of the tree column while in `'split'` layout. */
export const EDITOR_TREE_WIDTH = 220;
/**
 * Minimum width budgeted for the editor pane (Monaco + tab strip) when
 * deciding whether there is room for `'split'` — see `EDITOR_SPLIT_MIN`. Not
 * an independent floor below which the editor stops rendering: below the
 * split threshold `resolveEditorSurfaceLayout` always keeps the editor (see
 * its doc comment for why a narrow-tree fallback would strand an open tab).
 */
export const EDITOR_MIN_WIDTH = 480;
/**
 * Minimum panel width to show tree and editor side by side — enough room for
 * the fixed tree column plus a usable editor pane (`EDITOR_TREE_WIDTH +
 * EDITOR_MIN_WIDTH`, plus a 4px seam for the column divider).
 */
export const EDITOR_SPLIT_MIN = EDITOR_TREE_WIDTH + EDITOR_MIN_WIDTH + 4;

export type EditorSurfaceLayout = 'tree-only' | 'editor-only' | 'split';

export interface ResolveEditorSurfaceLayoutInput {
  /** Measured width of the editor surface's own box (self-measured via ResizeObserver). */
  panelWidth: number;
  /** Whether the editor has at least one open tab. */
  hasOpenTab: boolean;
  /** User's tree-visibility preference — the existing `!isFileTreeCollapsed` seam. */
  treeRequested: boolean;
}

/**
 * Decides which of tree/editor is visible, per spec §3:
 * - No open tab → always `'tree-only'` (nothing else to show, regardless of
 *   width or the tree toggle — an editor pane with no tabs is a dead area).
 * - Open tab, `panelWidth >= EDITOR_SPLIT_MIN` AND the tree is requested →
 *   `'split'`, both columns fit.
 * - Everything else with an open tab → `'editor-only'` ("wide side-by-side,
 *   narrow yields" — A08's rule, scoped down to this one threshold).
 *
 * Deliberately NOT a third "too narrow for split but tree still wins" branch:
 * the tree-visibility toggle (`treeRequested`, wired from `EditorArea`'s
 * `isFileTreeCollapsed`/`onToggleFileTree`) only ever renders INSIDE
 * `EditorArea`'s own chrome. A branch that produces `'tree-only'` while
 * `hasOpenTab` is true — below `EDITOR_SPLIT_MIN` — would unmount the one
 * view that owns the button to get back to the editor, stranding the user
 * with an open tab they cannot reach until they widen the panel past
 * `EDITOR_SPLIT_MIN`. Below the split threshold the toggle still updates
 * `treeRequested` (so it's honored the instant the panel is wide enough),
 * it just has no visible effect until then — same as any other "set now,
 * takes effect once there's room" control.
 */
export function resolveEditorSurfaceLayout(
  input: ResolveEditorSurfaceLayoutInput
): EditorSurfaceLayout {
  const { panelWidth, hasOpenTab, treeRequested } = input;

  if (!hasOpenTab) {
    return 'tree-only';
  }

  return panelWidth >= EDITOR_SPLIT_MIN && treeRequested ? 'split' : 'editor-only';
}
