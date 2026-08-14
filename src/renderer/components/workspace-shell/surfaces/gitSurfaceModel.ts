/**
 * T-12: pure model for the git surface (`GitSurfaceView.tsx`). Same pattern as
 * `shellLayoutModel.ts` — every decision lives here so vitest (node env,
 * `.ts` only) can cover it without mounting React or Monaco.
 */
import type { FileChange, FileChangesResult, GitLogEntry } from '@shared/types';

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

/** A file inside an expanded commit's inline file list (D34 commit-row expand). */
export interface GitSurfaceCommitFile {
  hash: string;
  path: string;
  status?: string;
}

export interface GitSurfaceViewState {
  /** null = the list view; a value = the diff view is showing this file. */
  selection: GitSurfaceSelection | null;
  /**
   * D30(a): collapse state of the History section rendered below `CommitBox`
   * inside `changesPane`. Defaults to expanded. Independent of `selection` —
   * neither field's action touches the other.
   */
  historyExpanded: boolean;
  /**
   * D34: hash of the History row whose inline file list is expanded below it
   * (VS Code SCM graph-expand reference). null = no row expanded. Only one
   * commit can be expanded at a time — expanding a different hash replaces
   * the previous one instead of stacking.
   */
  expandedCommitHash: string | null;
  /**
   * D34: the commit file currently driving the per-commit diff view (set by
   * clicking a file inside the expanded commit's inline file list). `status`
   * carries `CommitFileChange.status` through for `getCommitDiff`'s
   * rename/merge handling. null = no commit file selected.
   */
  selectedCommitFile: GitSurfaceCommitFile | null;
}

export const initialGitSurfaceViewState: GitSurfaceViewState = {
  selection: null,
  historyExpanded: true,
  expandedCommitHash: null,
  selectedCommitFile: null,
};

export type GitSurfaceViewAction =
  | { type: 'select'; file: GitSurfaceSelection }
  | { type: 'workdir-changed' }
  | { type: 'selection-gone' }
  | { type: 'toggle-history' }
  | { type: 'toggle-commit'; hash: string }
  | { type: 'select-commit-file'; file: GitSurfaceCommitFile };

/**
 * D34-E: a file click now ALWAYS opens/reuses a center-column diff tab
 * (`useEditorStore.openDiffTab`, driven directly from `GitSurfaceView`'s
 * click handlers — not through this reducer). `selection` and
 * `selectedCommitFile` survive here only as bookkeeping the panel itself
 * still needs: `selection` drives `expanded`'s split-view `diffPane` (「展开
 * ⤡」维持现状不动) and `ChangesList`'s row highlight; `selectedCommitFile`
 * drives `GitHistoryList`'s inline-file-list row highlight. Neither any
 * longer makes an in-panel DiffViewer branch take over the pane — those
 * branches retired with the `'back'` action that used to return from them
 * (nothing dispatches it any more; removed rather than left dead).
 *
 * `workdir-changed` / `selection-gone` still return to a clean list state —
 * the workdir switching out from under a stale selection and the selected
 * file disappearing (staged/discarded away) both need the same reset.
 * `toggle-history` only flips `historyExpanded`; every other action carries
 * it through untouched, and `toggle-history` carries `selection` through
 * untouched — the two pieces of state are orthogonal.
 *
 * D34: `toggle-commit` re-clicking the already-expanded hash collapses it;
 * clicking a different hash replaces the expansion. Either way
 * `selectedCommitFile` is cleared — the file list it pointed into just
 * collapsed or got swapped out, so a stale highlight has nowhere to point.
 * `select-commit-file` only sets `selectedCommitFile`, leaving
 * `expandedCommitHash` untouched (the row stays expanded, matching the
 * center diff tab it opened). `workdir-changed` additionally clears both new
 * fields — a different repo makes the expanded hash and any file picked
 * from it meaningless.
 */
