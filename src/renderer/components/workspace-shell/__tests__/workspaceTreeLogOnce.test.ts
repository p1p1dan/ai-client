// @vitest-environment happy-dom
/**
 * dsh-rebase decision 146 (GW-8): while a registered folder is not a Git
 * repository, `[workspace-tree] worktree query failed` and
 * `[workspace-tree] worktrees-absent` used to be written on every render —
 * hundreds of lines in the real-gateway pass's dev.log — because
 * `useWorktreeListMultiple` rebuilds its maps on each render. They are now
 * written once per distinct content.
 *
 * Mounted for real: `useSyncChatWorkspaceTree` with the worktree hook stubbed
 * to do exactly what the real one does to its outputs (fresh objects, same
 * content, every call), and `folder:checkType` answering "no".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const probe = vi.hoisted(() => ({ error: 'fatal: not a git repository' }));

vi.mock('@/utils/logging', () => ({ updateRendererLogging: () => {} }));
vi.mock('@/hooks/useWorktree', () => ({
  useWorktreeListMultiple: (paths: string[]) => ({
    worktreesMap: {},
    errorsMap: Object.fromEntries(paths.map((path) => [path, probe.error])),
    loadingMap: {},
    isLoading: false,
    refetchAll: () => undefined,
  }),
}));

import { useSyncChatWorkspaceTree } from '../useSyncChatWorkspaceTree';

const REPOS = [{ id: 'r1', name: 'fresh', path: '/work/fresh' }];

function Harness(_props: { tick: number }) {
  useSyncChatWorkspaceTree({
    repositories: REPOS,
    selectedRepoPath: '/work/fresh',
    temporaryWorkspaceEnabled: false,
  });
  return null;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let errorSpy: MockInstance<typeof console.error>;

async function renderTimes(from: number, count: number): Promise<void> {
  for (let tick = from; tick < from + count; tick += 1) {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Harness, { tick })));
    });
  }
}

function logged(kind: string): number {
  return errorSpy.mock.calls.filter((args) =>
    kind === 'worktree query failed'
      ? args[0] === '[workspace-tree] worktree query failed'
      : args[0] === '[workspace-tree]' && args[1] === kind
  ).length;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electronAPI', {
    folder: { checkType: async () => false },
    chat: { closeSession: async () => undefined },
  });
  probe.error = 'fatal: not a git repository';
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  errorSpy.mockRestore();
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe('the workspace tree logs a failure once per content (decision 146)', () => {
  it('[GW8-LOG-ONCE] ten renders of the same failure write each line once', async () => {
    await renderTimes(0, 10);
    expect(logged('worktree query failed')).toBe(1);
    expect(logged('worktrees-absent')).toBe(1);
  });

  it('[GW8-LOG-CHANGE] a different failure is written again, once', async () => {
    await renderTimes(0, 3);
    probe.error = 'fatal: unsafe repository';
    await renderTimes(3, 5);
    expect(logged('worktree query failed')).toBe(2);
    // The tree's own diagnostic did not change, so it is not repeated.
    expect(logged('worktrees-absent')).toBe(1);
  });
});
