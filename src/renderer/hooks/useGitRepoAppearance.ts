/**
 * dsh-rebase decision 146 (GW-8): notice a folder becoming a Git repository
 * while the Git panel is looking at it.
 *
 * Whether a workspace is a repository is a cached answer (`folder:checkType`,
 * an `existsSync(<dir>/.git)` probe; `useSyncChatWorkspaceTree.ts`'s
 * `useGitRepoByPath`). Nothing re-asked it after a `git init` in an open
 * workspace, so the panel kept saying 「不是 Git 仓库」 until the window lost
 * and regained focus (React Query's refetch-on-focus).
 *
 * While the panel is the visible surface AND shows that verdict, this re-asks
 * the same cached question on the panel's own polling terms (every 5 s, only
 * while the window is not idle — `useGitHeadSignature.ts`'s cadence). It reads
 * through the very key the tree derivation reads, so a "yes" lands in the
 * tree with no second source of truth; it then refreshes that repository's
 * worktree list, whose earlier failure is still cached, so the branch shows
 * too. It stops as soon as the verdict changes (the caller passes no path) or
 * the panel is hidden. Deliberately not a `.git/` filesystem watcher, for the
 * reason `useGitHeadSignature.ts` gives: no new main-process lifecycle.
 */
import { canonicalPathKey } from '@shared/utils/path';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { gitRepoQueryKey } from './gitRepoQueryKey';
import { useShouldPoll } from './useWindowFocus';

/** Same cadence as the panel's other polls (`useGitHeadSignature.ts`, `useSourceControl.ts`). */
export const GIT_REPO_RECHECK_MS = 5000;

/** `useWorktreeListMultiple`'s key prefix; its third segment is the repository path as registered. */
const WORKTREE_LIST_PREFIX = ['worktree', 'listMultiple'] as const;

/**
 * @param path the folder the panel judged "not a Git repository", or `null`
 *   when it shows anything else.
 * @param active the Git panel is the visible surface.
 */
export function useGitRepoAppearanceWatch(path: string | null, active: boolean): void {
  const queryClient = useQueryClient();
  const shouldPoll = useShouldPoll();
  const watching = path !== null && active;

  const query = useQuery({
    queryKey: path ? gitRepoQueryKey(path) : ['folder', 'isGitRepo', null],
    queryFn: async (): Promise<boolean> =>
      path ? window.electronAPI.folder.checkType(path) : false,
    enabled: watching,
    retry: false,
    refetchInterval: watching && shouldPoll ? GIT_REPO_RECHECK_MS : false,
    refetchIntervalInBackground: false,
  });

  const isRepo = watching && query.data === true;
  useEffect(() => {
    if (!isRepo || !path) return;
    const key = canonicalPathKey(path);
    void queryClient.invalidateQueries({
      predicate: (candidate) =>
        candidate.queryKey[0] === WORKTREE_LIST_PREFIX[0] &&
        candidate.queryKey[1] === WORKTREE_LIST_PREFIX[1] &&
        typeof candidate.queryKey[2] === 'string' &&
        canonicalPathKey(candidate.queryKey[2]) === key,
    });
  }, [isRepo, path, queryClient]);
}
