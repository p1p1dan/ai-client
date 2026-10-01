import { canonicalPathKey } from '@shared/utils/path';

/**
 * The cached "is this folder a Git repository" answer (`folder:checkType`),
 * keyed by `canonicalPathKey` so two spellings of one directory share it.
 *
 * Read by the workspace tree (`useSyncChatWorkspaceTree.ts`) and re-asked by
 * the Git panel while it shows 「不是 Git 仓库」 (`useGitRepoAppearance.ts`,
 * decision 146). Its own module, free of DOM-reading imports, because the tree
 * hook's pure exports are tested in the node environment.
 */
export function gitRepoQueryKey(path: string): readonly unknown[] {
  return ['folder', 'isGitRepo', canonicalPathKey(path)];
}
