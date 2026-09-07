import { useState } from 'react';
import { BranchSwitcher } from '@/components/source-control/BranchSwitcher';
import { useGitBranches, useGitCheckout, useGitCreateBranch } from '@/hooks/useGit';
import { useI18n } from '@/i18n';

export function GitBranchControl({
  workdir,
  currentBranch,
}: {
  workdir: string;
  currentBranch: string | null;
}) {
  const { t } = useI18n();
  const branches = useGitBranches(workdir);
  const checkout = useGitCheckout();
  const createBranch = useGitCreateBranch();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="shrink-0 border-b px-2 py-1">
      <BranchSwitcher
        currentBranch={currentBranch}
        branches={branches.data}
        size="sm"
        isLoading={branches.isPending}
        isCheckingOut={checkout.isPending || createBranch.isPending}
        onOpen={() => void branches.refetch()}
        onCheckout={(branch) => {
          setError(null);
          checkout.mutate(
            { workdir, branch },
            {
              onError: (cause) => setError(`${t('Failed to switch branch')}: ${cause.message}`),
            }
          );
        }}
        onCreateBranch={async (name) => {
          setError(null);
          try {
            await createBranch.mutateAsync({ workdir, name });
          } catch (cause) {
            setError(
              `${t('Failed to create branch')}: ${cause instanceof Error ? cause.message : String(cause)}`
            );
            // BranchSwitcher keeps the draft open when creation fails.
            throw cause;
          }
        }}
      />
      {(error || branches.error) && (
        <p role="alert" className="mt-1 break-words text-meta text-destructive">
          {error || branches.error?.message}
        </p>
      )}
    </div>
  );
}
