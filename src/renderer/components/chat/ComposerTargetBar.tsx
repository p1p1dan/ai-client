import { useI18n } from '@/i18n';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { BranchColumn } from './BranchColumn';
import { buildBranchColumn, buildRepoColumn } from './composerColumns';
import { isTargetableWorkspace } from './composerTarget';
import { LockedRepoLabel } from './LockedRepoLabel';
import type { MiddleColumnMode } from './middleColumnLayout';
import { shouldRenderTargetRow, targetRowClass, targetRowSlots } from './middleColumnLayout';
import { RunLocationIndicator } from './RunLocationIndicator';
import { TargetFolderSelect } from './TargetFolderSelect';
import { useComposerTarget } from './useComposerTarget';

interface ComposerTargetBarProps {
  /** T-28: empty mode keeps the folder slot; session mode drops it (§3.6). */
  mode: MiddleColumnMode;
  /** ChatComposer's `sending` — an in-flight send blocks target changes too. */
  sending: boolean;
  disabled?: boolean;
  /** Opens the shared AddRepositoryDialog (owned by App); the four folder footer actions don't render without it. */
  onAddRepository?: (mode?: 'local' | 'remote' | 'ssh') => void;
}

/**
 * The target row under (or above) the composer card: repository / branch / run
 * location.
 *
 * ## Two questions that used to wear the same clothes
 *
 * This row used to hold a "worktree" dropdown (`TargetBranchSelect`) whose
 * options were workspaces filtered to `main`/`worktree`, labelled with
 * `ws.branch ?? ws.name` and drawn with a branch icon — and selecting one called
 * `selectTarget()`, which re-points the SESSION at a different checkout. It read
 * as a branch switcher and was not one, so a repository with no worktrees showed
 * a single entry that appeared to do nothing, and no control anywhere actually
 * ran `git checkout`.
 *
 * As-built, the worktree concept is gone from this row (user ruling
 * 2026-09-24). `New worktree…` went with it, which is a deliberate product
 * decision: worktrees are not part of how a conversation is chosen any more.
 *
 * - **empty** — folder dropdown (which repository), branch (a real checkout),
 *   run location. The branch column appears only once a repository is selected,
 *   because until then there is no checkout to talk about.
 * - **session** — the repository is a locked label (the binding is made; moving
 *   it is a FORK, which the sidebar and the empty-state card own), the branch of
 *   the checkout the conversation is really in, and run location.
 */
export function ComposerTargetBar({
  mode,
  sending,
  disabled,
  onAddRepository,
}: ComposerTargetBarProps) {
  const { t } = useI18n();
  const { target, folderMenu, blocked, runLocation, selectTarget, createTempTarget } =
    useComposerTarget({ sending, disabled });

  // The branch column needs the whole session list — it locks when a PEER is
  // running in the same checkout — and the repository column needs the project
  // list. Neither is exposed by `useComposerTarget`, and calling it a second
  // time would duplicate its pending-target effects and its query, so these come
  // straight off the store.
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const projects = useChatSessionsStore((state) => state.projects);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);

  const hasTargetableWorkspace = Boolean(
    target.workspace && isTargetableWorkspace(target.workspace)
  );

  const repoColumn = buildRepoColumn({
    projects,
    workspaces,
    activeWorkspaceId: target.workspace?.id ?? null,
    mode,
  });

  const branchColumn = buildBranchColumn({
    sessions,
    workspaces,
    activeSessionId,
    // Empty mode has no session, so the checkout to switch is the one the
    // conversation would land on: the repository column's current entry.
    fallbackWorkspaceId: repoColumn.entries.find((entry) => entry.current)?.workspaceId ?? null,
    sending,
  });

  if (
    !shouldRenderTargetRow({
      mode,
      hasTargetableWorkspace,
      // The row's own reason to exist in session mode: a checkout to switch.
      showBranchSelect: branchColumn.workdir !== null,
      hasRunLocation: Boolean(runLocation),
    })
  ) {
    return null;
  }

  const slots = targetRowSlots(mode);
  const blockedReason = blocked
    ? t('Session is running — stop it before changing the target')
    : undefined;

  return (
    <div className={targetRowClass(mode)}>
      {/* Column 1 — repository. A dropdown in empty mode (pick where this
          conversation starts), a locked label in session mode. */}
      {slots.folder && target.workspace && (
        <TargetFolderSelect
          folderMenu={folderMenu}
          activeWorkspaceId={target.workspace.id}
          currentLabel={target.project?.name ?? target.workspace.name}
          // T-30b2 §4.8 compensation: the only remaining route to the full
          // target path now that the empty card's resting status line is gone.
          workspacePath={target.workspace.path}
          disabled={blocked}
          disabledReason={blockedReason}
          onSelect={selectTarget}
          onAddRepository={onAddRepository}
          onCreateTempTarget={createTempTarget}
        />
      )}
      {mode === 'session' && repoColumn.currentLabel && (
        <LockedRepoLabel
          label={repoColumn.currentLabel}
          path={repoColumn.currentPath}
          reason={t('This conversation is bound to its repository — start a new chat to change it')}
        />
      )}

      {/* Column 2 — branch. The only control here that mutates the repository. */}
      {slots.branch && <BranchColumn column={branchColumn} disabled={disabled} />}

      {/* Column 3 — run location. Read-only, and says so. */}
      {slots.runLocation && runLocation && (
        <RunLocationIndicator text={t(runLocation.text)} tone={runLocation.tone} />
      )}
    </div>
  );
}
