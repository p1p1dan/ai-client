import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GitService -> git/runtime -> terminal/PtyManager pulls the node-pty native
// module, which is built for Electron and cannot load under a plain Node test.
vi.mock('../../terminal/PtyManager', () => ({
  getEnhancedPath: () => process.env.PATH ?? '',
}));
// WorktreeService logs through electron-log.
vi.mock('../../../utils/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

/**
 * F3 on every git read (`gitReadFallback`): the encrypted Windows host loses
 * the stdout of a git that Main spawns directly, while its exit code and stderr
 * arrive. These tests stand that host in by faking the PRIMARY git process of
 * one subcommand (exit 0, no stdout) and stubbing the node runner. Nothing here
 * starts node; the git that does run is real git on scratch repositories — the
 * ordinary-machine path, which must not change.
 */

type FakeGit = { stdout?: string | Buffer; stderr?: string; code?: number };

const fakedCommands = new Map<string, FakeGit>();
const spawnedCommands: string[][] = [];
const isWslGitRepositoryMock = vi.fn((_workdir: string) => false);
const runtimeActual = vi.hoisted(() => ({
  spawnGit: null as unknown as (...args: unknown[]) => unknown,
}));

vi.mock('../runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime')>();
  runtimeActual.spawnGit = actual.spawnGit as (...args: unknown[]) => unknown;
  return {
    ...actual,
    spawnGit: (workdir: string, args: string[], options?: unknown) => {
      spawnedCommands.push(args);
      const fake = fakedCommands.get(args[0] ?? '');
      return fake ? fakeGitProcess(fake) : runtimeActual.spawnGit(workdir, args, options);
    },
    isWslGitRepository: (workdir: string) => isWslGitRepositoryMock(workdir),
  };
});

type RunnerOptions = { workdir: string; args: string[]; encoding?: 'buffer' };
type RunnerAnswer = string | Buffer | Error;
const runnerAnswers = new Map<string, RunnerAnswer>();
const runGitViaNodeMock = vi.fn(async (options: RunnerOptions) => {
  const answer = runnerAnswers.get(options.args[0] ?? '') ?? '';
  if (answer instanceof Error) throw answer;
  if (options.encoding === 'buffer') {
    return {
      stdout: Buffer.isBuffer(answer) ? answer : Buffer.from(answer),
      stderr: Buffer.alloc(0),
    };
  }
  return { stdout: answer.toString(), stderr: '' };
});
vi.mock('../nodeGitRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../nodeGitRunner')>();
  return {
    ...actual,
    runGitViaNode: (options: RunnerOptions) => runGitViaNodeMock(options),
  };
});

const { GitService } = await import('../GitService');
const { WorktreeService } = await import('../WorktreeService');
const { gitShowBuffer } = await import('../encoding');
const { createGitEnv } = await import('../runtime');
const { GIT_LOG_PRETTY_FORMAT } = await import('../gitLogFormat');
const { NodeGitRunnerError, isGitOutputLostError } = await import('../nodeGitRunner');
const {
  GitCommandError,
  noteRunnerRecovered,
  readGit,
  readGitBuffer,
  resetGitReadFallbackForTests,
  shouldRouteViaRunner,
} = await import('../gitReadFallback');

function fakeGitProcess(result: FakeGit) {
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
  setTimeout(() => {
    if (result.stdout?.length) proc.stdout.emit('data', Buffer.from(result.stdout));
    if (result.stderr) proc.stderr.emit('data', Buffer.from(result.stderr));
    if (!proc.killed) proc.emit('close', result.code ?? 0, null);
  }, 0);
  return proc;
}

/** The encrypted-host shape: the primary `git <command>` exits 0 and prints nothing. */
function losePrimary(command: string): void {
  fakedCommands.set(command, { code: 0 });
}

function runnerCalls(command: string): RunnerOptions[] {
  return runGitViaNodeMock.mock.calls
    .map(([options]) => options)
    .filter((o) => o.args[0] === command);
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiclient-git-f3-'));
  resetGitReadFallbackForTests();
  fakedCommands.clear();
  spawnedCommands.length = 0;
  runnerAnswers.clear();
  runGitViaNodeMock.mockClear();
  isWslGitRepositoryMock.mockReset();
  isWslGitRepositoryMock.mockReturnValue(false);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' },
  });
}

