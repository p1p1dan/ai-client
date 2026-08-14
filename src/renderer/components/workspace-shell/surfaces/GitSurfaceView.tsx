/**
 * T-12: the git surface — wires `ChangesList` + `CommitBox` + `DiffViewer`
 * (all prop-driven, zero changes to them beyond `DiffViewer`'s additive
 * `sideBySideInlineBreakpoint`) onto the context panel, plus a `GitHistoryList`
 * flat-history section under `CommitBox` (D30(a), 2026-08-11).
 *
 * D30(a) walks back exactly the "no history" half of the minimal-set ban
 * below — the decision explicitly names `CommitHistoryList` reuse as the
 * thing it overturns. It does NOT reuse that component verbatim though:
 * `CommitHistoryList`'s revert/reset context menu, toast wiring, and legacy
 * hardcoded colors dragged in more than the display-only scope asked for, so
 * History renders through a lean, local `GitHistoryList` instead (see that
 * file's header for the reuse-vs-fork rationale). The rest of the original
 * ban is unchanged and still in force: no `SourceControlPanel` /
 * `RepositoryList` / `BranchSwitcher` / other `components/git/` orphans, no
 * branch/PR/sync/stash actions.
 *
 * `expanded`: two-column split, left changes+commit / right diff. Never
 * auto-expands (A06 + spec §2 explicit ban). Unchanged by D34-E below.
 *
 * D34 (2026-08-14, click-to-expand): clicking a History row toggles its
 * inline file list (`GitHistoryList`'s own concern).
 *
 * D34-E (2026-08-14, diff-to-center): a file click — from `ChangesList` or
 * from a History row's expanded inline file list — now opens/reuses a
 * center-column diff tab (`useEditorStore.openDiffTab`, the same open-mode
 * `FilesSurfaceView` uses for a file, VS Code's shared tab strip). This
 * retired the two in-panel `DiffViewer`-takeover render branches the standard
 * (non-`expanded`) width used to push into: the single-view `state.selection`
 * diff and the per-commit `state.selectedCommitFile` diff. `expanded`'s
 * split `diffPane` is a THIRD, separate `DiffViewer` mount (a docked preview
 * pane, not a tab) and keeps working exactly as before — the spec's explicit
 * "维持现状不动" — still driven by `state.selection`, still updated on every
 * file click alongside the new center tab.
 */
import type { FileChangeStatus } from '@shared/types';
import { getDisplayPath } from '@shared/utils/path';
import { GitBranch } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { ChangesList } from '@/components/source-control/ChangesList';
import { CommitBox } from '@/components/source-control/CommitBox';
import { DiffViewer } from '@/components/source-control/DiffViewer';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { useGitStatus } from '@/hooks/useGit';
import { useGitHistoryInfinite } from '@/hooks/useGitHistory';
import {
  useFileChanges,
  useFileDiff,
  useGitCommit,
  useGitDiscard,
  useGitStage,
  useGitUnstage,
} from '@/hooks/useSourceControl';
import { useI18n } from '@/i18n';
import { useChatSessionsStore } from '@/stores/chatSessions';
import type { DiffTabTarget } from '@/stores/diffTabTarget';
import { useEditorStore } from '@/stores/editor';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { SURFACE_ESCAPE_HOLD_ATTR } from '../shellLayoutModel';
import type { ContextSurfaceId } from '../surfaceRegistry';
import { GitHistoryList } from './GitHistoryList';
import {
  deriveGitSurfacePresentation,
  GIT_CHANGES_PANE_WIDTH,
  type GitSurfaceCommitFile,
  type GitWorkdirResolution,
  initialGitSurfaceViewState,
  partitionFileChanges,
  reduceGitSurfaceView,
  resolveGitWorkdir,
} from './gitSurfaceModel';

/** Commits per page — matches the spec's "~30 commits initial page". */
const GIT_HISTORY_PAGE_SIZE = 30;

