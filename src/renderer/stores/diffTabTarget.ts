/**
 * D34-E: pure model for "diff tabs" — center-column pages that show a git
 * diff instead of file content, opened from `GitSurfaceView` the same way a
 * Files-tree click opens a file (T-13's `fileOpenIntent` → `EditorColumn`
 * pattern, but no intent indirection is needed here: `GitSurfaceView` is
 * already mounted and has already resolved `workdir` by the time a user can
 * click a row, so it can call `useEditorStore.getState().openDiffTab`
 * directly).
 *
 * Recon finding that shaped this file: `useEditorStore`'s `tabs` array
 * already has a "non-Monaco body" precedent (`isUnsupported` / image / pdf
 * tabs in `EditorArea.tsx` all skip the Monaco `<Editor>` and render
 * something else). A diff tab reuses that same precedent — `EditorTab` grows
 * one optional `diffTarget` field instead of duplicating tab-strip/tab-order/
 * worktree-isolation/close/reorder machinery in a parallel store. Kept pure
 * and dependency-free (no store import) so vitest (node env) can cover the
 * pseudo-path/title derivation without touching Monaco.
 */
import type { FileChangeStatus } from '@shared/types';

/** A file's live working-tree diff (staged or unstaged), `useFileDiff`-shaped. */
export interface DiffTabWorkdirTarget {
  kind: 'workdir';
  path: string;
  staged: boolean;
  /** For the tab title's status suffix — display only, never a query key. */
  status?: FileChangeStatus;
}

/** A file's diff inside one historical commit, `useCommitDiff`-shaped. */
export interface DiffTabCommitTarget {
  kind: 'commit';
  path: string;
  hash: string;
  status?: FileChangeStatus;
}

export type DiffTabTarget = DiffTabWorkdirTarget | DiffTabCommitTarget;

/**
 * `EditorTab.path` doubles as both the store's tab key and (for a real file)
 * an fs path `EditorArea`/`useEditor` read from disk. A `git-diff://` scheme
 * can never collide with a real fs path (POSIX/Win32 paths don't contain
 * `://`), so every path-keyed lookup elsewhere in the editor machinery
 * (the external-file-change watcher, `refreshFileContent`) naturally no-ops
 * for a diff tab's pseudo path instead of needing a parallel guard at each
 * call site. Ending the path in the REAL relative path is not just cosmetic
 * housekeeping: `EditorTabs.tsx`'s file-icon lookup keys off the path's
 * extension, so this also gets the right tab icon for free.
 */
export function diffTabPath(target: DiffTabTarget): string {
  return target.kind === 'workdir'
    ? `git-diff://workdir/${target.staged ? 'staged' : 'unstaged'}/${target.path}`
    : `git-diff://commit/${target.hash}/${target.path}`;
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Tab title: filename + status (D34-E spec examples: `ChangesList.tsx · M`
 * for a workdir diff, `ChangesList.tsx @ 9b17dc6` for a commit diff).
 */
export function diffTabTitle(target: DiffTabTarget): string {
  const name = fileNameOf(target.path);
  if (target.kind === 'workdir') {
    return target.status ? `${name} · ${target.status}` : name;
  }
  return `${name} @ ${target.hash.slice(0, 7)}`;
}

/**
 * D35 round 2 (user feedback, 2026-08-14): "diff tab active" is what the
 * shell reads to give the diff the WHOLE center column — chat hides, no
 * matter how wide the window is (see `centerLayoutModel.ts`'s
 * `diffTabActive` chrome input). Only the ACTIVE tab matters: a diff tab
 * sitting unfocused behind a real file tab must not suppress chat. Typed
 * against a minimal inline shape (not `EditorTab`) so this file stays
 * dependency-free — the same discipline as `diffTabPath`/`diffTabTitle`
 * above, which is also why it lives here rather than in `editor.ts` or
 * `centerLayoutModel.ts` (whose own doc note says pure-and-no-store-import).
 */
export function isDiffTabActive(
  tabs: readonly { path: string; diffTarget?: DiffTabTarget }[],
  activeTabPath: string | null
): boolean {
  if (activeTabPath === null) {
    return false;
  }
  return tabs.some((tab) => tab.path === activeTabPath && tab.diffTarget != null);
}
