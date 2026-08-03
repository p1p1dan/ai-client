import { useI18n } from '@/i18n';
import { isTargetableWorkspace } from './composerTarget';
import type { MiddleColumnMode } from './middleColumnLayout';
import { shouldRenderTargetRow, targetRowClass, targetRowSlots } from './middleColumnLayout';
import { RunLocationIndicator } from './RunLocationIndicator';
import { TargetBranchSelect } from './TargetBranchSelect';
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
 * T-27: the target bar — folder / branch / run location rows, plus the
 * folder dropdown's footer actions (Use Existing…/Clone…/Add Remote…/New
 * Folder) and the branch dropdown's New worktree… wiring (batch 3).
 *
 * T-28: `mode` picks the row's position (above the card in empty mode, below
 * it in session mode — ChatComposer renders the same instance in one spot or
 * the other, never both) and which slots show. The branch dropdown keeps its
 * full New worktree… wiring in both modes (D23 decision 6) — only the folder
 * slot is mode-gated.
 */
export function ComposerTargetBar({
  mode,
  sending,
  disabled,
  onAddRepository,
}: ComposerTargetBarProps) {
  const { t } = useI18n();
  const {
    target,
    folderMenu,
    branchMenu,
    blocked,
    showBranchSelect,
    branchLabel,
    runLocation,
    selectTarget,
    createTempTarget,
    awaitWorkspaceAtPath,
    worktreeRepoPath,
    worktreeProjectName,
  } = useComposerTarget({ sending, disabled });

  const hasTargetableWorkspace = Boolean(
    target.workspace && isTargetableWorkspace(target.workspace)
  );
  if (
    !shouldRenderTargetRow({
      mode,
      hasTargetableWorkspace,
      showBranchSelect,
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
      {slots.branch && showBranchSelect && target.workspace && (
        <TargetBranchSelect
          branchMenu={branchMenu}
          activeWorkspaceId={target.workspace.id}
          currentLabel={branchLabel ?? target.workspace.name}
          disabled={blocked}
          disabledReason={blockedReason}
          onSelect={selectTarget}
          worktreeRepoPath={worktreeRepoPath}
          worktreeProjectName={worktreeProjectName}
          awaitWorkspaceAtPath={awaitWorkspaceAtPath}
        />
      )}
      {slots.runLocation && runLocation && (
        <RunLocationIndicator text={t(runLocation.text)} tone={runLocation.tone} />
      )}
    </div>
  );
}
