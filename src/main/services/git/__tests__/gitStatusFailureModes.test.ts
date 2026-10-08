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
const isWslGitRepositoryMock = vi.fn((_workdir: string) => false);
// Tests that do not fake a git process get the real `spawnGit` (real git on a
// scratch repository — the ordinary-machine path).
const runtimeActual = vi.hoisted(() => ({
  spawnGit: null as unknown as (...a: unknown[]) => unknown,
}));
vi.mock('../runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime')>();
  runtimeActual.spawnGit = actual.spawnGit as (...a: unknown[]) => unknown;
  return {
    ...actual,
    spawnGit: (...args: unknown[]) => spawnGitMock(...args),
    isWslGitRepository: (workdir: string) => isWslGitRepositoryMock(workdir),
  };
});

// The F3 runner spawns `node -e ... git ...`. No test may reach the real one:
// every test gets this stub, whose default answer is "the fallback lost its
// output too", and F3 cases override it.
const runGitViaNodeMock = vi.fn();
vi.mock('../nodeGitRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../nodeGitRunner')>();
  return { ...actual, runGitViaNode: (...args: unknown[]) => runGitViaNodeMock(...args) };
});

const { GitService } = await import('../GitService');
const { createGitEnv } = await import('../runtime');
const { resetGitReadFallbackForTests, shouldRouteViaRunner } = await import('../gitReadFallback');
const { NodeGitRunnerError, isGitOutputLostError } = await import('../nodeGitRunner');

const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'];
const BRANCH_ARGS = ['branch', '--no-color', '-a', '-v'];

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

const z = (records: string[]): string => records.map((record) => `${record}\0`).join('');

function emitRecords(proc: ReturnType<typeof fakeGitProcess>, records: string[]): void {
  proc.stdout.emit('data', Buffer.from(z(records)));
}

/** Primary `git status` that exits 0 with no stdout: the encrypted-host shape. */
function loseStatusOutput(stderr = ''): void {
  const proc = fakeGitProcess();
  spawnGitMock.mockReturnValue(proc);
  setTimeout(() => {
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', 0, null);
  }, 0);
}

function loseBranchListing(service: InstanceType<typeof GitService>): void {
  (service as unknown as { git: { branch: () => unknown } }).git.branch = async () => ({
    branches: {},
  });
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiclient-git-q7-'));
  // The runner routing switch is process-wide; every test starts before any
  // recovery.
  resetGitReadFallbackForTests();
  spawnGitMock.mockReset();
  spawnGitMock.mockImplementation((...args: unknown[]) => runtimeActual.spawnGit(...args));
  isWslGitRepositoryMock.mockReset();
  isWslGitRepositoryMock.mockReturnValue(false);
  runGitViaNodeMock.mockReset();
  runGitViaNodeMock.mockResolvedValue({ stdout: '', stderr: '' });
  // The fallback's one-per-kind success line.
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function initRepo(name: string, withCommit: boolean): string {
  const repo = path.join(root, name);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  if (withCommit) {
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'first');
  }
  return repo;
}