function initRepo(name: string, commits = 1): string {
  const repo = path.join(root, name);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  for (let i = 0; i < commits; i++) {
    writeFileSync(path.join(repo, `f${i}.txt`), `${i}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', `commit ${i}`);
  }
  return repo;
}

describe('readGit: the shared lost-output judgement and node-runner fallback', () => {
  it('recovers an "empty" read through the runner, then routes later reads straight to it', async () => {
    const repo = initRepo('repo');
    losePrimary('rev-parse');
    runnerAnswers.set('rev-parse', 'abc\n');

    const result = await readGit({
      what: 'rev-parse',
      workdir: repo,
      args: ['rev-parse', 'HEAD'],
      lostWhen: 'empty',
    });

    expect(result).toEqual({ stdout: 'abc\n', exitCode: 0 });
    // Same command line on both paths, with the primary path's git env.
    expect(runnerCalls('rev-parse')).toEqual([
      { workdir: repo, args: ['rev-parse', 'HEAD'], env: createGitEnv(repo) },
    ]);
    expect(shouldRouteViaRunner(repo)).toBe(true);

    // After a recovery the primary run is skipped entirely.
    spawnedCommands.length = 0;
    runnerAnswers.set('cat-file', 'commit\n');
    await readGit({
      what: 'cat-file',
      workdir: repo,
      args: ['cat-file', '-t', 'HEAD'],
      lostWhen: 'empty',
    });
    expect(spawnedCommands).toEqual([]);
  });

  it('throws a typed "output was lost" when the runner loses it too, without routing', async () => {
    const repo = initRepo('repo');
    losePrimary('rev-parse');

    const error = await readGit({
      what: 'rev-parse',
      workdir: repo,
      args: ['rev-parse', 'HEAD'],
      lostWhen: 'empty',
    }).catch((e: unknown) => e);

    expect(isGitOutputLostError(error)).toBe(true);
    expect((error as Error).message).toMatch(/via the node runner.*output was lost/);
    expect(shouldRouteViaRunner(repo)).toBe(false);
  });

  it('takes an empty answer at face value when empty is legitimate ("never")', async () => {
    const repo = initRepo('repo');
    // A clean tree: `git diff` prints nothing, for real.
    const result = await readGit({
      what: 'diff',
      workdir: repo,
      args: ['diff', '--shortstat', 'HEAD'],
      lostWhen: 'never',
    });
    expect(result).toEqual({ stdout: '', exitCode: 0 });
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('reports a non-zero exit as git failing, never as a loss', async () => {
    const repo = initRepo('repo');
    const error = await readGit({
      what: 'cat-file',
      workdir: repo,
      args: ['cat-file', '-p', 'no-such-ref'],
      lostWhen: 'empty',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitCommandError);
    expect((error as InstanceType<typeof GitCommandError>).exitCode).toBe(128);
    expect(isGitOutputLostError(error)).toBe(false);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('resolves an expected non-zero exit on both paths (symbolic-ref on a detached HEAD)', async () => {
    const repo = initRepo('repo');
    git(repo, 'checkout', '-q', '--detach');
    const spec = {
      what: 'symbolic-ref',
      workdir: repo,
      args: ['symbolic-ref', '--quiet', 'HEAD'],
      okExitCodes: [1],
      lostWhen: 'empty' as const,
    };

    await expect(readGit(spec)).resolves.toEqual({ stdout: '', exitCode: 1 });
    expect(runGitViaNodeMock).not.toHaveBeenCalled();

    noteRunnerRecovered('test');
    runnerAnswers.set(
      'symbolic-ref',
      new NodeGitRunnerError(
        'git symbolic-ref via the node runner failed: exit 1',
        'git-exit',
        1,
        null
      )
    );
    await expect(readGit(spec)).resolves.toEqual({ stdout: '', exitCode: 1 });
  });

  it('surfaces a runner that could not run, without routing', async () => {
    const repo = initRepo('repo');
    losePrimary('rev-parse');
    runnerAnswers.set(
      'rev-parse',
      new NodeGitRunnerError(
        'git rev-parse via the node runner failed: node could not be started (ENOENT)',
        'node-spawn',
        'ENOENT',
        null
      )
    );

    await expect(
      readGit({ what: 'rev-parse', workdir: repo, args: ['rev-parse', 'HEAD'], lostWhen: 'empty' })
    ).rejects.toBeInstanceOf(NodeGitRunnerError);
    expect(shouldRouteViaRunner(repo)).toBe(false);
  });

  it('never routes WSL repositories through the runner', async () => {
    const repo = initRepo('repo');
    isWslGitRepositoryMock.mockReturnValue(true);
    losePrimary('rev-parse');

    const error = await readGit({
      what: 'rev-parse',
      workdir: repo,
      args: ['rev-parse', 'HEAD'],
      lostWhen: 'empty',
    }).catch((e: unknown) => e);
    expect(isGitOutputLostError(error)).toBe(true);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();

    noteRunnerRecovered('test');
    expect(shouldRouteViaRunner(repo)).toBe(false);
  });

  it('relays bytes untouched in buffer mode', async () => {
    const repo = initRepo('repo');
    noteRunnerRecovered('test');
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]); // "你好\n" in GBK
    runnerAnswers.set('show', gbk);

    const { stdout } = await readGitBuffer({
      what: 'show',
      workdir: repo,
      args: ['show', 'HEAD:f0.txt'],
      lostWhen: 'never',
    });

    expect(stdout.equals(gbk)).toBe(true);
    expect(runnerCalls('show')[0]).toMatchObject({ encoding: 'buffer' });
  });
});

describe('getLog (history): an empty first page is a loss, an empty later page is not', () => {
  it('recovers a lost first page and parses it exactly like the primary path', async () => {
    const repo = initRepo('repo', 3);
    const primary = await new GitService(repo).getLog(30);
    expect(primary).toHaveLength(3);

    losePrimary('log');
    const args = ['log', '-n30', `--pretty=format:${GIT_LOG_PRETTY_FORMAT}`];
    runnerAnswers.set('log', git(repo, ...args));
    const recovered = await new GitService(repo).getLog(30);

    expect(runnerCalls('log').map((call) => call.args)).toEqual([args]);
    expect(recovered).toEqual(primary);
  });

  it('throws "output was lost" when the runner loses the page too', async () => {
    const repo = initRepo('repo');
    losePrimary('log');
    const error = await new GitService(repo).getLog(30).catch((e: unknown) => e);
    expect(isGitOutputLostError(error)).toBe(true);
  });

  it('returns [] for a page past the end without asking the runner', async () => {
    const repo = initRepo('repo', 2);
    await expect(new GitService(repo).getLog(30, 30)).resolves.toEqual([]);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('returns [] for an unborn repository without asking the runner', async () => {
    const repo = initRepo('unborn', 0);
    await expect(new GitService(repo).getLog(30)).resolves.toEqual([]);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('still fails outside a repository instead of reporting no commits', async () => {
    await expect(new GitService(root).getLog(30)).rejects.toBeInstanceOf(GitCommandError);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('recognizes an unborn HEAD by exit code when git words it in another language', async () => {
    const repo = initRepo('unborn', 0);
    fakedCommands.set('log', { code: 128, stderr: "致命错误：您的当前分支 'main' 尚无任何提交\n" });
    await expect(new GitService(repo).getLog(30)).resolves.toEqual([]);
  });

  it('after a recovery, reads later pages through the runner instead of trusting an empty primary', async () => {
    const repo = initRepo('repo', 2);
    noteRunnerRecovered('test');
    runnerAnswers.set(
      'log',
      git(repo, 'log', '-n1', '--skip=1', `--pretty=format:${GIT_LOG_PRETTY_FORMAT}`)
    );

    const page = await new GitService(repo).getLog(1, 1);

    expect(page.map((entry) => entry.message)).toEqual(['commit 0']);
    expect(spawnedCommands.some((args) => args[0] === 'log')).toBe(false);
  });
});

describe('getFileChanges (changes list): lost status records fall back like getStatus', () => {
  const z = (records: string[]): string => records.map((record) => `${record}\0`).join('');
  const RECORDS = [
    '# branch.oid a137f7993853cd1a8c6b3f454fd4ce3d0e0ab671',
    '# branch.head main',
    '1 .M N... 100644 100644 100644 01058d844a98d293a3b03a8615a34700e4ed2be3 01058d844a98d293a3b03a8615a34700e4ed2be3 with space.txt',
    '2 R. N... 100644 100644 100644 6a69f92020f5df77af6e8813ff1232493383b708 6a69f92020f5df77af6e8813ff1232493383b708 R100 new name.txt',
    'old name.txt',
    '1 M. N... 100644 100644 100644 6e9f0da13f19b444ec3a9c3d6e795ad35c0554a2 0505b3b1df17e3fedbe98668cf073a5649215560 中文 文件.md',
    '1 .M N... 100644 100644 100644 6e9f0da13f19b444ec3a9c3d6e795ad35c0554a2 6e9f0da13f19b444ec3a9c3d6e795ad35c0554a2 node_modules/x/index.js',
    '? untracked 新.txt',
  ];

  it('recovers through the runner with the same command line and the shared parser', async () => {
    losePrimary('status');
    runnerAnswers.set('status', z(RECORDS));

    const result = await new GitService(root).getFileChanges();

    expect(runnerCalls('status').map((call) => call.args)).toEqual([
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'],
    ]);
    expect(result).toEqual({
      changes: [
        { path: 'with space.txt', status: 'M', staged: false },
        { path: 'new name.txt', status: 'R', staged: true, originalPath: 'old name.txt' },
        { path: '中文 文件.md', status: 'M', staged: true },
        { path: 'untracked 新.txt', status: 'U', staged: false },
      ],
      skippedDirs: ['node_modules'],
      truncated: false,
      truncatedLimit: undefined,
    });
  });

  it('throws "output was lost" when the runner loses it too', async () => {
    losePrimary('status');
    const error = await new GitService(root).getFileChanges().catch((e: unknown) => e);
    expect(isGitOutputLostError(error)).toBe(true);
    expect(runnerCalls('status')).toHaveLength(1);
  });

  it('reports a clean working tree as no changes without asking the runner', async () => {
    const repo = initRepo('clean');
    await expect(new GitService(repo).getFileChanges()).resolves.toEqual({
      changes: [],
      skippedDirs: undefined,
      truncated: false,
      truncatedLimit: undefined,
    });
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('reads real changes on the primary path with whole paths and renames the right way round', async () => {
    const repo = initRepo('changes');
    writeFileSync(path.join(repo, 'old name.txt'), 'rename me\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'add');
    renameSync(path.join(repo, 'old name.txt'), path.join(repo, 'new name.txt'));
    git(repo, 'add', '-A');
    writeFileSync(path.join(repo, 'f0.txt'), 'changed\n');
    mkdirSync(path.join(repo, '新 目录'));
    writeFileSync(path.join(repo, '新 目录', 'a.txt'), 'a\n');

    const { changes } = await new GitService(repo).getFileChanges();

    expect(changes).toEqual([
      { path: 'f0.txt', status: 'M', staged: false },
      { path: 'new name.txt', status: 'R', staged: true, originalPath: 'old name.txt' },
      { path: '新 目录/', status: 'U', staged: false },
    ]);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('after a recovery, skips the primary stream for status and file changes', async () => {
    noteRunnerRecovered('test');
    runnerAnswers.set('status', z(RECORDS));
    const service = new GitService(root);

    await service.getFileChanges();
    const status = await service.getStatus();

    expect(spawnedCommands.some((args) => args[0] === 'status')).toBe(false);
    expect(status.current).toBe('main');
    expect(runnerCalls('status')).toHaveLength(2);
  });
});

describe('WorktreeService.list (composer branch chip): an empty list is a loss', () => {
  it('recovers the listing through the runner', async () => {
    const repo = initRepo('repo');
    const primary = await new WorktreeService(repo).list();
    expect(primary).toMatchObject([{ path: repo, branch: 'main', isMainWorktree: true }]);

    losePrimary('worktree');
    runnerAnswers.set('worktree', git(repo, 'worktree', 'list', '--porcelain'));
    const recovered = await new WorktreeService(repo).list();

    expect(runnerCalls('worktree').map((call) => call.args)).toEqual([
      ['worktree', 'list', '--porcelain'],
    ]);
    expect(recovered).toEqual(primary);
  });

  it('throws "output was lost" instead of an empty list when the runner loses it too', async () => {
    const repo = initRepo('repo');
    losePrimary('worktree');
    const error = await new WorktreeService(repo).list().catch((e: unknown) => e);
    expect(isGitOutputLostError(error)).toBe(true);
  });

  it('fails a non-repository as git does, without asking the runner', async () => {
    await expect(new WorktreeService(root).list()).rejects.toBeInstanceOf(GitCommandError);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });
});

describe('checkout (branch switch): the outcome is read back, through the fallback', () => {
  function repoWithFeature(): string {
    const repo = initRepo('repo');
    git(repo, 'branch', 'feature');
    return repo;
  }

  it('switches on an ordinary machine without the runner', async () => {
    const repo = repoWithFeature();
    const service = new GitService(repo);

    await service.checkout('feature');

    expect(git(repo, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/feature');
    expect((await service.getStatus()).current).toBe('feature');
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('confirms the switch through the runner when the read-back output is lost', async () => {
    const repo = repoWithFeature();
    losePrimary('symbolic-ref');
    runnerAnswers.set('symbolic-ref', 'refs/heads/feature\n');

    await new GitService(repo).checkout('feature');

    expect(git(repo, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/feature');
    expect(runnerCalls('symbolic-ref').map((call) => call.args)).toEqual([
      ['symbolic-ref', '--quiet', 'HEAD'],
    ]);
  });

  it('fails when git reported success but HEAD did not move', async () => {
    const repo = repoWithFeature();
    const service = new GitService(repo);
    // simple-git resolves a non-zero exit whose stderr is empty: the switch
    // "succeeds" and nothing happened.
    (service as unknown as { git: { checkout: () => Promise<string> } }).git.checkout = async () =>
      '';

    await expect(service.checkout('feature')).rejects.toThrow(
      /checkout feature reported success, but HEAD is on main/
    );
  });

  it('keeps a successful checkout when HEAD cannot be read back on either path', async () => {
    const repo = repoWithFeature();
    losePrimary('symbolic-ref');

    await expect(new GitService(repo).checkout('feature')).resolves.toBeUndefined();
    expect(git(repo, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/feature');
  });

  it('does not demand a branch HEAD for a detached checkout', async () => {
    const repo = initRepo('repo', 2);
    const first = git(repo, 'rev-parse', 'HEAD~1').trim();

    await expect(new GitService(repo).checkout(first)).resolves.toBeUndefined();
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('confirms a remote branch checkout against the local tracking branch', async () => {
    const upstream = initRepo('upstream');
    git(upstream, 'branch', 'dev');
    const clone = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', upstream, clone]);

    await new GitService(clone).checkout('remotes/origin/dev');

    expect(git(clone, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/dev');
  });

  it('confirms a created branch the same way', async () => {
    const repo = initRepo('repo');
    losePrimary('symbolic-ref');
    runnerAnswers.set('symbolic-ref', 'refs/heads/topic\n');

    await new GitService(repo).createBranch('topic');

    expect(git(repo, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/topic');
    expect(runnerCalls('symbolic-ref')).toHaveLength(1);
  });
});

describe('getHeadSignature and commit details read through the same fallback', () => {
  it('recovers a lost rev-parse and for-each-ref into the primary signature', async () => {
    const repo = initRepo('repo');
    const primary = await new GitService(repo).getHeadSignature();

    losePrimary('rev-parse');
    runnerAnswers.set('rev-parse', git(repo, 'rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'));
    runnerAnswers.set(
      'for-each-ref',
      git(repo, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes')
    );
    const recovered = await new GitService(repo).getHeadSignature();

    expect(recovered).toEqual(primary);
    expect(primary.ref).toBe('refs/heads/main');
  });

  it('keeps the unborn answer (git exits non-zero) without asking the runner', async () => {
    const repo = initRepo('unborn', 0);
    await expect(new GitService(repo).getHeadSignature()).resolves.toMatchObject({
      head: null,
      ref: null,
    });
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('recovers the files of a commit when cat-file loses its output', async () => {
    const repo = initRepo('repo', 2);
    const hash = git(repo, 'rev-parse', 'HEAD').trim();
    const primary = await new GitService(repo).getCommitFiles(hash);
    expect(primary).toEqual([{ path: 'f1.txt', status: 'A' }]);

    spawnedCommands.length = 0;
    losePrimary('cat-file');
    runnerAnswers.set('cat-file', git(repo, 'cat-file', '-p', hash));
    runnerAnswers.set('show', git(repo, 'show', hash, '--name-status', '--pretty=format:%P'));
    const recovered = await new GitService(repo).getCommitFiles(hash);

    expect(recovered).toEqual(primary);
    // The cat-file recovery routed the follow-up show through the runner too.
    expect(spawnedCommands.some((args) => args[0] === 'show')).toBe(false);
  });

  it('reads blobs for diffs through the runner only after a recovery', async () => {
    const repo = initRepo('repo');
    writeFileSync(path.join(repo, 'empty.txt'), '');
    git(repo, 'add', 'empty.txt');
    git(repo, 'commit', '-q', '-m', 'empty file');

    // An empty blob is a real answer on an ordinary machine.
    await expect(gitShowBuffer(repo, 'HEAD:empty.txt')).resolves.toHaveLength(0);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();

    noteRunnerRecovered('test');
    runnerAnswers.set('show', Buffer.from('0\n'));
    const blob = await gitShowBuffer(repo, 'HEAD:f0.txt');
    expect(blob.toString()).toBe('0\n');
    expect(runnerCalls('show')[0]).toMatchObject({
      args: ['show', 'HEAD:f0.txt'],
      encoding: 'buffer',
    });
  });
});
