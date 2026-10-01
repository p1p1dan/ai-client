// @vitest-environment happy-dom
/**
 * dsh-rebase decision 146 (GW-8): after `git init` in an open workspace, the
 * Git panel kept saying 「不是 Git 仓库」 until the window regained focus.
 *
 * Pinned here, against a real QueryClient:
 *  - while the panel is visible and shows that verdict, the cached answer is
 *    re-asked every 5 s, through the key the workspace tree reads — so the
 *    tree's own observer sees the "yes" without a second source of truth;
 *  - the repository's failed worktree list is fetched again once it is one;
 *  - a hidden panel, or one that shows anything else, asks nothing.
 */
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitRepoQueryKey } from '../gitRepoQueryKey';
import { GIT_REPO_RECHECK_MS, useGitRepoAppearanceWatch } from '../useGitRepoAppearance';

const REPO = '/work/fresh';

const checkType = vi.fn<(path: string) => Promise<boolean>>();
const listWorktrees = vi.fn<(path: string) => Promise<unknown[]>>();

/** What the workspace tree reads: the same two queries `useSyncChatWorkspaceTree` keeps. */
const tree = { isRepo: undefined as boolean | undefined };

function TreeProbe() {
  const repo = useQuery({
    queryKey: gitRepoQueryKey(REPO),
    queryFn: () => window.electronAPI.folder.checkType(REPO),
    retry: false,
    staleTime: 30_000,
  });
  useQuery({
    queryKey: ['worktree', 'listMultiple', REPO],
    queryFn: () => listWorktrees(REPO),
    retry: false,
    staleTime: 30_000,
  });
  tree.isRepo = repo.data;
  return null;
}

function WatchProbe({ path, active }: { path: string | null; active: boolean }) {
  useGitRepoAppearanceWatch(path, active);
  return null;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function render(path: string | null, active: boolean): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TreeProbe),
        createElement(WatchProbe, { path, active })
      )
    );
  });
  await tick(0);
}

/**
 * Advance the clock, then let React Query's out-of-band notifications (and
 * the effects they cause) land: they are scheduled a timer later.
 */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electronAPI', { folder: { checkType } });
  checkType.mockReset().mockResolvedValue(false);
  listWorktrees.mockReset().mockRejectedValue(new Error('fatal: not a git repository'));
  tree.isRepo = undefined;
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the Git panel notices a folder becoming a repository (decision 146)', () => {
  it('[GW8-POLL] re-asks while visible and "not a repo"; a yes reaches the tree and its worktree list', async () => {
    await render(REPO, true);
    expect(tree.isRepo).toBe(false);
    const asked = checkType.mock.calls.length;
    const listed = listWorktrees.mock.calls.length;

    await tick(GIT_REPO_RECHECK_MS);
    expect(checkType.mock.calls.length).toBe(asked + 1);
    expect(listWorktrees.mock.calls.length).toBe(listed);

    // `git init` happens.
    checkType.mockResolvedValue(true);
    listWorktrees.mockResolvedValue([{ path: REPO, isMainWorktree: true, branch: 'main' }]);
    await tick(GIT_REPO_RECHECK_MS);
    expect(tree.isRepo).toBe(true);
    expect(listWorktrees.mock.calls.length).toBe(listed + 1);
    expect(checkType).toHaveBeenLastCalledWith(REPO);
  });

  it('[GW8-HIDDEN] asks nothing while the panel is hidden', async () => {
    await render(REPO, false);
    const asked = checkType.mock.calls.length;
    await tick(GIT_REPO_RECHECK_MS * 4);
    expect(checkType.mock.calls.length).toBe(asked);
  });

  it('[GW8-STOP] stops once the panel shows something else', async () => {
    await render(REPO, true);
    await tick(GIT_REPO_RECHECK_MS);
    // The verdict changed (or the session moved to a repository): no path.
    await render(null, true);
    const asked = checkType.mock.calls.length;
    await tick(GIT_REPO_RECHECK_MS * 4);
    expect(checkType.mock.calls.length).toBe(asked);
  });
});
