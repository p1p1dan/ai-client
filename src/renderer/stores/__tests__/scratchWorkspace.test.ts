import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScratchWorkspaceStore } from '../scratchWorkspace';

/**
 * U05-a (renderer half) — the store that remembers which isolated directory
 * Main handed each unbound chat.
 *
 * The property under test is deduplication. The send path and the Pi TUI both
 * call `ensure` without coordinating, and a session that ends up with two
 * directories is one whose terminal cannot see what its chat just wrote.
 */

let ensureScratchWorkspace: ReturnType<typeof vi.fn>;

function resetStore(): void {
  useScratchWorkspaceStore.setState({ pathsBySession: {} });
  for (const sessionId of ['s1', 's2']) {
    useScratchWorkspaceStore.getState().forget(sessionId);
  }
}

beforeEach(() => {
  resetStore();
  ensureScratchWorkspace = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
    path: `/tmp/base/unbound-sessions/${sessionId}`,
  }));
  vi.stubGlobal('window', { electronAPI: { chat: { ensureScratchWorkspace } } });
});

afterEach(() => {
  resetStore();
  vi.unstubAllGlobals();
});

describe('useScratchWorkspaceStore.ensure', () => {
  it('asks Main once and remembers the answer', async () => {
    const path = await useScratchWorkspaceStore.getState().ensure('s1');

    expect(path).toBe('/tmp/base/unbound-sessions/s1');
    expect(useScratchWorkspaceStore.getState().pathFor('s1')).toBe(path);

    await expect(useScratchWorkspaceStore.getState().ensure('s1')).resolves.toBe(path);
    expect(ensureScratchWorkspace).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent calls into one allocation', async () => {
    // The real race: the composer's first send and `openTui` in the same tick.
    const [a, b] = await Promise.all([
      useScratchWorkspaceStore.getState().ensure('s1'),
      useScratchWorkspaceStore.getState().ensure('s1'),
    ]);
    expect(b).toBe(a);
    expect(ensureScratchWorkspace).toHaveBeenCalledTimes(1);
  });

  it('keeps sessions apart', async () => {
    const first = await useScratchWorkspaceStore.getState().ensure('s1');
    const second = await useScratchWorkspaceStore.getState().ensure('s2');
    expect(second).not.toBe(first);
  });

  it('rejects an empty path instead of caching it as a usable cwd', async () => {
    // An empty cwd reaching `chat:createSession` would persist a fake working
    // directory into the session index — the exact failure the old `!cwd`
    // send guard existed to prevent.
    ensureScratchWorkspace.mockResolvedValueOnce({ path: '   ' });
    await expect(useScratchWorkspaceStore.getState().ensure('s1')).rejects.toThrow(
      'returned no path'
    );
    expect(useScratchWorkspaceStore.getState().pathFor('s1')).toBeNull();
  });

  it('lets a later attempt retry after a failure', async () => {
    ensureScratchWorkspace.mockRejectedValueOnce(new Error('disk full'));
    await expect(useScratchWorkspaceStore.getState().ensure('s1')).rejects.toThrow('disk full');
    await expect(useScratchWorkspaceStore.getState().ensure('s1')).resolves.toBe(
      '/tmp/base/unbound-sessions/s1'
    );
  });

  it('reports no path for an unknown or absent session', () => {
    expect(useScratchWorkspaceStore.getState().pathFor('never-asked')).toBeNull();
    expect(useScratchWorkspaceStore.getState().pathFor(null)).toBeNull();
  });
});