describe('git status readers reject lost output instead of inventing a clean repo (Q7)', () => {
  it('getStatus fails when git exits 0 without emitting branch headers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    loseStatusOutput();
    const error = await new GitService(root).getStatus().catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/output was lost/);
    expect(isGitOutputLostError(error)).toBe(true);
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
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
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
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('treats an outside kill before the branch headers as a failure, not a lost output', async () => {
    const proc = fakeGitProcess();
    spawnGitMock.mockReturnValue(proc);
    const pending = new GitService(root).getStatus();
    queueMicrotask(() => proc.emit('close', null, 'SIGKILL'));
    await expect(pending).rejects.toThrow(/terminated by SIGKILL/);
    expect(isGitOutputLostError(await pending.catch((e: unknown) => e))).toBe(false);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
    expect(shouldRouteViaRunner(root)).toBe(false);
  });

  it('rejects a status killed from outside after its headers instead of returning it half-read', async () => {
    const proc = fakeGitProcess();
    spawnGitMock.mockReturnValue(proc);
    const pending = new GitService(root).getFileChanges();
    queueMicrotask(() => {
      emitRecords(proc, ['# branch.oid deadbeef', '# branch.head main']);
      proc.emit('close', null, 'SIGTERM');
    });
    await expect(pending).rejects.toThrow(/terminated by SIGTERM/);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
    expect(shouldRouteViaRunner(root)).toBe(false);
  });

  it('getFileChanges fails on the same lost-output shape', async () => {
    const proc = fakeGitProcess();
    spawnGitMock.mockReturnValue(proc);
    const pending = new GitService(root).getFileChanges();
    queueMicrotask(() => proc.emit('close', 0, null));
    await expect(pending).rejects.toThrow(/output was lost/);
  });

  it('getStatus keeps whole paths with spaces and records renames by their new path', async () => {
    const proc = fakeGitProcess();
    spawnGitMock.mockReturnValue(proc);
    const pending = new GitService(root).getStatus();
    const stream = z([
      '# branch.oid a137f7993853cd1a8c6b3f454fd4ce3d0e0ab671',
      '# branch.head main',
      '2 R. N... 100644 100644 100644 6a69f92020f5df77af6e8813ff1232493383b708 6a69f92020f5df77af6e8813ff1232493383b708 R100 new name.txt',
      'old-name.txt',
      '1 .M N... 100644 100644 100644 01058d844a98d293a3b03a8615a34700e4ed2be3 01058d844a98d293a3b03a8615a34700e4ed2be3 with space.txt',
    ]);
    queueMicrotask(() => {
      // Split mid-record: the reader must reassemble across chunks.
      const bytes = Buffer.from(stream);
      proc.stdout.emit('data', bytes.subarray(0, 150));
      proc.stdout.emit('data', bytes.subarray(150));
      proc.emit('close', 0, null);
    });
    const status = await pending;
    expect(status.staged).toEqual(['new name.txt']);
    expect(status.modified).toEqual(['with space.txt']);
    expect([...status.staged, ...status.modified]).not.toContain('old-name.txt');
    expect([...status.staged, ...status.modified]).not.toContain('space.txt');
  });
});

describe('getBranches distinguishes an unborn repo from a lost branch listing (Q7)', () => {
  it('labels a genuinely empty repo "(no commits yet)"', async () => {
    const service = new GitService(initRepo('unborn', false));
    await expect(service.getBranches()).resolves.toEqual([
      { name: 'main', current: true, commit: '', label: '(no commits yet)' },
    ]);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('fails instead of claiming "(no commits yet)" when the listing is lost', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new GitService(initRepo('with-commit', true));
    // Stand in for the encrypted host, where the listing came back unparseable
    // while the repo itself was perfectly healthy.
    loseBranchListing(service);
    await expect(service.getBranches()).rejects.toThrow(/output was lost/);
  });

  // `skipMerged` only drops the PR-merged marking. It must not skip these two
  // judgements: the composer's branch picker passes it, and an early return
  // before them gave a fresh repo an empty picker and a lost listing a
  // confident "no branches".
  it('keeps the "(no commits yet)" entry with skipMerged', async () => {
    const service = new GitService(initRepo('unborn', false));
    await expect(service.getBranches({ skipMerged: true })).resolves.toEqual([
      { name: 'main', current: true, commit: '', label: '(no commits yet)' },
    ]);
  });

  it('still fails on a lost listing with skipMerged', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new GitService(initRepo('with-commit', true));
    loseBranchListing(service);
    await expect(service.getBranches({ skipMerged: true })).rejects.toThrow(/output was lost/);
  });

  it('lists the real branches with skipMerged and no merged marking', async () => {
    const service = new GitService(initRepo('with-commit', true));
    const branches = await service.getBranches({ skipMerged: true });
    expect(branches.map((branch) => [branch.name, branch.current])).toEqual([['main', true]]);
    expect(branches[0]).not.toHaveProperty('merged');
  });
});

