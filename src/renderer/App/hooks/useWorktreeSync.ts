import type { GitWorktree } from '@shared/types';
import { useEffect } from 'react';
import {
  pathsEqualIncludingSlashes,
  worktreeListBelongsToRepo,
} from './useWorktreeSync.utils';

export function useWorktreeSync(
  worktrees: GitWorktree[],
  activeWorktree: GitWorktree | null,
  worktreesFetching: boolean,
  setActiveWorktree: (worktree: GitWorktree | null) => void,
  selectedRepo: string | null
) {
  useEffect(() => {
    if (worktrees.length > 0 && activeWorktree) {
      if (!selectedRepo) {
        return;
      }

      if (!worktreeListBelongsToRepo(worktrees, selectedRepo)) {
        return;
      }

      const found = worktrees.find((wt) => pathsEqualIncludingSlashes(wt.path, activeWorktree.path));
      if (found && found !== activeWorktree) {
        setActiveWorktree(found);
      } else if (!found && !worktreesFetching) {
        setActiveWorktree(null);
      }
    }
  }, [worktrees, activeWorktree, worktreesFetching, setActiveWorktree, selectedRepo]);
}