// Structurally identical to surfaceViews.tsx's `SurfaceViewProps` — defined
// locally instead of imported so this file has zero dependency on the wiring
// file the orchestrator owns.
interface GitSurfaceViewProps {
  surfaceId: ContextSurfaceId;
}

/** Same Empty/EmptyMedia/EmptyHeader/EmptyTitle/EmptyDescription pattern as `SurfacePlaceholder`. */
function GitEmptyState({
  title,
  description,
  judgedPath,
}: {
  title: string;
  description: string;
  /** The workspace directory the "not a repo" verdict was reached on. */
  judgedPath?: string;
}) {
  return (
    <Empty className="h-full gap-3 border-0 p-2 md:p-2">
      <EmptyMedia variant="icon">
        <GitBranch className="h-4.5 w-4.5" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle className="text-ui tracking-normal">{title}</EmptyTitle>
        <EmptyDescription className="text-meta">{description}</EmptyDescription>
        {judgedPath ? (
          // Which directory was actually judged. No new copy — the path is the
          // whole message, so there is nothing to translate; `title` carries
          // the untruncated value for a path too long for the panel.
          <span
            className="mt-1 block min-w-0 max-w-full truncate text-meta text-muted-foreground"
            title={judgedPath}
          >
            {getDisplayPath(judgedPath)}
          </span>
        ) : null}
      </EmptyHeader>
    </Empty>
  );
}

function useGitEmptyStateCopy(
  reason: Exclude<GitWorkdirResolution, { workdir: string }>['reason']
) {
  const { t } = useI18n();
  switch (reason) {
    case 'no-session':
      return {
        title: t('No active session'),
        description: t('Select a chat session to view its git changes.'),
      };
    case 'no-path':
      return {
        title: t('Workspace path unavailable'),
        description: t("This session's workspace has no resolved path yet."),
      };
    case 'not-git':
      return {
        // Reuses the existing "Not a Git repository" title key (shared/i18n.ts).
        title: t('Not a Git repository'),
        description: t('This workspace is not tracked by Git.'),
      };
    default:
      return { title: '', description: '' };
  }
}

