// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveRepositorySettings } from '@/App/storage';
import { useInitScriptStore } from '@/stores/initScript';
import { selectActiveSurfaceId, useShellLayoutStore } from '@/stores/shellLayout';
import { useWorktreeCreate } from '../useWorktree';

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let mutation: ReturnType<typeof useWorktreeCreate>;
const add = vi.fn();
const options = { path: '/repo/topic', branch: 'main', newBranch: 'topic' };

function Probe() {
  mutation = useWorktreeCreate();
  return null;
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electronAPI', { worktree: { add } });
  localStorage.clear();
  add.mockReset().mockResolvedValue(undefined);
  useInitScriptStore.getState().clearPendingScript();
  useShellLayoutStore.setState({ panes: [], paneFocus: [], setupTerminalOpened: false });
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
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

describe('new-shell worktree initialization', () => {
  it('keeps ordinary terminal navigation disabled', () => {
    useShellLayoutStore.getState().openSurface('terminal');
    expect(selectActiveSurfaceId(useShellLayoutStore.getState())).toBeNull();
    expect(useShellLayoutStore.getState().panes).toEqual([]);
  });
  it('queues the latest repository script for the new path and opens its terminal surface', async () => {
    saveRepositorySettings('/repo', {
      autoInitWorktree: true,
      initScript: 'old command',
      hidden: false,
    });
    saveRepositorySettings('/repo', {
      autoInitWorktree: true,
      initScript: 'pnpm install',
      hidden: false,
    });
    await act(async () => {
      await mutation.mutateAsync({ workdir: '/repo', options });
    });
    expect(add).toHaveBeenCalledExactlyOnceWith('/repo', options);
    expect(useInitScriptStore.getState().pendingScript).toEqual({
      worktreePath: options.path,
      script: 'pnpm install',
    });
    // Layout 5d: the setup pane hosts the init terminal.
    expect(selectActiveSurfaceId(useShellLayoutStore.getState())).toBe('terminal');
    expect(useShellLayoutStore.getState().panes).toContain('setup');
    expect(useShellLayoutStore.getState().setupTerminalOpened).toBe(true);
  });

  it.each([
    [false, 'pnpm install'],
    [true, '   '],
  ] as const)('does not schedule with enabled=%s and script=%s', async (autoInitWorktree, initScript) => {
    saveRepositorySettings('/repo', { autoInitWorktree, initScript, hidden: false });
    await act(async () => {
      await mutation.mutateAsync({ workdir: '/repo', options });
    });
    expect(useInitScriptStore.getState().pendingScript).toBeNull();
    expect(selectActiveSurfaceId(useShellLayoutStore.getState())).toBeNull();
  });

  it('never schedules initialization when creation fails', async () => {
    saveRepositorySettings('/repo', {
      autoInitWorktree: true,
      initScript: 'pnpm install',
      hidden: false,
    });
    add.mockRejectedValueOnce(new Error('branch already exists'));
    await act(async () => {
      await expect(mutation.mutateAsync({ workdir: '/repo', options })).rejects.toThrow(
        'branch already exists'
      );
    });
    expect(useInitScriptStore.getState().pendingScript).toBeNull();
    expect(selectActiveSurfaceId(useShellLayoutStore.getState())).toBeNull();
  });
});
