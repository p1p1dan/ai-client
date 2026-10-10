import { Loader2, Lock } from 'lucide-react';
import { useState } from 'react';
import { BranchSwitcher } from '@/components/source-control/BranchSwitcher';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useGitBranches, useGitCheckout, useGitCreateBranch } from '@/hooks/useGit';
import { useWorktreeListFailure } from '@/hooks/useWorktree';
import { useI18n } from '@/i18n';
import { unwrapIpcErrorMessage } from '@/lib/ipcError';
import type { BranchColumnModel } from './composerColumns';

/**
 * Decision 174 (issue #6, user ruling 2026-10-10): on the home page the branch
 * column records the branch the NEXT conversation should start on; the home
 * send checks it out (or creates it) just before it makes the conversation.
 * Nothing is switched while the user browses.
 */
export interface BranchColumnDraft {
  /** The repository's name, for the lock's sentence. */
  repositoryName: string;
  /** The branch picked for the send; `null` stays on the checkout's own branch. */
  branch: string | null;
  /** A branch from the list (the checkout's own branch clears the draft). */
  onPick: (branch: string) => void;
  /** 「创建新分支...」: the branch is created — and switched to — at send time. */
  onCreate: (name: string) => void;
  /** The send is switching to it right now (the trigger shows the spinner). */
  switching?: boolean;
}

interface BranchColumnProps {
  column: BranchColumnModel;
  disabled?: boolean;
  disabledReason?: string;
  /** Decision 174: present on the home page — picks become a draft. */
  draft?: BranchColumnDraft;
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
 * repository is picked (user ruling 2026-09-24: the git branch appears only
 * after the first column's workspace is chosen), and any workspace that is not
 * a local git checkout (see `buildBranchColumn`). A disabled branch chip with
 * no name would be worse than no chip.
 *
 * The error line is part of this component on purpose. A checkout is refused by
 * git whenever local changes would be clobbered, and without a rendered error
 * that is indistinguishable from "the click did nothing" — which is exactly the
 * defect the previous `StatusBar` shipped (it declared the error state, wrote to
 * it, and never drew it).
 *
 * The current branch comes from the workspace tree's worktree list. When that
 * list could not be read the chip has no name to show, and 「选择分支」 alone
 * read as "no branch" (decision 162): the same one-line error says so instead.
 *
 * Decision 174 (issue #6): on the home page (`draft`) nothing is switched here.
 * A pick is recorded for the next conversation and switched to by its send,
 * under the same two locks; see `homeTarget.ts`'s `planHomeBranchSwitch`.
 */
export function BranchColumn({ column, disabled, disabledReason, draft }: BranchColumnProps) {
  const { t } = useI18n();
  const branches = useGitBranches(column.workdir, { skipMerged: true });
  const checkout = useGitCheckout();
  const createBranch = useGitCreateBranch();
  const [error, setError] = useState<string | null>(null);
  // Only while there is no branch to show: a stale list still names one.
  const listFailure = useWorktreeListFailure(column.currentBranch ? null : column.workdir);
  const branchReadError = listFailure
    ? `${t('Could not read the current branch')}: ${unwrapIpcErrorMessage(listFailure)}`
    : null;

  if (!column.workdir) return null;

  const isCheckingOut = draft
    ? draft.switching === true
    : checkout.isPending || createBranch.isPending;
  const locked = column.lock !== null;
  // Decision 174: on the home page the lock is about the repository, not a
  // conversation the user is looking at — there is none — so it names it.
  const lockReason =
    column.lock === 'session-running'
      ? t('This conversation is running — stop it before switching branches')
      : column.lock === 'checkout-busy'
        ? draft
          ? t('{{repo}} has a chat running — the branch can be switched once it ends', {
              repo: draft.repositoryName,
            })
          : t(
              'Another conversation is running in this checkout — stop it before switching branches'
            )
        : disabledReason;

  return (
    <span className="flex min-w-0 items-center gap-1">
      <BranchSwitcher
        // Decision 174: the trigger and the check name the branch this send
        // will use; the green dot still marks the checkout's own branch.
        currentBranch={draft?.branch ?? column.currentBranch}
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
          if (draft) {
            draft.onPick(branch);
            return;
          }
          const workdir = column.workdir;
          if (!workdir) return;
          checkout.mutate(
            { workdir, branch },
            {
              // N6 (2026-09-24): Electron's `Error invoking remote method …`
              // wrapper filled the whole one-line chip; git's words go first.
              onError: (cause) =>
                setError(`${t('Failed to switch branch')}: ${unwrapIpcErrorMessage(cause)}`),
            }
          );
        }}
        onCreateBranch={async (name) => {
          setError(null);
          if (draft) {
            draft.onCreate(name);
            return;
          }
          const workdir = column.workdir;
          if (!workdir) return;
          try {
            await createBranch.mutateAsync({ workdir, name });
          } catch (cause) {
            setError(`${t('Failed to create branch')}: ${unwrapIpcErrorMessage(cause)}`);
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
          {/* Decision 174: 14px — the reason is CJK, and coss's popup is 12px. */}
          <TooltipPopup className="max-w-66 text-meta">{lockReason}</TooltipPopup>
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
                className="inline-flex min-w-0 max-w-80 items-center text-ui text-destructive"
              />
            }
          >
            <span className="truncate">{error}</span>
          </TooltipTrigger>
          <TooltipPopup className="max-w-80 whitespace-pre-wrap break-words">{error}</TooltipPopup>
        </Tooltip>
      )}

      {!error && branchReadError && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="status"
                data-testid="branch-read-error"
                className="inline-flex min-w-0 max-w-80 items-center text-ui text-destructive"
              />
            }
          >
            <span className="truncate">{branchReadError}</span>
          </TooltipTrigger>
          <TooltipPopup className="max-w-80 whitespace-pre-wrap break-words">
            {branchReadError}
          </TooltipPopup>
        </Tooltip>
      )}
    </span>
  );
}
