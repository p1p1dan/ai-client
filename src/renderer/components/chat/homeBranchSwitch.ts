import type { QueryClient } from '@tanstack/react-query';
import { invalidateBranchQueries } from '@/hooks/useGit';
import type { HomeBranchPlan } from './homeTarget';

/**
 * Decision 174 (issue #6, user ruling 2026-10-10): the home send switches to
 * the branch picked on the home page just before it makes the conversation.
 *
 * The chat tree's second — and only other — place that runs a checkout, after
 * `BranchColumn`. It takes a `switch` plan, which only `planHomeBranchSwitch`
 * produces, and only when the branch column's two locks are off — the same
 * locks `BranchColumn` applies. 「创建新分支...」 picked on the home page is
 * created here (`createBranch` checks it out as it creates it).
 *
 * The refresh is not awaited: the branch the screen shows comes from the
 * worktree list, and the send must not wait on that read.
 */
export async function runHomeBranchSwitch(
  plan: Extract<HomeBranchPlan, { kind: 'switch' }>,
  queryClient: QueryClient | undefined
): Promise<void> {
  if (plan.create) {
    await window.electronAPI.git.createBranch(plan.workdir, plan.branch);
  } else {
    await window.electronAPI.git.checkout(plan.workdir, plan.branch);
  }
  if (queryClient) void invalidateBranchQueries(queryClient, plan.workdir);
}
