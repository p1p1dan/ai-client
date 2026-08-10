/**
 * T-12: pure model for the git surface (`GitSurfaceView.tsx`). Same pattern as
 * `shellLayoutModel.ts` — every decision lives here so vitest (node env,
 * `.ts` only) can cover it without mounting React or Monaco.
 */
import type { FileChange, FileChangesResult } from '@shared/types';

// ── layout constants ────────────────────────────────────────────────────
/** Left column width (changes list + commit box) in the `expanded` split presentation. */
export const GIT_CHANGES_PANE_WIDTH = 320;

// ── partitionFileChanges ────────────────────────────────────────────────
export interface PartitionedFileChanges {
  staged: FileChange[];
  unstaged: FileChange[];
  /** Passed through from the fetch result; undefined input -> false. */
  truncated: boolean;
  truncatedLimit?: number;
}

/**
 * Splits a `FileChangesResult` into staged/unstaged groups for `ChangesList`.
 * `originalPath` (renames) and every other `FileChange` field pass through
 * untouched — this only partitions, never rebuilds the entries. Missing
 * input (query not yet settled) -> both groups empty, not an error state.
 */
export function partitionFileChanges(
  result: FileChangesResult | null | undefined
): PartitionedFileChanges {
  if (!result) {
    return { staged: [], unstaged: [], truncated: false };
  }

  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  for (const change of result.changes) {
    (change.staged ? staged : unstaged).push(change);
  }

  return {
    staged,
    unstaged,
    truncated: result.truncated ?? false,
    truncatedLimit: result.truncatedLimit,
  };
}

// ── git surface selection state machine ─────────────────────────────────
export interface GitSurfaceSelection {
  path: string;
  staged: boolean;
}

export interface GitSurfaceViewState {
  /** null = the list view; a value = the diff view is showing this file. */
  selection: GitSurfaceSelection | null;
}

export const initialGitSurfaceViewState: GitSurfaceViewState = { selection: null };

export type GitSurfaceViewAction =
  | { type: 'select'; file: GitSurfaceSelection }
  | { type: 'back' }
  | { type: 'workdir-changed' }
  | { type: 'selection-gone' };

/**
 * select -> diff (sets the selection); back / workdir-changed / selection-gone
 * all return to the list (clear the selection) — the workdir switching out
 * from under a stale selection and the selected file disappearing (staged/
 * discarded away) both fall back to the same safe state as pressing back.
 */
export function reduceGitSurfaceView(
  state: GitSurfaceViewState,
  action: GitSurfaceViewAction
): GitSurfaceViewState {
  switch (action.type) {
    case 'select':
      return { selection: action.file };
    case 'back':
    case 'workdir-changed':
    case 'selection-gone':
      return { selection: null };
    default:
      return state;
  }
}

// ── presentation ─────────────────────────────────────────────────────────
export type GitSurfacePresentation = 'changes' | 'diff' | 'split';

export interface DeriveGitSurfacePresentationInput {
  expanded: boolean;
  selection: GitSurfaceSelection | null;
}

/**
 * expanded always wins (two-column split, left changes+commit / right diff —
 * DiffViewer renders its own "select a file" empty state when there is no
 * selection yet). Otherwise: a selection pushes into the single-view diff,
 * no selection stays on the changes list. Never auto-expands.
 */
export function deriveGitSurfacePresentation(
  input: DeriveGitSurfacePresentationInput
): GitSurfacePresentation {
  if (input.expanded) {
    return 'split';
  }
  return input.selection ? 'diff' : 'changes';
}

// ── workdir resolution ───────────────────────────────────────────────────
export interface GitWorkdirSnapshotSession {
  id: string;
  workspaceId: string;
}

export interface GitWorkdirSnapshotWorkspace {
  id: string;
  path: string;
  /** Only `=== true` counts as git-enabled — undefined means unknown/loading, not "yes". */
  gitEnabled?: boolean;
}

export interface GitWorkdirSnapshot {
  activeSessionId: string | null;
  sessions: readonly GitWorkdirSnapshotSession[];
  workspaces: readonly GitWorkdirSnapshotWorkspace[];
}

export type GitWorkdirResolution =
  | { workdir: string }
  | {
      reason: 'no-session' | 'no-path' | 'not-git';
      /**
       * The directory the decision was made against, when one was resolved at
       * all. Rendered by the empty state: "Not a Git repository" without a
       * path forced the field to infer WHICH directory was judged from
       * unrelated evidence (an EPERM in a log). Absent for `no-session` and
       * for a workspace that has no path to name.
       */
      judgedPath?: string;
    };

/**
 * Mirrors `useGitChangeCount.ts`'s activeSession -> activeWorkspace -> path
 * lookup, but never guesses: an unresolved session, a workspace without a
 * path, and a workspace whose `gitEnabled` isn't exactly `true` (including
 * "unknown/still loading") each get their own honest reason instead of
 * collapsing to a single "no workdir" state.
 */
export function resolveGitWorkdir(snapshot: GitWorkdirSnapshot): GitWorkdirResolution {
  const activeSession = snapshot.sessions.find((s) => s.id === snapshot.activeSessionId);
  if (!activeSession) {
    return { reason: 'no-session' };
  }

  const workspace = snapshot.workspaces.find((w) => w.id === activeSession.workspaceId);
  if (!workspace || !workspace.path) {
    return { reason: 'no-path' };
  }

  if (workspace.gitEnabled !== true) {
    return { reason: 'not-git', judgedPath: workspace.path };
  }

  return { workdir: workspace.path };
}
