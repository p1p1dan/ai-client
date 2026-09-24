import { Loader2, Lock } from 'lucide-react';
import { useState } from 'react';
import { BranchSwitcher } from '@/components/source-control/BranchSwitcher';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useGitBranches, useGitCheckout, useGitCreateBranch } from '@/hooks/useGit';
import { useI18n } from '@/i18n';
import type { BranchColumnModel } from './composerColumns';

interface BranchColumnProps {
  column: BranchColumnModel;
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * The branch column — the ONE control in the composer row that mutates the
 * repository.
 *
 * It replaces the old worktree dropdown (`TargetBranchSelect`), which listed
 * workspaces but labelled them with branch names and drew a branch icon, and
 * whose selection re-pointed the SESSION rather than running `git checkout`.
 * Nothing in the app could switch branches from the composer; a repository with
 * no worktrees showed one entry that appeared to do nothing.
 *
 * Renders nothing when there is no checkout to talk about — empty mode before a
 * repository is picked (user ruling 2026-09-24: 「第一列的 workspace 选择后，才
 * 显示 git 分支」), and any workspace with no usable path. A disabled branch chip
 * with no name would be worse than no chip.
 *
 * The error line is part of this component on purpose. A checkout is refused by
 * git whenever local changes would be clobbered, and without a rendered error
 * that is indistinguishable from "the click did nothing" — which is exactly the
 * defect the previous `StatusBar` shipped (it declared the error state, wrote to
 * it, and never drew it).
 */
export function BranchColumn({ column, disabled, disabledReason }: BranchColumnProps) {
  const { t } = useI18n();
  const branches = useGitBranches(column.workdir, { skipMerged: true });
  const checkout = useGitCheckout();
  const createBranch = useGitCreateBranch();
  const [error, setError] = useState<string | null>(null);

  if (!column.workdir) return null;

  const isCheckingOut = checkout.isPending || createBranch.isPending;
  const locked = column.lock !== null;
  const lockReason =
    column.lock === 'session-running'
      ? t('This conversation is running — stop it before switching branches')
      : column.lock === 'checkout-busy'
        ? t('Another conversation is running in this checkout — stop it before switching branches')
        : disabledReason;

  return (
    <span className="flex min-w-0 items-center gap-1">
      <BranchSwitcher
        currentBranch={column.currentBranch}
        branches={branches.data}
        size="xs"
        isLoading={branches.isPending}
        isCheckingOut={isCheckingOut}
        disabled={disabled || locked}
        onOpen={() => {
          setError(null);
          void branches.refetch();
        }}
        onCheckout={(branch) => {
          setError(null);
          const workdir = column.workdir;
          if (!workdir) return;
          checkout.mutate(
            { workdir, branch },
            {
              onError: (cause) => setError(`${t('Failed to switch branch')}: ${cause.message}`),
            }
          );
        }}
        onCreateBranch={async (name) => {
          setError(null);
          const workdir = column.workdir;
          if (!workdir) return;
          try {
            await createBranch.mutateAsync({ workdir, name });
          } catch (cause) {
            setError(
              `${t('Failed to create branch')}: ${
                cause instanceof Error ? cause.message : String(cause)
              }`
            );
            // BranchSwitcher keeps the draft open when creation fails.
            throw cause;
          }
        }}
      />

      {/* The lock is stated, not silently applied: a disabled control with no
          reason reads as a bug. */}
      {locked && lockReason && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="status"
                aria-label={lockReason}
                className="inline-flex size-6 shrink-0 cursor-default items-center justify-center text-muted-foreground"
              />
            }
          >
            <Lock className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup className="max-w-66">{lockReason}</TooltipPopup>
        </Tooltip>
      )}

      {isCheckingOut && (
        <Loader2
          className="size-3.5 shrink-0 animate-spin text-muted-foreground"
          aria-label={t('Switching branch')}
        />
      )}

      {error && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="alert"
                className="inline-flex min-w-0 max-w-48 items-center text-ui text-destructive"
              />
            }
          >
            <span className="truncate">{error}</span>
          </TooltipTrigger>
          <TooltipPopup className="max-w-80">{error}</TooltipPopup>
        </Tooltip>
      )}
    </span>
  );
}
