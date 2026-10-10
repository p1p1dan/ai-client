import { useI18n } from '@/i18n';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useHomeDraftStore } from '@/stores/homeDraft';
import { BranchColumn, type BranchColumnDraft } from './BranchColumn';
import { buildBranchColumn, buildRepoColumn } from './composerColumns';
import { isTargetableWorkspace } from './composerTarget';
import { LockedRepoLabel, TemporaryChatLabel } from './LockedRepoLabel';
import type { MiddleColumnMode } from './middleColumnLayout';
import { shouldRenderTargetRow, targetRowClass, targetRowSlots } from './middleColumnLayout';
import { RunLocationIndicator } from './RunLocationIndicator';
import { TargetFolderSelect } from './TargetFolderSelect';
import { useComposerTarget } from './useComposerTarget';
import { useHomeTarget } from './useHomeTarget';

interface ComposerTargetBarProps {
  /** T-28: empty mode keeps the folder slot; session mode drops it (§3.6). */
  mode: MiddleColumnMode;
  /**
   * ChatComposer's `sending` — an in-flight send blocks target changes too. On
   * the home page it is the home send's own pre-send step (the branch switch).
   */
  sending: boolean;
  disabled?: boolean;
  /** Opens the shared AddRepositoryDialog (owned by App); the 「添加仓库」 rows don't render without it. */
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
 * - **home** (decision 174, issue #6: no conversation open) — the folder
 *   dropdown picks where the NEXT conversation is made, and is always there,
 *   with no repository too (「未选仓库」, and the menu's 「添加仓库」 rows);
 *   the branch is the branch that conversation will start on, switched to by
 *   its send; run location. Picking makes nothing.
 * - **session** — the repository is a locked label (the binding is made; moving
 *   it is a FORK), or 「临时对话」 for a conversation with no repository; the
 *   branch of the checkout the conversation is really in; run location. The row
 *   is always drawn (decision 174), so every conversation's card sits at the
 *   same height.
 * - **empty** — a blank conversation's start screen: folder dropdown (retargets
 *   it in place), branch (a real checkout), run location. No "new chat" entry
 *   makes such a conversation any more; the form stays for one that exists.
 */
export function ComposerTargetBar({
  mode,
  sending,
  disabled,
  onAddRepository,
}: ComposerTargetBarProps) {
  const { t } = useI18n();
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const onHome = activeSessionId === null;
  const home = useHomeTarget();
  const {
    target,
    folderMenu,
    blocked,
    runLocation,
    selectTarget,
    selectUnbound,
    createTempTarget,
  } = useComposerTarget({ sending, disabled, home: onHome ? home.target : null });

  // The branch column needs the whole session list — it locks when a PEER is
  // running in the same checkout — and the repository column needs the project
  // list. Neither is exposed by `useComposerTarget`, and calling it a second
  // time would duplicate its pending-target effects and its query, so these come
  // straight off the store.
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const projects = useChatSessionsStore((state) => state.projects);

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
    // Without a session checkout, switch the one the conversation will start
    // in: the target itself. The repository column's entry is the repository
    // DEFAULT (prefers `main`), which is a different directory whenever the
    // target is a worktree.
    fallbackWorkspaceId: target.workspace?.id ?? null,
    // On the home page `sending` is the home send's own branch switch, which
    // the draft chip shows as its spinner; it is not "this conversation is
    // running" (decision 174).
    sending: onHome ? false : sending,
  });

  if (!shouldRenderTargetRow({ mode, hasTargetableWorkspace })) {
    return null;
  }

  const slots = targetRowSlots(mode, { home: onHome });
  const blockedReason = blocked
    ? t('Session is running — stop it before changing the target')
    : undefined;

  const activeSession = onHome
    ? undefined
    : sessions.find((session) => session.id === activeSessionId);
  // Decision 174: a conversation with no repository says so where the
  // repository would be, instead of leaving the column empty.
  const temporaryChat =
    mode === 'session' &&
    activeSession !== undefined &&
    (activeSession.unbound != null || activeSession.workspaceId.trim() === '');

  const homeWorkspace = onHome ? target.workspace : undefined;
  const branchDraft: BranchColumnDraft | undefined = homeWorkspace
    ? {
        repositoryName: home.target.repositoryName ?? homeWorkspace.name,
        branch: home.draftBranch?.name ?? null,
        onPick: (branch) =>
          useHomeDraftStore
            .getState()
            .setBranch(
              branch === homeWorkspace.branch
                ? null
                : { workdir: homeWorkspace.path, name: branch, create: false }
            ),
        onCreate: (name) =>
          useHomeDraftStore
            .getState()
            .setBranch({ workdir: homeWorkspace.path, name, create: true }),
        switching: sending,
      }
    : undefined;

  return (
    <div className={targetRowClass(mode)}>
      {/* Column 1 — repository. A dropdown on the home page (where the next
          conversation is made) and on a blank conversation's start screen; a
          locked label — or 「临时对话」 — in a conversation. */}
      {slots.folder && (onHome || target.workspace) && (
        <TargetFolderSelect
          folderMenu={folderMenu}
          activeWorkspaceId={target.workspace?.id ?? null}
          currentLabel={target.workspace ? (target.project?.name ?? target.workspace.name) : null}
          // T-30b2 §4.8 compensation: the only remaining route to the full
          // target path now that the empty card's resting status line is gone.
          workspacePath={target.workspace?.path ?? null}
          unboundSelected={onHome && !target.workspace}
          disabled={blocked}
          disabledReason={blockedReason}
          onSelect={selectTarget}
          onSelectUnbound={selectUnbound}
          onAddRepository={onAddRepository}
          onCreateTempTarget={createTempTarget}
        />
      )}
      {mode === 'session' && !onHome && repoColumn.currentLabel && (
        <LockedRepoLabel
          label={repoColumn.currentLabel}
          path={repoColumn.currentPath}
          reason={t('This conversation is bound to its repository — start a new chat to change it')}
        />
      )}
      {temporaryChat && <TemporaryChatLabel />}

      {/* Column 2 — branch. The only control here that mutates the repository;
          on the home page it records the branch for the send to switch to. */}
      {slots.branch && (
        <BranchColumn column={branchColumn} disabled={disabled} draft={branchDraft} />
      )}

      {/* Column 3 — run location. Read-only, and says so. */}
      {slots.runLocation && runLocation && (
        <RunLocationIndicator text={t(runLocation.text)} tone={runLocation.tone} />
      )}
    </div>
  );
}