export function reduceGitSurfaceView(
  state: GitSurfaceViewState,
  action: GitSurfaceViewAction
): GitSurfaceViewState {
  switch (action.type) {
    case 'select':
      return { ...state, selection: action.file };
    case 'workdir-changed':
      return {
        ...state,
        selection: null,
        expandedCommitHash: null,
        selectedCommitFile: null,
      };
    case 'selection-gone':
      return { ...state, selection: null };
    case 'toggle-history':
      return { ...state, historyExpanded: !state.historyExpanded };
    case 'toggle-commit':
      return {
        ...state,
        expandedCommitHash: state.expandedCommitHash === action.hash ? null : action.hash,
        selectedCommitFile: null,
      };
    case 'select-commit-file':
      return { ...state, selectedCommitFile: action.file };
    default:
      return state;
  }
}

// ── presentation ─────────────────────────────────────────────────────────
// D34-E: collapsed from a 3-way ('changes' | 'diff' | 'split') to a 2-way
// type. The push-navigation single-view diff ('diff') retired along with the
// in-panel DiffViewer branch it drove — a file click no longer changes which
// pane shape the DOCKED (non-expanded) panel shows, only `expanded` does.
export type GitSurfacePresentation = 'changes' | 'split';

export interface DeriveGitSurfacePresentationInput {
  expanded: boolean;
}

/**
 * expanded -> split (two-column: left changes+commit / right diff, `diffPane`
 * unchanged from before D34-E — still driven by `state.selection`, still
 * showing DiffViewer's own "select a file" empty state with no selection).
 * Otherwise -> changes (the list; a file click opens a center tab instead of
 * changing this). Never auto-expands.
 */
export function deriveGitSurfacePresentation(
  input: DeriveGitSurfacePresentationInput
): GitSurfacePresentation {
  return input.expanded ? 'split' : 'changes';
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

// ── history section (D30a) ──────────────────────────────────────────────

/**
 * Splits a `GitLogEntry.refs` string into individual ref badge labels for the
 * History section's row pills.
 *
 * `gitLogFormat.ts` (backend) already strips a leading `"HEAD -> "` before
 * this ever reaches the renderer, so a real `refs` value looks like
 * `"main, origin/main"` or `"main, tag: v1"` — never `"HEAD -> main, ..."`.
 * This still strips a `HEAD ->` prefix defensively (matching
 * `CommitHistoryList.tsx`'s existing per-badge cleanup) so the function is
 * correct standalone even if that upstream guarantee ever changes; the
 * `tag:` prefix is real and always needs stripping.
 */
export function parseRefBadges(refs: string | undefined): string[] {
  if (!refs) {
    return [];
  }
  return refs
    .split(',')
    .map((part) =>
      part
        .replace(/^\s*HEAD\s*->\s*/, '')
        .replace(/^\s*tag:\s*/, '')
        .trim()
    )
    .filter((label) => label.length > 0);
}

/**
 * Row tooltip for a History entry: short hash + author + date. The 320px
 * changes pane has no room for hash/author/date as visible row text without
 * crowding the subject (spec: "do not crowd 380px") — this hover title is
 * the only place they surface.
 */
/**
 * D34 half-split: class list for the History Collapsible's content panel.
 * `flex-1` (not a max-height cap) lets History fill its 50% share of the
 * docked surface; the h-auto/transition-none/data-*-style overrides disable
 * the Collapsible's measured-height open/close animation, which would
 * otherwise fight the flex sizing and leave the panel stuck at 0px.
 * Kept in the model so the split invariant stays assertable from node tests.
 */
export function gitHistoryPanelClass(): string {
  return 'flex min-h-0 flex-1 flex-col h-auto overflow-visible transition-none duration-0 data-starting-style:h-auto data-ending-style:h-auto';
}

export function formatCommitTooltip(
  commit: Pick<GitLogEntry, 'hash' | 'author_name' | 'date'>
): string {
  return `${commit.hash.slice(0, 8)} · ${commit.author_name} · ${commit.date}`;
}
