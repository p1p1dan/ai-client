// @vitest-environment happy-dom
/**
 * Decision 162: the composer's branch chip takes its name from the workspace
 * tree's worktree list. When that list could not be read (the encrypted host
 * losing git's output on both paths) the chip said 「选择分支」 and nothing
 * else, as if the checkout had no branch. It now says the read failed, from
 * the tree's own query, without reading anything itself.
 *
 * The `electronAPI` stub is hoisted because persisted stores rehydrate at import.
 */
import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => {
  const worktree = { list: vi.fn(async (_repoPath: string): Promise<unknown[]> => []) };
  const git = { getBranches: vi.fn(async () => []) };
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    worktree,
    git,
  } as unknown as typeof window.electronAPI;
  return { worktree, git };
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));

const { BranchColumn } = await import('../BranchColumn');

const REPO = '/work/repo';
const LIST_FAILURE = new Error(
  "Error invoking remote method 'worktree:list': GitOutputLostError: git worktree via the node runner exited 0 without the output it always prints; its output was lost"
);

let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;

async function failTreeList(): Promise<void> {
  // The workspace tree's query (`useWorktreeListMultiple`), left in its error state.
  await client.prefetchQuery({
    queryKey: ['worktree', 'listMultiple', REPO],
    queryFn: () => Promise.reject(LIST_FAILURE),
    retry: false,
  });
}

async function render(currentBranch: string | null): Promise<void> {
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(BranchColumn, { column: { workdir: REPO, currentBranch, lock: null } })
      )
    );
  });
}

const readError = () => container.querySelector('[data-testid="branch-read-error"]');

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.worktree.list.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  client.clear();
  vi.unstubAllGlobals();
});

describe('BranchColumn when the worktree list could not be read', () => {
  it('says the current branch could not be read, beside 「选择分支」', async () => {
    await failTreeList();
    await render(null);

    expect(readError()?.textContent).toBe(
      'Could not read the current branch: git worktree via the node runner exited 0 without the output it always prints; its output was lost'
    );
    expect(container.textContent).toContain('Select branch');
  });

  it('observes the tree’s query without reading the list itself', async () => {
    await render(null);

    expect(readError()).toBeNull();
    expect(api.worktree.list).not.toHaveBeenCalled();
  });

  it('says nothing while a branch is known (a stale list still names one)', async () => {
    await failTreeList();
    await render('main');

    expect(readError()).toBeNull();
    expect(container.textContent).toContain('main');
  });
});
