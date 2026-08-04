/**
 * T-12: the git surface — wires `ChangesList` + `CommitBox` + `DiffViewer`
 * (all prop-driven, zero changes to them beyond `DiffViewer`'s additive
 * `sideBySideInlineBreakpoint`) onto the context panel. Minimal-set
 * discipline (spec §2): no `SourceControlPanel` / `RepositoryList` /
 * `CommitHistoryList` / `BranchSwitcher` / `components/git/` orphans, no
 * branch/PR/sync/stash actions.
 *
 * Standard width: single-view push navigation, changes list <-> diff.
 * `expanded`: two-column split, left changes+commit / right diff. Never
 * auto-expands (A06 + spec §2 explicit ban).
 */
import { ArrowLeft, GitBranch } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { ChangesList } from '@/components/source-control/ChangesList';
import { CommitBox } from '@/components/source-control/CommitBox';
import { DiffViewer } from '@/components/source-control/DiffViewer';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { useGitStatus } from '@/hooks/useGit';
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
import { useShellLayoutStore } from '@/stores/shellLayout';
import { SURFACE_ESCAPE_HOLD_ATTR } from '../shellLayoutModel';
import type { ContextSurfaceId } from '../surfaceRegistry';
import {
  deriveGitSurfacePresentation,
  GIT_CHANGES_PANE_WIDTH,
  type GitWorkdirResolution,
  partitionFileChanges,
  reduceGitSurfaceView,
  resolveGitWorkdir,
} from './gitSurfaceModel';

// Structurally identical to surfaceViews.tsx's `SurfaceViewProps` — defined
// locally instead of imported so this file has zero dependency on the wiring
// file the orchestrator owns.
interface GitSurfaceViewProps {
  surfaceId: ContextSurfaceId;
}

/** Same Empty/EmptyMedia/EmptyHeader/EmptyTitle/EmptyDescription pattern as `SurfacePlaceholder`. */
function GitEmptyState({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="h-full gap-3 border-0 p-2 md:p-2">
      <EmptyMedia variant="icon">
        <GitBranch className="h-4.5 w-4.5" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle className="text-ui tracking-normal">{title}</EmptyTitle>
        <EmptyDescription className="text-meta">{description}</EmptyDescription>
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
  const { t } = useI18n();
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

  const [state, dispatch] = useReducer(reduceGitSurfaceView, { selection: null });

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

  const view: 'list' | 'diff' = state.selection ? 'diff' : 'list';
  const presentation = deriveGitSurfacePresentation({ expanded, selection: state.selection });

  const fileDiffQuery = useFileDiff(
    workdir,
    state.selection?.path ?? null,
    state.selection?.staged ?? false,
    // useFileDiff's own 2s poll has no isActive gate — must be disabled
    // explicitly here or it keeps polling while the git surface is hidden.
    { enabled: surfaceActive && view === 'diff' }
  );

  const stageMutation = useGitStage();
  const unstageMutation = useGitUnstage();
  const discardMutation = useGitDiscard();
  const commitMutation = useGitCommit();

  const handleFileClick = useCallback((file: { path: string; staged: boolean }) => {
    dispatch({ type: 'select', file });
  }, []);

  const handleBack = useCallback(() => {
    dispatch({ type: 'back' });
  }, []);

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
    return <GitEmptyState title={emptyCopy.title} description={emptyCopy.description} />;
  }

  const changesPane = (
    <div className="flex h-full min-h-0 flex-col">
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

  if (presentation === 'diff') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-6 w-6 shrink-0"
            aria-label={t('Back to changes')}
            title={t('Back to changes')}
            onClick={handleBack}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {state.selection?.path}
          </span>
        </div>
        {diffPane}
      </div>
    );
  }

  return changesPane;
}
