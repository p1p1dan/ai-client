// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitQueryKeys } from '../gitQueryKeys';
import { useGitCheckout, useGitCreateBranch } from '../useGit';

vi.mock('@/stores/settings', () => ({ useSettingsStore: vi.fn() }));
vi.mock('../useWindowFocus', () => ({ useShouldPoll: () => false }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let checkout: ReturnType<typeof useGitCheckout>;
let createBranch: ReturnType<typeof useGitCreateBranch>;
const checkoutIpc = vi.fn().mockResolvedValue(undefined);
const createIpc = vi.fn().mockResolvedValue(undefined);

function Probe() {
  checkout = useGitCheckout();
  createBranch = useGitCreateBranch();
  return null;
}

const affectedKeys = [
  gitQueryKeys.status('/repo'),
  gitQueryKeys.branches('/repo'),
  gitQueryKeys.fileChanges('/repo'),
  gitQueryKeys.fileDiff('/repo'),
  gitQueryKeys.log('/repo', 30),
  gitQueryKeys.logInfinite('/repo'),
  gitQueryKeys.submodules('/repo'),
  gitQueryKeys.submoduleChanges('/repo'),
];

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electronAPI', { git: { checkout: checkoutIpc, createBranch: createIpc } });
  checkoutIpc.mockReset().mockResolvedValue(undefined);
  createIpc.mockReset().mockResolvedValue(undefined);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  for (const key of affectedKeys) client.setQueryData(key, []);
  client.setQueryData(gitQueryKeys.status('/other'), []);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe)))
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe('branch mutations refresh the active workspace', () => {
  it.each([
    'local-topic',
    'remotes/origin/topic',
  ])('checks out %s and invalidates status, changes and history', async (branch) => {
    await act(async () => {
      await checkout.mutateAsync({ workdir: '/repo', branch });
    });
    expect(checkoutIpc).toHaveBeenCalledExactlyOnceWith('/repo', branch);
    for (const key of affectedKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryState(gitQueryKeys.status('/other'))?.isInvalidated).toBe(false);
  });

  it('refreshes the same data after branch creation without issuing a second checkout', async () => {
    await act(async () => {
      await createBranch.mutateAsync({ workdir: '/repo', name: 'new-topic' });
    });
    expect(createIpc).toHaveBeenCalledExactlyOnceWith('/repo', 'new-topic', undefined);
    expect(checkoutIpc).not.toHaveBeenCalled();
    for (const key of affectedKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it('keeps cached data valid when checkout is rejected', async () => {
    checkoutIpc.mockRejectedValueOnce(new Error('local changes would be overwritten'));
    await act(async () => {
      await expect(checkout.mutateAsync({ workdir: '/repo', branch: 'topic' })).rejects.toThrow(
        'local changes'
      );
    });
    for (const key of affectedKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  });
});
