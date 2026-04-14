import type { GitWorktree } from '@shared/types';
import { normalizePath, pathsEqual } from '@/App/storage';

export function normalizeComparablePath(path: string): string {
  return normalizePath(path).replace(/\\/g, '/');
}

export function pathsEqualIncludingSlashes(path1: string, path2: string): boolean {
  return pathsEqual(path1, path2) || normalizeComparablePath(path1) === normalizeComparablePath(path2);
}

export function worktreeListBelongsToRepo(worktrees: GitWorktree[], selectedRepo: string): boolean {
  const normalizedRepoPath = normalizeComparablePath(selectedRepo);
  return worktrees.some((wt) => {
    const normalizedWorktreePath = normalizeComparablePath(wt.path);
    return (
      normalizedWorktreePath === normalizedRepoPath ||
      normalizedWorktreePath.startsWith(`${normalizedRepoPath}/`)
    );
  });
}

