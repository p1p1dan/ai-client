import { Folder, Monitor } from 'lucide-react';
import { useState } from 'react';
import { BranchSwitcher } from '@/components/source-control/BranchSwitcher';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useGitBranches, useGitCheckout, useGitCreateBranch } from '@/hooks/useGit';
import { useI18n } from '@/i18n';

interface StatusBarProps {
  repoName: string | null;
  workdir: string | null;
  currentBranch: string | null;
}

export function StatusBar({ repoName, workdir, currentBranch }: StatusBarProps) {
  const { t } = useI18n();
  const branches = useGitBranches(workdir);
  const checkout = useGitCheckout();
  const createBranch = useGitCreateBranch();
  const [error, setError] = useState<string | null>(null);

  const isCheckingOut = checkout.isPending || createBranch.isPending;

  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t bg-card/60 px-3 text-xs text-muted-foreground">
      {repoName && (
        <Tooltip>
          <TooltipTrigger delay={400} render={<div className="flex items-center gap-1" />}>
            <span className="flex items-center gap-1">
              <Folder className="h-3 w-3 shrink-0" />
              <span className="truncate">{repoName}</span>
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">{repoName}</TooltipPopup>
        </Tooltip>
      )}

      <span className="flex items-center gap-1">
        <Monitor className="h-3 w-3 shrink-0" />
        <span>{t('Local')}</span>
      </span>

      <BranchSwitcher
        currentBranch={currentBranch}
        branches={branches.data}
        size="xs"
        isLoading={branches.isPending}
        isCheckingOut={isCheckingOut}
        onOpen={() => {
          setError(null);
          void branches.refetch();
        }}
        onCheckout={(branch) => {
          setError(null);
          checkout.mutate(
            { workdir: workdir!, branch },
            {
              onError: (cause) =>
                setError(`${t('Failed to switch branch')}: ${cause.message}`),
            }
          );
        }}
        onCreateBranch={async (name) => {
          setError(null);
          try {
            await createBranch.mutateAsync({ workdir: workdir!, name });
          } catch (cause) {
            setError(
              `${t('Failed to create branch')}: ${cause instanceof Error ? cause.message : String(cause)}`
            );
            throw cause;
          }
        }}
      />

      {branches.error && (
        <span className="text-destructive">{branches.error.message}</span>
      )}
    </div>
  );
}
