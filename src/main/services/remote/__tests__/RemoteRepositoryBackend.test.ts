import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));

vi.mock('../RemoteConnectionManager', () => ({
  remoteConnectionManager: { call: callMock },
}));

vi.mock('../RemoteI18n', () => ({
  createRemoteError: (message: string) => new Error(message),
}));

vi.mock('../RemotePath', () => ({
  isRemoteVirtualPath: () => true,
  parseRemoteVirtualPath: (inputPath: string) => ({
    connectionId: 'conn-1',
    remotePath: inputPath.replace(/^remote:\/\/conn-1/, '') || '/',
  }),
  toRemoteVirtualPath: (connectionId: string, remotePath: string) =>
    `remote://${connectionId}${remotePath}`,
}));

import { RemoteRepositoryBackend } from '../RemoteRepositoryBackend';

describe('RemoteRepositoryBackend.createBranch branch name handling', () => {
  const workdir = 'remote://conn-1/repo';

  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue(undefined);
  });

  it('passes valid branch names through to the remote call', async () => {
    const backend = new RemoteRepositoryBackend();
    await backend.createBranch(workdir, 'feature/my-feature', 'main');

    expect(callMock).toHaveBeenCalledWith('conn-1', 'git:branchCreate', {
      rootPath: '/repo',
      name: 'feature/my-feature',
      startPoint: 'main',
    });
  });

  it('normalizes backslashes before invoking the remote call', async () => {
    const backend = new RemoteRepositoryBackend();
    await backend.createBranch(workdir, 'fix\\recentBug');

    expect(callMock).toHaveBeenCalledWith('conn-1', 'git:branchCreate', {
      rootPath: '/repo',
      name: 'fix/recentBug',
      startPoint: undefined,
    });
  });

  it.each(['fix bug', '-foo', 'a..b', 'a.lock', '/fix', 'fix/', 'a~b', 'a:b', ''])(
    'rejects invalid branch name %j without invoking the remote call',
    async (name) => {
      const backend = new RemoteRepositoryBackend();
      await expect(backend.createBranch(workdir, name)).rejects.toThrow(
        /无效的分支名|分支名不能为空/
      );
      expect(callMock).not.toHaveBeenCalled();
    }
  );
});
