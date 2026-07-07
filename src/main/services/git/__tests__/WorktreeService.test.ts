import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rawMock } = vi.hoisted(() => ({ rawMock: vi.fn() }));

vi.mock('../runtime', () => ({
  createSimpleGit: () => ({ raw: rawMock }),
  toGitPath: (_workdir: string, inputPath: string) => inputPath,
  fromGitPath: (_workdir: string, inputPath: string) => inputPath,
  spawnGit: vi.fn(),
}));

import { WorktreeService } from '../WorktreeService';

describe('WorktreeService.add branch name handling', () => {
  beforeEach(() => {
    rawMock.mockReset();
    // First call is `git rev-parse HEAD` (has-commits check); succeed by default
    rawMock.mockResolvedValue('');
  });

  it('normalizes backslashes in newBranch before invoking git', async () => {
    const service = new WorktreeService('/repo');
    await service.add({ path: '/wt/fix/recentBug', branch: 'main', newBranch: 'fix\\recentBug' });

    expect(rawMock).toHaveBeenNthCalledWith(1, ['rev-parse', 'HEAD']);
    expect(rawMock).toHaveBeenNthCalledWith(2, [
      'worktree',
      'add',
      '-b',
      'fix/recentBug',
      '/wt/fix/recentBug',
      'main',
    ]);
  });

  it('passes valid branch names through unchanged', async () => {
    const service = new WorktreeService('/repo');
    await service.add({ path: '/wt/feat', branch: 'main', newBranch: 'feature/my-feature' });

    expect(rawMock).toHaveBeenNthCalledWith(2, [
      'worktree',
      'add',
      '-b',
      'feature/my-feature',
      '/wt/feat',
      'main',
    ]);
  });

  it.each([
    'fix bug',
    '-foo',
    'a..b',
    'a.lock',
    '/fix',
    'fix/',
    'a~b',
  ])('rejects invalid newBranch %j without invoking `git worktree add`', async (newBranch) => {
    const service = new WorktreeService('/repo');
    await expect(service.add({ path: '/wt/x', branch: 'main', newBranch })).rejects.toThrow(
      /无效的分支名/
    );

    // Only the rev-parse HEAD check ran; no worktree mutation was attempted
    expect(rawMock).toHaveBeenCalledTimes(1);
    expect(rawMock).toHaveBeenCalledWith(['rev-parse', 'HEAD']);
  });

  it('does not validate when newBranch is absent', async () => {
    const service = new WorktreeService('/repo');
    await service.add({ path: '/wt/x', branch: 'main' });

    expect(rawMock).toHaveBeenNthCalledWith(2, ['worktree', 'add', '/wt/x', 'main']);
  });
});
