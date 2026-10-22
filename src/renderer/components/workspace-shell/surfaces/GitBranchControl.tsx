import { useState } from 'react';
import { BranchSwitcher } from '@/components/source-control/BranchSwitcher';
import { useGitBranches, useGitCheckout, useGitCreateBranch } from '@/hooks/useGit';
import { useI18n } from '@/i18n';
import { PaneHeaderPortal, usePaneHeaderSlots } from '../panes/paneSlots';

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

  // Layout 5d: in a pane card the branch is the header's context (the
  // reference's `master → branch ▾`), not a row of its own.
  const inPane = usePaneHeaderSlots() !== null;
  const switcher = (
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
  );
  const failure = (error || branches.error) && (
    <p role="alert" className="mt-1 break-words text-small text-destructive">
      {error || branches.error?.message}
    </p>
  );
  if (inPane) {
    return (
      <>
        <PaneHeaderPortal slot="context">{switcher}</PaneHeaderPortal>
        {failure && <div className="shrink-0 px-3 pb-1">{failure}</div>}
      </>
    );
  }
  return (
    <div className="shrink-0 border-b px-2 py-1">
      {switcher}
      {failure}
    </div>
  );
}
