import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GitService -> git/runtime -> terminal/PtyManager pulls the node-pty native
// module, which is built for Electron and cannot load under a plain Node test.
vi.mock('../../terminal/PtyManager', () => ({
  getEnhancedPath: () => process.env.PATH ?? '',
}));

const spawnGitMock = vi.fn();
vi.mock('../runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime')>();
  return { ...actual, spawnGit: (...args: unknown[]) => spawnGitMock(...args) };
});

const { GitService } = await import('../GitService');

/**
 * Q7: on the encrypted Windows host the git panel showed a healthy repository
 * as empty — `getStatus` said `current: null, isClean: true`, `getBranches`
 * said `(no commits yet)`. Neither call failed. The cause was not git and not
 * the encryption: every reader turned "no parseable stdout" into a confident,
 * plausible, wrong answer. These tests pin the three judgements that made that
 * possible; none of them needs the encrypted host to reproduce.
 */

/** A git child process whose stdout/exit the test drives. */
function fakeGitProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: (signal?: string) => boolean;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = (signal?: string) => {
    proc.killed = true;
    proc.emit('close', null, signal ?? 'SIGTERM');
    return true;
  };
  return proc;
}

function emitRecords(proc: ReturnType<typeof fakeGitProcess>, records: string[]): void {
  proc.stdout.emit('data', Buffer.from(records.map((r) => `${r}\0`).join('')));
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiclient-git-q7-'));
  spawnGitMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('git status readers reject lost output instead of inventing a clean repo (Q7)', () => {
  it('getStatus fails when git exits 0 without emitting branch headers', async () => {
    const proc = fakeGitProcess();
    spawnGitMock.mockReturnValue(proc);
    const pending = new GitService(root).getStatus();
    queueMicrotask(() => proc.emit('close', 0, null));
    await expect(pending).rejects.toThrow(/output was lost/);
  });

  it('getStatus still succeeds on a real, clean status stream', async () => {
    const proc = fakeGitProcess();
    spawnGitMock.mockReturnValue(proc);
    const pending = new GitService(root).getStatus();
    queueMicrotask(() => {
      emitRecords(proc, ['# branch.oid deadbeef', '# branch.head main']);
      proc.emit('close', 0, null);
    });
    await expect(pending).resolves.toMatchObject({ current: 'main', isClean: true });
  });

  it('getStatus reports a timeout as a failure, not as a half-read status', async () => {
    vi.useFakeTimers();
    const proc = fakeGitProcess();
    spawnGitMock.mockReturnValue(proc);
    const pending = new GitService(root).getStatus();
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    emitRecords(proc, ['# branch.oid deadbeef', '# branch.head main']);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('getFileChanges fails on the same lost-output shape', async () => {
    const proc = fakeGitProcess();
    spawnGitMock.mockReturnValue(proc);
    const pending = new GitService(root).getFileChanges();
    queueMicrotask(() => proc.emit('close', 0, null));
    await expect(pending).rejects.toThrow(/output was lost/);
  });
});

describe('getBranches distinguishes an unborn repo from a lost branch listing (Q7)', () => {
  function initRepo(withCommit: boolean): string {
    const repo = path.join(root, withCommit ? 'with-commit' : 'unborn');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const run = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    if (withCommit) {
      writeFileSync(path.join(repo, 'a.txt'), 'a\n');
      run('add', 'a.txt');
      run('commit', '-q', '-m', 'first');
    }
    return repo;
  }

  it('labels a genuinely empty repo "(no commits yet)"', async () => {
    const service = new GitService(initRepo(false));
    await expect(service.getBranches()).resolves.toEqual([
      { name: 'main', current: true, commit: '', label: '(no commits yet)' },
    ]);
  });

  it('fails instead of claiming "(no commits yet)" when the listing is lost', async () => {
    const service = new GitService(initRepo(true));
    // Stand in for the encrypted host, where the listing came back unparseable
    // while the repo itself was perfectly healthy.
    (service as unknown as { git: { branch: () => unknown } }).git.branch = async () => ({
      branches: {},
    });
    await expect(service.getBranches()).rejects.toThrow(/output was lost/);
  });

  // `skipMerged` only drops the PR-merged marking. It must not skip these two
  // judgements: the composer's branch picker passes it, and an early return
  // before them gave a fresh repo an empty picker and a lost listing a
  // confident "no branches".
  it('keeps the "(no commits yet)" entry with skipMerged', async () => {
    const service = new GitService(initRepo(false));
    await expect(service.getBranches({ skipMerged: true })).resolves.toEqual([
      { name: 'main', current: true, commit: '', label: '(no commits yet)' },
    ]);
  });

  it('still fails on a lost listing with skipMerged', async () => {
    const service = new GitService(initRepo(true));
    (service as unknown as { git: { branch: () => unknown } }).git.branch = async () => ({
      branches: {},
    });
    await expect(service.getBranches({ skipMerged: true })).rejects.toThrow(/output was lost/);
  });

  it('lists the real branches with skipMerged and no merged marking', async () => {
    const service = new GitService(initRepo(true));
    const branches = await service.getBranches({ skipMerged: true });
    expect(branches.map((branch) => [branch.name, branch.current])).toEqual([['main', true]]);
    expect(branches[0]).not.toHaveProperty('merged');
  });
});

describe('getBranches recovers via node.exe fallback when simple-git loses output (F3)', () => {
  function initRepo(): string {
    const repo = path.join(root, 'with-commit');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const run = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    run('add', 'a.txt');
    run('commit', '-q', '-m', 'first');
    return repo;
  }

  /** Mock runGitViaNode on a GitService instance. */
  function mockRunGitViaNode(
    service: InstanceType<typeof GitService>,
    stdout: string,
    exitCode = 0
  ): void {
    (service as unknown as {
      runGitViaNode: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    }).runGitViaNode = async () => ({ stdout, stderr: '', exitCode });
  }

  it('recovers branches when simple-git returns empty but node.exe succeeds', async () => {
    const service = new GitService(initRepo());
    // Simulate the encrypted host: simple-git returns empty branches
    (service as unknown as { git: { branch: () => unknown } }).git.branch = async () => ({
      branches: {},
    });
    // node.exe fallback returns real branch data
    mockRunGitViaNode(
      service,
      '* main abc1234 first commit\n  remotes/origin/HEAD -> origin/main\n'
    );

    const branches = await service.getBranches({ skipMerged: true });
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({
      name: 'main',
      current: true,
      commit: 'abc1234',
      label: 'first commit',
    });
  });

  it('still throws "output was lost" when the fallback also returns empty', async () => {
    const service = new GitService(initRepo());
    (service as unknown as { git: { branch: () => unknown } }).git.branch = async () => ({
      branches: {},
    });
    // node.exe fallback also returns empty
    mockRunGitViaNode(service, '', 0);

    await expect(service.getBranches()).rejects.toThrow(/output was lost/);
  });

  it('parses multi-branch output with remote and worktree markers', async () => {
    const service = new GitService(initRepo());
    (service as unknown as { git: { branch: () => unknown } }).git.branch = async () => ({
      branches: {},
    });
    mockRunGitViaNode(
      service,
      [
        '* current                              abc1234 feat: current branch',
        '+ worktree                             def5678 feat: worktree branch',
        '  main                                9abcdef fix: main',
        '  remotes/origin/HEAD                -> origin/main',
        '  remotes/origin/main                 9abcdef build: release',
      ].join('\n')
    );

    const branches = await service.getBranches({ skipMerged: true });
    expect(branches).toHaveLength(4); // 4 real branches, 1 symbolic ref skipped
    expect(branches[0]).toMatchObject({ name: 'current', current: true });
    expect(branches[1]).toMatchObject({ name: 'worktree', current: false });
    expect(branches[2]).toMatchObject({ name: 'main', current: false });
    expect(branches[3]).toMatchObject({ name: 'remotes/origin/main', current: false });
  });
});

describe('getStatus recovers via node.exe fallback when spawnGit loses output (F3)', () => {
  function initRepo(): string {
    const repo = path.join(root, 'with-commit');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const run = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    run('add', 'a.txt');
    run('commit', '-q', '-m', 'first');
    return repo;
  }

  /** Mock runGitViaNode on a GitService instance. */
  function mockRunGitViaNode(
    service: InstanceType<typeof GitService>,
    stdout: string,
    exitCode = 0
  ): void {
    (service as unknown as {
      runGitViaNode: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    }).runGitViaNode = async () => ({ stdout, stderr: '', exitCode });
  }

  it('recovers status when spawnGit returns empty but node.exe succeeds', async () => {
    const service = new GitService(initRepo());
    // Primary path: spawnGit returns empty (no branch headers)
    const proc = fakeGitProcess();
    spawnGitMock.mockReturnValue(proc);
    // Fallback: node.exe returns short format status
    mockRunGitViaNode(service, '## main...origin/main\n M modified.txt\n?? untracked.txt\n');

    const pending = service.getStatus();
    queueMicrotask(() => proc.emit('close', 0, null));

    const status = await pending;
    expect(status.current).toBe('main');
    expect(status.tracking).toBe('origin/main');
    expect(status.modified).toContain('modified.txt');
    expect(status.untracked).toContain('untracked.txt');
    expect(status.isClean).toBe(false);
  });

  it('still throws "output was lost" when both paths fail', async () => {
    const service = new GitService(initRepo());
    // Primary: empty
    const proc = fakeGitProcess();
    spawnGitMock.mockReturnValue(proc);
    // Fallback: also empty
    mockRunGitViaNode(service, '', 0);

    const pending = service.getStatus();
    queueMicrotask(() => proc.emit('close', 0, null));

    await expect(pending).rejects.toThrow(/output was lost/);
  });

  it('parses staged, modified, deleted, and conflicted files', async () => {
    const service = new GitService(initRepo());
    const proc = fakeGitProcess();
    spawnGitMock.mockReturnValue(proc);
    mockRunGitViaNode(
      service,
      [
        '## main',
        'A  staged.txt',
        ' M modified.txt',
        ' D deleted.txt',
        '?? untracked.txt',
        'UU conflict.txt',
      ].join('\n')
    );

    const pending = service.getStatus();
    queueMicrotask(() => proc.emit('close', 0, null));

    const status = await pending;
    expect(status.current).toBe('main');
    expect(status.staged).toContain('staged.txt');
    expect(status.modified).toContain('modified.txt');
    expect(status.deleted).toContain('deleted.txt');
    expect(status.untracked).toContain('untracked.txt');
    expect(status.conflicted).toContain('conflict.txt');
  });
});