export function GitSurfaceView({ surfaceId }: GitSurfaceViewProps) {
  const activeSurfaceId = useShellLayoutStore((s) => s.activeSurfaceId);
  const expanded = useShellLayoutStore((s) => s.expanded);
  const surfaceActive = activeSurfaceId === surfaceId;

  const activeSessionId = useChatSessionsStore((s) => s.activeSessionId);
  const sessions = useChatSessionsStore((s) => s.sessions);
  const workspaces = useChatSessionsStore((s) => s.workspaces);

  const resolution = useMemo<GitWorkdirResolution>(
    () =>
      resolveGitWorkdir({
        activeSessionId,
        sessions,
        workspaces,
      }),
    [activeSessionId, sessions, workspaces]
  );
  const workdir = 'workdir' in resolution ? resolution.workdir : null;

  const [state, dispatch] = useReducer(reduceGitSurfaceView, initialGitSurfaceViewState);

  // Reset the selection whenever the resolved workdir changes out from under it
  // (workspace switch, session switch) — a stale path/staged pair from the
  // previous repo must never be diffed against the new one.
  const prevWorkdirRef = useRef(workdir);
  useEffect(() => {
    if (prevWorkdirRef.current !== workdir) {
      prevWorkdirRef.current = workdir;
      dispatch({ type: 'workdir-changed' });
    }
  }, [workdir]);

  const fileChangesQuery = useFileChanges(workdir, surfaceActive);
  // Not consumed directly (the list renders from useFileChanges above) — this
  // shares gitQueryKeys.status's cache key with the rail dot (useGitChangeCount),
  // so opening the git surface also keeps the dot's count fresh while active.
  useGitStatus(workdir, surfaceActive);

  const partitioned = useMemo(
    () => partitionFileChanges(fileChangesQuery.data),
    [fileChangesQuery.data]
  );

  // D30(a): History section data — the existing GIT_LOG infinite-query hook,
  // no backend changes. Runs regardless of `state.historyExpanded` (default
  // expanded, and collapsing shouldn't throw away an already-loaded page).
  const historyQuery = useGitHistoryInfinite(workdir, GIT_HISTORY_PAGE_SIZE);
  const historyCommits = useMemo(() => historyQuery.data?.pages.flat() ?? [], [historyQuery.data]);

  // If the selected file is no longer present (staged away, discarded,
  // committed) once real data has arrived, fall back to the list instead of
  // showing a diff for a file that no longer has one.
  useEffect(() => {
    if (!fileChangesQuery.data || !state.selection) return;
    const stillThere = [...partitioned.staged, ...partitioned.unstaged].some(
      (f) => f.path === state.selection?.path && f.staged === state.selection?.staged
    );
    if (!stillThere) {
      dispatch({ type: 'selection-gone' });
    }
  }, [fileChangesQuery.data, partitioned, state.selection]);

  // D34-E: `diffPane` (the `expanded`/split docked preview) is the only
  // remaining in-panel DiffViewer consumer — gated on `expanded` too now, so
  // a plain (non-expanded) file click doesn't leave a wasted live-poll query
  // running for a pane nothing renders any more.
  const view: 'list' | 'diff' = state.selection ? 'diff' : 'list';
  const presentation = deriveGitSurfacePresentation({ expanded });

  const fileDiffQuery = useFileDiff(
    workdir,
    state.selection?.path ?? null,
    state.selection?.staged ?? false,
    // useFileDiff's own 2s poll has no isActive gate — must be disabled
    // explicitly here or it keeps polling while the git surface is hidden,
    // or while `expanded` isn't showing `diffPane` at all.
    { enabled: surfaceActive && expanded && view === 'diff' }
  );

  const stageMutation = useGitStage();
  const unstageMutation = useGitUnstage();
  const discardMutation = useGitDiscard();
  const commitMutation = useGitCommit();

  const openDiffTab = useEditorStore((s) => s.openDiffTab);

  // D34-E: every file click opens/reuses a center-column diff tab (VS Code's
  // shared tab strip, the same open-mode a Files-tree click uses) AND keeps
  // `state.selection` updated — the latter still drives `diffPane` in
  // `expanded`/split mode (unchanged) and `ChangesList`'s row highlight.
  const handleFileClick = useCallback(
    (file: { path: string; staged: boolean }) => {
      dispatch({ type: 'select', file });
      const status = [...partitioned.staged, ...partitioned.unstaged].find(
        (f) => f.path === file.path && f.staged === file.staged
      )?.status;
      const target: DiffTabTarget = {
        kind: 'workdir',
        path: file.path,
        staged: file.staged,
        status,
      };
      openDiffTab(target);
    },
    [partitioned, openDiffTab]
  );

  const handleToggleHistory = useCallback(() => {
    dispatch({ type: 'toggle-history' });
  }, []);

  const handleLoadMoreHistory = useCallback(() => {
    historyQuery.fetchNextPage();
  }, [historyQuery]);

  const handleToggleCommit = useCallback((hash: string) => {
    dispatch({ type: 'toggle-commit', hash });
  }, []);

  // D34-E: same treatment as `handleFileClick` — `select-commit-file` now
  // only drives `GitHistoryList`'s row highlight (the render takeover it used
  // to drive retired); the diff itself opens as a center tab.
  const handleSelectCommitFile = useCallback(
    (file: GitSurfaceCommitFile) => {
      dispatch({ type: 'select-commit-file', file });
      const target: DiffTabTarget = {
        kind: 'commit',
        path: file.path,
        hash: file.hash,
        status: file.status as FileChangeStatus | undefined,
      };
      openDiffTab(target);
    },
    [openDiffTab]
  );

  const handleStage = useCallback(
    (paths: string[]) => {
      if (!workdir) return;
      stageMutation.mutate({ workdir, paths });
    },
    [workdir, stageMutation]
  );

  const handleUnstage = useCallback(
    (paths: string[]) => {
      if (!workdir) return;
      unstageMutation.mutate({ workdir, paths });
    },
    [workdir, unstageMutation]
  );

  const handleDiscard = useCallback(
    (paths: string[]) => {
      if (!workdir) return;
      discardMutation.mutate({ workdir, paths });
    },
    [workdir, discardMutation]
  );

  const handleCommit = useCallback(
    (message: string) => {
      if (!workdir) return;
      commitMutation.mutate({ workdir, message });
    },
    [workdir, commitMutation]
  );

  const handleRefresh = useCallback(() => {
    fileChangesQuery.refetch();
  }, [fileChangesQuery]);

  const emptyCopy = useGitEmptyStateCopy('reason' in resolution ? resolution.reason : 'no-session');

  if (!workdir) {
    return (
      <GitEmptyState
        title={emptyCopy.title}
        description={emptyCopy.description}
        judgedPath={'judgedPath' in resolution ? resolution.judgedPath : undefined}
      />
    );
  }

  const changesPane = (
    <div className="flex h-full min-h-0 flex-col">
      {/* D34: docked git surface is split 50/50 top-half (Changes + CommitBox)
          vs bottom-half (History) — `flex-1` on both halves, not just the
          top one, so History gets an equal, non-collapsing share of the
          panel instead of shrinking to its content (VS Code SCM reference). */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          <ChangesList
            staged={partitioned.staged}
            unstaged={partitioned.unstaged}
            selectedFile={state.selection}
            onFileClick={handleFileClick}
            onStage={handleStage}
            onUnstage={handleUnstage}
            onDiscard={handleDiscard}
            onRefresh={handleRefresh}
            isRefreshing={fileChangesQuery.isFetching}
            repoPath={workdir}
          />
        </div>
        <CommitBox
          stagedCount={partitioned.staged.length}
          onCommit={handleCommit}
          isCommitting={commitMutation.isPending}
          rootPath={workdir}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-t">
        <GitHistoryList
          commits={historyCommits}
          expanded={state.historyExpanded}
          expandedCommitHash={state.expandedCommitHash}
          hasNextPage={historyQuery.hasNextPage}
          isFetchingNextPage={historyQuery.isFetchingNextPage}
          isLoading={historyQuery.isLoading}
          onLoadMore={handleLoadMoreHistory}
          onSelectCommitFile={handleSelectCommitFile}
          onToggle={handleToggleHistory}
          onToggleCommit={handleToggleCommit}
          selectedCommitFile={state.selectedCommitFile}
          workdir={workdir}
        />
      </div>
    </div>
  );

  const diffPane = (
    // Monaco owns Escape for its find/suggest widgets (F-c/R1) — this marks the
    // subtree so ContextPanel's capture-phase Escape handler skips it instead
    // of closing the whole panel.
    <div className="min-h-0 flex-1" {...{ [SURFACE_ESCAPE_HOLD_ATTR]: '' }}>
      <DiffViewer
        rootPath={workdir}
        file={state.selection}
        isActive={surfaceActive}
        diff={fileDiffQuery.data ?? undefined}
        skipFetch
        // T-12 batch-C fix (Opus M4): DiffViewer's own query is disabled via
        // `skipFetch`, so its internal `isLoading` can't reflect this
        // query's state — pass it through explicitly so the loading branch
        // renders instead of a false "Failed to load diff" flash.
        isLoading={fileDiffQuery.isPending}
        sideBySideInlineBreakpoint={700}
      />
    </div>
  );

  if (presentation === 'split') {
    return (
      <div className="flex h-full min-h-0">
        <div
          className="flex h-full min-h-0 shrink-0 flex-col border-r"
          style={{ width: GIT_CHANGES_PANE_WIDTH }}
        >
          {changesPane}
        </div>
        {diffPane}
      </div>
    );
  }

  // D34-E: the non-expanded standard width no longer pushes into a
  // single-view diff on file click — `presentation` is 'changes' here, and
  // the click already opened a center tab (`handleFileClick`).
  return changesPane;
}
