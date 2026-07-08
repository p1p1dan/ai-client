import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rawMock, checkoutBranchMock } = vi.hoisted(() => ({
  rawMock: vi.fn(),
  checkoutBranchMock: vi.fn(),
}));

vi.mock('../runtime', () => ({
  createSimpleGit: () => ({ raw: rawMock, checkoutBranch: checkoutBranchMock }),
  createGitEnv: () => ({}),
  isWslGitRepository: () => false,
  normalizeGitRelativePath: (inputPath: string) => inputPath,
  spawnGit: vi.fn(),
  toGitPath: (_workdir: string, inputPath: string) => inputPath,
}));

import { GitService } from '../GitService';

/** Route rawMock by git subcommand so call order stays flexible. */
function mockGitCommands(handlers: {
  revParseHead: () => Promise<string>;
  config?: (key: string) => Promise<string>;
  commit?: (args: string[]) => Promise<string>;
}) {
  rawMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return handlers.revParseHead();
    }
    if (args[0] === 'config') {
      if (!handlers.config) throw new Error(`unexpected git config ${args[1]}`);
      return handlers.config(args[1]);
    }
    if (args.includes('commit')) {
      if (!handlers.commit) throw new Error('unexpected git commit');
      return handlers.commit(args);
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
}

const commitCalls = () =>
  rawMock.mock.calls.map(([args]) => args as string[]).filter((args) => args.includes('commit'));

describe('GitService.ensureInitialCommit', () => {
  beforeEach(() => {
    rawMock.mockReset();
  });

  it('is a no-op when the repository already has commits', async () => {
    mockGitCommands({ revParseHead: () => Promise.resolve('abc123') });

    const service = new GitService('/repo');
    await expect(service.ensureInitialCommit()).resolves.toBe(false);

    expect(rawMock).toHaveBeenCalledTimes(1);
    expect(commitCalls()).toHaveLength(0);
  });

  it('creates an empty initial commit with the configured user identity', async () => {
    mockGitCommands({
      revParseHead: () => Promise.reject(new Error('unknown revision HEAD')),
      config: () => Promise.resolve('configured-value\n'),
      commit: () => Promise.resolve(''),
    });

    const service = new GitService('/repo');
    await expect(service.ensureInitialCommit()).resolves.toBe(true);

    expect(commitCalls()).toEqual([
      ['commit', '--allow-empty', '--no-verify', '-m', 'Initial commit'],
    ]);
    // Never stages user files: no `git add` in any call
    expect(rawMock.mock.calls.every(([args]) => (args as string[])[0] !== 'add')).toBe(true);
  });

  it('falls back to an app identity when user.name/user.email are not configured', async () => {
    mockGitCommands({
      revParseHead: () => Promise.reject(new Error('unknown revision HEAD')),
      config: () => Promise.reject(new Error('exit code 1')),
      commit: () => Promise.resolve(''),
    });

    const service = new GitService('/repo');
    await expect(service.ensureInitialCommit()).resolves.toBe(true);

    expect(commitCalls()).toEqual([
      [
        '-c',
        'user.name=AiClient',
        '-c',
        'user.email=aiclient@localhost',
        'commit',
        '--allow-empty',
        '--no-verify',
        '-m',
        'Initial commit',
      ],
    ]);
  });

  it('treats empty config values as missing identity', async () => {
    mockGitCommands({
      revParseHead: () => Promise.reject(new Error('unknown revision HEAD')),
      config: (key) => Promise.resolve(key === 'user.name' ? 'Dan\n' : '  \n'),
      commit: () => Promise.resolve(''),
    });

    const service = new GitService('/repo');
    await expect(service.ensureInitialCommit()).resolves.toBe(true);

    expect(commitCalls()[0]).toContain('user.email=aiclient@localhost');
  });

  it('propagates commit failures to the caller', async () => {
    mockGitCommands({
      revParseHead: () => Promise.reject(new Error('unknown revision HEAD')),
      config: () => Promise.resolve('configured-value\n'),
      commit: () => Promise.reject(new Error('disk full')),
    });

    const service = new GitService('/repo');
    await expect(service.ensureInitialCommit()).rejects.toThrow('disk full');
  });
});

describe('GitService.createBranch branch name handling', () => {
  beforeEach(() => {
    checkoutBranchMock.mockReset();
    checkoutBranchMock.mockResolvedValue(undefined);
  });

  it('passes valid branch names through, defaulting startPoint to HEAD', async () => {
    const service = new GitService('/repo');
    await service.createBranch('feature/my-feature');

    expect(checkoutBranchMock).toHaveBeenCalledWith('feature/my-feature', 'HEAD');
  });

  it('forwards an explicit startPoint', async () => {
    const service = new GitService('/repo');
    await service.createBranch('feature/my-feature', 'origin/main');

    expect(checkoutBranchMock).toHaveBeenCalledWith('feature/my-feature', 'origin/main');
  });

  it('normalizes backslashes before invoking git', async () => {
    const service = new GitService('/repo');
    await service.createBranch('fix\\recentBug');

    expect(checkoutBranchMock).toHaveBeenCalledWith('fix/recentBug', 'HEAD');
  });

  it.each(['fix bug', '-foo', 'a..b', 'a.lock', '/fix', 'fix/', 'a~b', 'a:b', ''])(
    'rejects invalid branch name %j without invoking git',
    async (name) => {
      const service = new GitService('/repo');
      await expect(service.createBranch(name)).rejects.toThrow(/无效的分支名|分支名不能为空/);
      expect(checkoutBranchMock).not.toHaveBeenCalled();
    }
  );
});
