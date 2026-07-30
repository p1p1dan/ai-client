import { useI18n } from '@/i18n';
import { isTargetableWorkspace } from './composerTarget';
import { RunLocationIndicator } from './RunLocationIndicator';
import { TargetBranchSelect } from './TargetBranchSelect';
import { TargetFolderSelect } from './TargetFolderSelect';
import { useComposerTarget } from './useComposerTarget';

interface ComposerTargetBarProps {
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
 */
export function ComposerTargetBar({ sending, disabled, onAddRepository }: ComposerTargetBarProps) {
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

  // No assigned target (fresh demo tree with an empty path) — no fake controls.
  if (!target.workspace || !isTargetableWorkspace(target.workspace)) {
    return null;
  }

  const blockedReason = blocked
    ? t('Session is running — stop it before changing the target')
    : undefined;

  return (
    <div className="mb-2 flex h-6 items-center gap-1">
      <TargetFolderSelect
        folderMenu={folderMenu}
        activeWorkspaceId={target.workspace.id}
        currentLabel={target.project?.name ?? target.workspace.name}
        disabled={blocked}
        disabledReason={blockedReason}
        onSelect={selectTarget}
        onAddRepository={onAddRepository}
        onCreateTempTarget={createTempTarget}
      />
      {showBranchSelect && (
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
      {runLocation && <RunLocationIndicator text={t(runLocation.text)} tone={runLocation.tone} />}
    </div>
  );
}