describe('getStatus recovers via the node runner when its output is lost (F3)', () => {
  const RECOVERED = [
    '# branch.oid a137f7993853cd1a8c6b3f454fd4ce3d0e0ab671',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +1 -2',
    '1 .M N... 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 78981922613b2afb6025042ff6bd878ac1994e85 unstaged.txt',
    '1 M. N... 100644 100644 100644 61780798228d17af2d34fce4cfbdf35556832472 0505b3b1df17e3fedbe98668cf073a5649215560 staged.txt',
    '1 .D N... 100644 100644 000000 d905d9da82c97264ab6f4920e20242e088850ce9 d905d9da82c97264ab6f4920e20242e088850ce9 wt-del.txt',
    '2 R. N... 100644 100644 100644 6a69f92020f5df77af6e8813ff1232493383b708 6a69f92020f5df77af6e8813ff1232493383b708 R100 new name.txt',
    'old-name.txt',
    '1 .M N... 100644 100644 100644 6e9f0da13f19b444ec3a9c3d6e795ad35c0554a2 6e9f0da13f19b444ec3a9c3d6e795ad35c0554a2 中文 文件.md',
    'u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 ba2906d0666cf726c7eaadd2cd3db615dedfdf3a e45c9c2666d44e0327c1f9c239a74c508336053e uu.txt',
    '? untracked.txt',
  ];

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('runs the primary command line through the runner and parses it the same way', async () => {
    loseStatusOutput();
    runGitViaNodeMock.mockResolvedValue({ stdout: z(RECOVERED), stderr: '' });

    const status = await new GitService(root).getStatus();

    expect(runGitViaNodeMock).toHaveBeenCalledTimes(1);
    expect(runGitViaNodeMock).toHaveBeenCalledWith({
      workdir: root,
      args: STATUS_ARGS,
      env: createGitEnv(root),
    });
    // Exactly what the primary path runs, so both feed the same parser.
    expect(spawnGitMock.mock.calls[0][1]).toEqual(STATUS_ARGS);

    expect(status).toMatchObject({
      current: 'main',
      tracking: 'origin/main',
      ahead: 1,
      behind: 2,
      isClean: false,
      truncated: false,
    });
    expect(status.modified).toEqual(['unstaged.txt', '中文 文件.md']);
    expect(status.staged).toEqual(['staged.txt', 'new name.txt']);
    expect(status.deleted).toEqual(['wt-del.txt']);
    expect(status.conflicted).toEqual(['uu.txt']);
    expect(status.untracked).toEqual(['untracked.txt']);
    expect(status.staged).not.toContain('unstaged.txt');
    expect(status.modified).not.toContain('staged.txt');
    expect(status.modified).not.toContain('wt-del.txt');
    expect(status.staged).not.toContain('uu.txt');
  });

  it('falls back when the lost primary run also wrote to stderr', async () => {
    // The lost-output error then carries stderr as its message; the fallback
    // must key on the error type, not on the text.
    loseStatusOutput('warning: unable to access some/dir: Permission denied\n');
    runGitViaNodeMock.mockResolvedValue({ stdout: z(RECOVERED), stderr: '' });

    const status = await new GitService(root).getStatus();

    expect(runGitViaNodeMock).toHaveBeenCalledTimes(1);
    expect(status.current).toBe('main');
  });

  it('still throws "output was lost" when both paths lose it', async () => {
    loseStatusOutput();

    const error = await new GitService(root).getStatus().catch((e: unknown) => e);

    expect(runGitViaNodeMock).toHaveBeenCalledTimes(1);
    expect((error as Error).message).toMatch(/output was lost/);
    expect(isGitOutputLostError(error)).toBe(true);
  });

  it('surfaces a runner failure instead of a status', async () => {
    loseStatusOutput();
    runGitViaNodeMock.mockRejectedValue(
      new NodeGitRunnerError(
        'git status via the node runner failed: exit 128: fatal: bad',
        'git-exit',
        128,
        null
      )
    );

    const error = await new GitService(root).getStatus().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NodeGitRunnerError);
    expect((error as Error).message).toContain('exit 128');
  });

  it('does not fall back on a real git failure', async () => {
    const proc = fakeGitProcess();
    spawnGitMock.mockReturnValue(proc);
    const pending = new GitService(root).getStatus();
    queueMicrotask(() => {
      proc.stderr.emit('data', Buffer.from('fatal: not a git repository'));
      proc.emit('close', 128, null);
    });

    await expect(pending).rejects.toThrow(/not a git repository/);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('does not route WSL repositories through the runner', async () => {
    isWslGitRepositoryMock.mockReturnValue(true);
    loseStatusOutput();

    await expect(new GitService(root).getStatus()).rejects.toThrow(/output was lost/);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });
});

describe('getBranches recovers via the node runner when simple-git loses output (F3)', () => {
  /**
   * A clone with a remote symref, a branch ahead of its upstream whose subject
   * contains "->", a branch checked out in a linked worktree, and a branch
   * whose upstream is gone.
   */
  function initBranchRepo(): string {
    const upstream = initRepo('upstream', true);
    const repo = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', upstream, repo]);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', 'b.txt');
    git(repo, 'commit', '-q', '-m', 'fix: a -> b');
    git(repo, 'branch', 'feature');
    git(repo, 'config', 'branch.feature.remote', 'origin');
    git(repo, 'config', 'branch.feature.merge', 'refs/heads/feature');
    git(repo, 'worktree', 'add', '-q', '-b', 'wtbranch', path.join(root, 'linked'));
    return repo;
  }

  /** What the runner would relay: the same listing, under the runner's C locale. */
  function runnerListing(repo: string): string {
    return execFileSync('git', ['-C', repo, ...BRANCH_ARGS], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' },
    });
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Pin the primary (simple-git) run to the same locale as the runner.
    vi.stubEnv('LC_ALL', 'C');
    vi.stubEnv('LANGUAGE', 'C');
  });

  it('produces exactly the primary path result', async () => {
    const repo = initBranchRepo();
    const primary = await new GitService(repo).getBranches({ skipMerged: true });

    const service = new GitService(repo);
    loseBranchListing(service);
    runGitViaNodeMock.mockResolvedValue({ stdout: runnerListing(repo), stderr: '' });
    const recovered = await service.getBranches({ skipMerged: true });

    expect(runGitViaNodeMock).toHaveBeenCalledWith({
      workdir: repo,
      args: BRANCH_ARGS,
      env: createGitEnv(repo),
    });
    expect(recovered).toEqual(primary);
    // Spot-check that the comparison covers the cases that used to break.
    const byName = new Map(recovered.map((branch) => [branch.name, branch]));
    expect(byName.get('main')).toMatchObject({ current: true, label: '[ahead 1] fix: a -> b' });
    expect(byName.get('feature')?.label).toBe('[gone] fix: a -> b');
    expect(byName.get('wtbranch')?.current).toBe(false);
    expect(byName.has('remotes/origin/main')).toBe(true);
    expect(byName.has('remotes/origin/HEAD')).toBe(false);
  });

  it('produces the primary path detached-HEAD entry', async () => {
    const repo = initBranchRepo();
    git(repo, 'checkout', '-q', '--detach', 'HEAD~1');
    const primary = await new GitService(repo).getBranches({ skipMerged: true });

    const service = new GitService(repo);
    loseBranchListing(service);
    runGitViaNodeMock.mockResolvedValue({ stdout: runnerListing(repo), stderr: '' });
    const recovered = await service.getBranches({ skipMerged: true });

    expect(recovered).toEqual(primary);
    const current = recovered.filter((branch) => branch.current);
    expect(current).toHaveLength(1);
    expect(current[0].name).toBe(git(repo, 'rev-parse', '--short', 'HEAD').trim());
  });

  it('still throws "output was lost" when the runner returns nothing', async () => {
    const service = new GitService(initRepo('with-commit', true));
    loseBranchListing(service);

    const error = await service.getBranches().catch((e: unknown) => e);

    expect(runGitViaNodeMock).toHaveBeenCalledTimes(1);
    expect((error as Error).message).toMatch(/output was lost/);
    expect(isGitOutputLostError(error)).toBe(true);
  });

  it('surfaces a runner failure', async () => {
    const service = new GitService(initRepo('with-commit', true));
    loseBranchListing(service);
    runGitViaNodeMock.mockRejectedValue(
      new NodeGitRunnerError(
        'git branch via the node runner failed: timed out after 30000ms',
        'timeout',
        null,
        'SIGTERM'
      )
    );

    await expect(service.getBranches({ skipMerged: true })).rejects.toThrow(/timed out/);
  });

  it('does not route WSL repositories through the runner', async () => {
    const service = new GitService(initRepo('with-commit', true));
    loseBranchListing(service);
    isWslGitRepositoryMock.mockReturnValue(true);

    await expect(service.getBranches({ skipMerged: true })).rejects.toThrow(/output was lost/);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });
});
