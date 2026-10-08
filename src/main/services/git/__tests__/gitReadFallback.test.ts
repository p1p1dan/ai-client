import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

/** `hang`: never exits on its own (only a kill ends it). */
type FakeGit = { stdout?: string | Buffer; stderr?: string; code?: number; hang?: boolean };

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

type RunnerOptions = {
  workdir: string;
  args: string[];
  encoding?: 'buffer';
  timeoutMs?: number;
  maxBuffer?: number;
};
type RunnerResult = string | Buffer | Error;
type RunnerAnswer =
  | RunnerResult
  | ((options: RunnerOptions) => RunnerResult | Promise<RunnerResult>);
const runnerAnswers = new Map<string, RunnerAnswer>();
/** A working runner: `git <args>` for real, in the requested directory. */
const RUN_REAL_GIT = (options: RunnerOptions): RunnerResult => {
  try {
    return execFileSync('git', options.args, {
      cwd: options.workdir,
      env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.encoding === 'buffer' ? {} : { encoding: 'utf8' as const }),
    });
  } catch (error) {
    const e = error as { status?: number; stderr?: Buffer | string };
    const stderr = String(e.stderr ?? '');
    return new NodeGitRunnerError(
      `git ${options.args[0]} via the node runner failed: exit ${e.status}: ${stderr.trim()}`,
      'git-exit',
      e.status ?? 1,
      null,
      stderr.trim()
    );
  }
};
const runGitViaNodeMock = vi.fn(async (options: RunnerOptions) => {
  const configured = runnerAnswers.get(options.args[0] ?? '') ?? '';
  const answer = typeof configured === 'function' ? await configured(options) : configured;
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

const { GitService, resolveDiscardTarget } = await import('../GitService');
const { WorktreeService } = await import('../WorktreeService');
const { GIT_BLOB_READ_TIMEOUT, GIT_BLOB_TOO_LARGE, gitShowBuffer } = await import('../encoding');
const { readIgnoredPaths } = await import('../checkIgnore');
const { createGitEnv } = await import('../runtime');
const { GIT_LOG_PRETTY_FORMAT } = await import('../gitLogFormat');
const { NodeGitRunnerError, isGitOutputLostError } = await import('../nodeGitRunner');
const {
  GIT_BLOB_MAX_BYTES,
  GIT_BLOB_READ_TIMEOUT_MS,
  GitCommandError,
  GitWorkdirMissingError,
  isGitOutputTooLarge,
  isGitReadTimeout,
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
    if (proc.killed) return true;
    proc.killed = true;
    proc.emit('close', null, signal ?? 'SIGTERM');
    return true;
  };
  setTimeout(() => {
    if (result.stdout?.length) proc.stdout.emit('data', Buffer.from(result.stdout));
    if (result.stderr) proc.stderr.emit('data', Buffer.from(result.stderr));
    if (!proc.killed && !result.hang) proc.emit('close', result.code ?? 0, null);
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

// ---- decision 162: the follow-up reads and failure kinds --------------------

const z = (records: string[]): string => records.map((record) => `${record}\0`).join('');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function runnerFailure(failure: 'max-buffer' | 'timeout' | 'node-spawn' | 'git-spawn') {
  const code =
    failure === 'max-buffer'
      ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      : failure === 'node-spawn'
        ? 'ENOENT'
        : failure === 'git-spawn'
          ? 127
          : null;
  return new NodeGitRunnerError(`runner failed: ${failure}`, failure, code, null);
}

describe('readGit failure kinds: a read that could not finish is never an answer', () => {
  it('stops a primary read past maxBytes and fails it as too large, without the runner', async () => {
    const repo = initRepo('repo');
    const error = await readGitBuffer({
      what: 'show',
      workdir: repo,
      args: ['show', 'HEAD:f0.txt'],
      lostWhen: 'never',
      maxBytes: 1,
    }).catch((e: unknown) => e);

    expect(isGitOutputTooLarge(error)).toBe(true);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
    expect(shouldRouteViaRunner(repo)).toBe(false);
  });

  it('fails a primary read past its deadline as a timeout, without the runner', async () => {
    const repo = initRepo('repo');
    fakedCommands.set('log', { hang: true });
    const error = await readGit({
      what: 'log',
      workdir: repo,
      args: ['log', '-n1'],
      lostWhen: 'empty',
      timeoutMs: 20,
    }).catch((e: unknown) => e);

    expect(isGitReadTimeout(error)).toBe(true);
    expect(isGitOutputLostError(error)).toBe(false);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('explains a missing working directory instead of "spawn git ENOENT", on both paths', async () => {
    const missing = path.join(root, 'never-checked-out');
    const primary = await readGit({
      what: 'log',
      workdir: missing,
      args: ['log', '-n1'],
      lostWhen: 'empty',
    }).catch((e: unknown) => e);
    expect(primary).toBeInstanceOf(GitWorkdirMissingError);
    expect((primary as Error).message).toBe(
      `git cannot run in ${missing}: the directory does not exist`
    );

    noteRunnerRecovered('test');
    runnerAnswers.set('log', runnerFailure('git-spawn'));
    await expect(
      readGit({ what: 'log', workdir: missing, args: ['log', '-n1'], lostWhen: 'empty' })
    ).rejects.toBeInstanceOf(GitWorkdirMissingError);
  });

  it('names the missing submodule checkout when its history is asked for', async () => {
    const repo = initRepo('repo');
    await expect(new GitService(repo).getLog(30, 0, 'libs/absent')).rejects.toThrow(
      /libs[\\/]absent: the directory does not exist/
    );
  });

  it('shares one runner run between identical concurrent reads, and only while it runs', async () => {
    noteRunnerRecovered('test');
    runnerAnswers.set('status', async () => {
      await delay(20);
      return z(['# branch.oid abc', '# branch.head main', '? new.txt']);
    });
    const service = new GitService(root);

    const [status, changes] = await Promise.all([service.getStatus(), service.getFileChanges()]);

    expect(runnerCalls('status')).toHaveLength(1);
    expect(status).toMatchObject({ current: 'main', untracked: ['new.txt'] });
    expect(changes.changes).toEqual([{ path: 'new.txt', status: 'U', staged: false }]);

    await service.getStatus();
    expect(runnerCalls('status')).toHaveLength(2);
  });

  it('does not share runs of different command lines', async () => {
    const repo = initRepo('repo');
    noteRunnerRecovered('test');
    runnerAnswers.set('show', async () => {
      await delay(10);
      return Buffer.from('x');
    });

    await Promise.all([gitShowBuffer(repo, 'HEAD:f0.txt'), gitShowBuffer(repo, ':f0.txt')]);

    expect(runnerCalls('show')).toHaveLength(2);
  });

  it('never lets a share: false read join a run in flight, nor be joined', async () => {
    noteRunnerRecovered('test');
    let calls = 0;
    runnerAnswers.set('rev-parse', async () => {
      calls++;
      const answer = `run-${calls}\n`;
      await delay(20);
      return answer;
    });
    const spec = {
      what: 'rev-parse',
      workdir: root,
      args: ['rev-parse', '--verify', 'HEAD'],
      lostWhen: 'empty' as const,
    };

    const ownFirst = readGit({ ...spec, share: false });
    const poll = readGit(spec);
    const joiner = readGit(spec);
    const ownLater = readGit({ ...spec, share: false });

    expect((await ownFirst).stdout).toBe('run-1\n');
    expect((await poll).stdout).toBe('run-2\n');
    expect((await joiner).stdout).toBe('run-2\n');
    expect((await ownLater).stdout).toBe('run-3\n');
    expect(runnerCalls('rev-parse')).toHaveLength(3);
  });
});

describe('blob reads (diff and conflict views): only git saying "no" reads as empty', () => {
  it('returns empty for a path or stage absent from the revision, without the runner', async () => {
    const repo = initRepo('repo');
    await expect(gitShowBuffer(repo, 'HEAD:missing.txt')).resolves.toHaveLength(0);
    await expect(gitShowBuffer(repo, ':missing.txt')).resolves.toHaveLength(0);
    await expect(gitShowBuffer(repo, ':2:f0.txt')).resolves.toHaveLength(0);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('reads blobs with the blob deadline and size cap', async () => {
    const repo = initRepo('repo');
    noteRunnerRecovered('test');
    runnerAnswers.set('show', Buffer.from('0\n'));

    await gitShowBuffer(repo, 'HEAD:f0.txt');

    expect(runnerCalls('show')[0]).toMatchObject({
      timeoutMs: GIT_BLOB_READ_TIMEOUT_MS,
      maxBuffer: GIT_BLOB_MAX_BYTES,
    });
  });

  it('fails a blob over the cap on the primary path as too large, not as empty', async () => {
    const repo = initRepo('repo');
    fakedCommands.set('show', { stdout: Buffer.alloc(GIT_BLOB_MAX_BYTES + 1, 0x61) });

    const error = await gitShowBuffer(repo, 'HEAD:f0.txt').catch((e: unknown) => e);

    expect(error).toMatchObject({ code: GIT_BLOB_TOO_LARGE });
    expect((error as Error).message).toBe('GIT_BLOB_TOO_LARGE: HEAD:f0.txt is larger than 32 MB');
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('fails a blob over the runner buffer as too large, not as empty', async () => {
    const repo = initRepo('repo');
    noteRunnerRecovered('test');
    runnerAnswers.set('show', runnerFailure('max-buffer'));

    await expect(gitShowBuffer(repo, 'HEAD:f0.txt')).rejects.toMatchObject({
      code: GIT_BLOB_TOO_LARGE,
    });
  });

  it('fails a blob read that timed out as a timeout, not as empty', async () => {
    const repo = initRepo('repo');
    noteRunnerRecovered('test');
    runnerAnswers.set('show', runnerFailure('timeout'));

    const error = await gitShowBuffer(repo, 'HEAD:f0.txt').catch((e: unknown) => e);

    expect(error).toMatchObject({ code: GIT_BLOB_READ_TIMEOUT });
    expect((error as Error).message).toBe(
      'GIT_BLOB_READ_TIMEOUT: reading HEAD:f0.txt took longer than 120 s'
    );
  });

  it('surfaces a runner that could not start instead of an empty blob', async () => {
    const repo = initRepo('repo');
    noteRunnerRecovered('test');
    runnerAnswers.set('show', runnerFailure('node-spawn'));

    await expect(gitShowBuffer(repo, 'HEAD:f0.txt')).rejects.toBeInstanceOf(NodeGitRunnerError);
  });

  it('fails a staged diff whose blob is too large instead of showing the file as new', async () => {
    const repo = initRepo('repo');
    writeFileSync(path.join(repo, 'f0.txt'), 'staged\n');
    git(repo, 'add', 'f0.txt');
    noteRunnerRecovered('test');
    runnerAnswers.set('show', runnerFailure('max-buffer'));

    await expect(new GitService(repo).getFileDiff('f0.txt', true)).rejects.toThrow(
      /^GIT_BLOB_TOO_LARGE: /
    );
  });

  it('reads conflict stages as empty only when git says the stage is absent', async () => {
    const repo = initRepo('repo');
    const service = new WorktreeService(repo);
    await expect(service.getConflictContent(repo, 'f0.txt')).resolves.toEqual({
      file: 'f0.txt',
      ours: '',
      theirs: '',
      base: '',
    });

    noteRunnerRecovered('test');
    runnerAnswers.set('show', runnerFailure('node-spawn'));
    await expect(service.getConflictContent(repo, 'f0.txt')).rejects.toBeInstanceOf(
      NodeGitRunnerError
    );
  });
});

describe('blame, showCommit, getCommitDiff and getDiffStats on the spawnGit primary path', () => {
  it('blames a file on the primary path', async () => {
    const repo = initRepo('repo', 2);
    const first = git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim();

    const lines = await new GitService(repo).blame('f0.txt');

    expect(lines).toEqual([
      expect.objectContaining({ hash: first, author: 'Test', message: 'commit 0', lineNumber: 1 }),
    ]);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('maps git refusing to blame to "git blame failed: <stderr>", on both paths', async () => {
    const repo = initRepo('repo');
    await expect(new GitService(repo).blame('nope.txt')).rejects.toThrow(
      /^git blame failed: .*nope\.txt/
    );

    noteRunnerRecovered('test');
    runnerAnswers.set('blame', RUN_REAL_GIT);
    await expect(new GitService(repo).blame('nope.txt')).rejects.toThrow(
      "git blame failed: fatal: no such path 'nope.txt' in HEAD"
    );
  });

  it('after a recovery, blames through the runner and parses it like the primary path', async () => {
    const repo = initRepo('repo', 2);
    const primary = await new GitService(repo).blame('f1.txt');

    noteRunnerRecovered('test');
    runnerAnswers.set('blame', RUN_REAL_GIT);
    spawnedCommands.length = 0;
    const recovered = await new GitService(repo).blame('f1.txt');

    expect(recovered).toEqual(primary);
    expect(spawnedCommands.some((args) => args[0] === 'blame')).toBe(false);
  });

  it('reports a runner that could not run, not a blame refusal', async () => {
    const repo = initRepo('repo');
    noteRunnerRecovered('test');
    runnerAnswers.set('blame', runnerFailure('node-spawn'));
    await expect(new GitService(repo).blame('f0.txt')).rejects.toBeInstanceOf(NodeGitRunnerError);
  });

  it('shows a commit on the primary path, recovers it when lost, fails when lost twice', async () => {
    const repo = initRepo('repo');
    const hash = git(repo, 'rev-parse', 'HEAD').trim();
    const primary = await new GitService(repo).showCommit(hash);
    expect(primary.startsWith(`${hash}\nTest\ntest@example.com\n`)).toBe(true);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();

    losePrimary('show');
    runnerAnswers.set('show', RUN_REAL_GIT);
    await expect(new GitService(repo).showCommit(hash)).resolves.toBe(primary);
    expect(shouldRouteViaRunner(repo)).toBe(true);

    resetGitReadFallbackForTests();
    runnerAnswers.set('show', '');
    await expect(new GitService(repo).showCommit(hash)).rejects.toSatisfy(isGitOutputLostError);
  });

  it('fails an unknown commit as git does, without the runner', async () => {
    const repo = initRepo('repo');
    const error = await new GitService(repo).showCommit('0'.repeat(40)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitCommandError);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('diffs a commit on the primary path: modified, added and binary files', async () => {
    const repo = initRepo('repo');
    writeFileSync(path.join(repo, 'f0.txt'), 'changed\n');
    writeFileSync(path.join(repo, 'added.txt'), 'new\n');
    writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'second');
    const hash = git(repo, 'rev-parse', 'HEAD').trim();
    const service = new GitService(repo);

    await expect(service.getCommitDiff(hash, 'f0.txt', 'M')).resolves.toEqual({
      path: 'f0.txt',
      original: '0\n',
      modified: 'changed\n',
    });
    await expect(service.getCommitDiff(hash, 'added.txt', 'A')).resolves.toEqual({
      path: 'added.txt',
      original: '',
      modified: 'new\n',
    });
    await expect(service.getCommitDiff(hash, 'blob.bin', 'A')).resolves.toMatchObject({
      isBinary: true,
    });
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('after a recovery, diffs a commit through the runner like the primary path', async () => {
    const repo = initRepo('repo');
    writeFileSync(path.join(repo, 'f0.txt'), 'changed\n');
    git(repo, 'commit', '-q', '-am', 'second');
    const hash = git(repo, 'rev-parse', 'HEAD').trim();
    const primary = await new GitService(repo).getCommitDiff(hash, 'f0.txt', 'M');

    noteRunnerRecovered('test');
    runnerAnswers.set('diff', RUN_REAL_GIT);
    runnerAnswers.set('show', RUN_REAL_GIT);
    spawnedCommands.length = 0;

    await expect(new GitService(repo).getCommitDiff(hash, 'f0.txt', 'M')).resolves.toEqual(primary);
    expect(spawnedCommands).toEqual([]);
  });

  it('fails a commit diff whose blob is too large instead of showing it as empty', async () => {
    const repo = initRepo('repo', 2);
    const hash = git(repo, 'rev-parse', 'HEAD').trim();
    noteRunnerRecovered('test');
    runnerAnswers.set('diff', '');
    runnerAnswers.set('show', runnerFailure('max-buffer'));

    await expect(new GitService(repo).getCommitDiff(hash, 'f1.txt', 'A')).rejects.toThrow(
      /^GIT_BLOB_TOO_LARGE: /
    );
  });

  it('counts diff stats on the primary path; no HEAD yet is zero, not a failure', async () => {
    const repo = initRepo('repo');
    writeFileSync(path.join(repo, 'f0.txt'), 'a\nb\n');
    await expect(new GitService(repo).getDiffStats()).resolves.toEqual({
      insertions: 2,
      deletions: 1,
    });
    const unborn = initRepo('unborn', 0);
    await expect(new GitService(unborn).getDiffStats()).resolves.toEqual({
      insertions: 0,
      deletions: 0,
    });
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('after a recovery, counts diff stats through the runner, and fails when it cannot run', async () => {
    const repo = initRepo('repo');
    noteRunnerRecovered('test');
    runnerAnswers.set('diff', ' 1 file changed, 3 insertions(+), 4 deletions(-)\n');
    await expect(new GitService(repo).getDiffStats()).resolves.toEqual({
      insertions: 3,
      deletions: 4,
    });

    runnerAnswers.set('diff', runnerFailure('node-spawn'));
    await expect(new GitService(repo).getDiffStats()).rejects.toBeInstanceOf(NodeGitRunnerError);
  });
});

describe('checkout read-back: slashed names and existing local branches', () => {
  it('confirms a branch whose name contains a slash, read back through the runner', async () => {
    const repo = initRepo('repo');
    git(repo, 'branch', 'feature/x');
    losePrimary('symbolic-ref');
    runnerAnswers.set('symbolic-ref', 'refs/heads/feature/x\n');

    await new GitService(repo).checkout('feature/x');

    expect(git(repo, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/feature/x');
    expect(runnerCalls('symbolic-ref')).toHaveLength(1);
  });

  it('fails a slashed switch that did not happen', async () => {
    const repo = initRepo('repo');
    git(repo, 'branch', 'feature/x');
    const service = new GitService(repo);
    (service as unknown as { git: { checkout: () => Promise<string> } }).git.checkout = async () =>
      '';

    await expect(service.checkout('feature/x')).rejects.toThrow(
      'git checkout feature/x reported success, but HEAD is on main'
    );
  });

  function cloneWith(...branches: string[]): string {
    const upstream = initRepo('upstream');
    for (const branch of branches) git(upstream, 'branch', branch);
    const clone = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', upstream, clone]);
    return clone;
  }

  it('switches a remote checkout onto the existing local branch and confirms it', async () => {
    const clone = cloneWith('dev');
    git(clone, 'branch', 'dev', 'origin/dev');
    losePrimary('symbolic-ref');
    runnerAnswers.set('symbolic-ref', 'refs/heads/dev\n');

    await new GitService(clone).checkout('remotes/origin/dev');

    expect(git(clone, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/dev');
    expect(git(clone, 'branch', '--list', 'dev*').trim().split('\n')).toHaveLength(1);
  });

  it('creates and confirms a slashed local branch for a slashed remote one', async () => {
    const clone = cloneWith('feature/y');

    await new GitService(clone).checkout('remotes/origin/feature/y');

    expect(git(clone, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/feature/y');
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'feature/y@{upstream}').trim()).toBe(
      'origin/feature/y'
    );
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('fails a remote checkout that left HEAD elsewhere, even when the local branch existed', async () => {
    const clone = cloneWith('dev');
    git(clone, 'branch', 'dev', 'origin/dev');
    const service = new GitService(clone);
    (service as unknown as { git: { checkout: () => Promise<string> } }).git.checkout = async () =>
      '';

    await expect(service.checkout('remotes/origin/dev')).rejects.toThrow(
      'git checkout remotes/origin/dev reported success, but HEAD is on main'
    );
  });
});

describe('commit: the new commit is read back from HEAD', () => {
  function stageChange(repo: string): void {
    writeFileSync(path.join(repo, 'f0.txt'), 'committed\n');
    git(repo, 'add', 'f0.txt');
  }

  it('returns the new commit on an ordinary machine without the runner', async () => {
    const repo = initRepo('repo');
    stageChange(repo);

    const hash = await new GitService(repo).commit('second');

    expect(git(repo, 'rev-parse', 'HEAD').trim().startsWith(hash)).toBe(true);
    expect(hash.length).toBeGreaterThan(0);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it("reads the hash back through the runner when simple-git's output was lost", async () => {
    const repo = initRepo('repo');
    stageChange(repo);
    const service = new GitService(repo);
    // simple-git takes the hash from stdout, which the encrypted host loses.
    (service as unknown as { git: { commit: () => Promise<unknown> } }).git.commit = async () => {
      git(repo, 'commit', '-q', '-m', 'second');
      return { commit: '' };
    };
    losePrimary('rev-parse');
    runnerAnswers.set('rev-parse', RUN_REAL_GIT);

    const hash = await service.commit('second');

    expect(hash).toBe(git(repo, 'rev-parse', 'HEAD').trim());
  });

  it('fails a commit that did not move HEAD (nothing to commit)', async () => {
    const repo = initRepo('repo');
    await expect(new GitService(repo).commit('nothing')).rejects.toThrow(
      'git commit reported success, but HEAD did not move (nothing was committed)'
    );
  });

  it('reads HEAD back on its own even when a HEAD read from before the commit is in flight', async () => {
    const repo = initRepo('repo');
    stageChange(repo);
    noteRunnerRecovered('test');
    const service = new GitService(repo);
    let staleNext = false;
    runnerAnswers.set('rev-parse', async (options) => {
      if (!staleNext) return RUN_REAL_GIT(options);
      staleNext = false;
      // Answered now, before the commit lands; delivered after it.
      const answer = RUN_REAL_GIT(options);
      await delay(50);
      return answer;
    });
    let stale: Promise<unknown> | undefined;
    (service as unknown as { git: { commit: () => Promise<unknown> } }).git.commit = async () => {
      // A poll asks for HEAD just before the commit lands.
      staleNext = true;
      stale = readGit({
        what: 'rev-parse',
        workdir: repo,
        args: ['rev-parse', '--verify', 'HEAD'],
        lostWhen: 'empty',
      });
      git(repo, 'commit', '-q', '-m', 'second');
      return { commit: '' };
    };

    const hash = await service.commit('second');

    expect(hash).toBe(git(repo, 'rev-parse', 'HEAD').trim());
    expect(runnerCalls('rev-parse')).toHaveLength(3);
    await stale;
  });

  it("keeps the commit's own result when HEAD cannot be read back on either path", async () => {
    const repo = initRepo('repo');
    stageChange(repo);
    losePrimary('rev-parse');

    const hash = await new GitService(repo).commit('second');

    expect(git(repo, 'rev-parse', 'HEAD').trim().startsWith(hash)).toBe(true);
  });
});

describe('discard: untracked or tracked is decided by a read that cannot pass for "none"', () => {
  function dirtyRepo(): string {
    const repo = initRepo('repo');
    writeFileSync(path.join(repo, 'f0.txt'), 'changed\n');
    writeFileSync(path.join(repo, 'new.txt'), 'new\n');
    mkdirSync(path.join(repo, 'fresh dir'));
    writeFileSync(path.join(repo, 'fresh dir', 'a.txt'), 'a\n');
    return repo;
  }
  const exists = (repo: string, file: string) => existsSync(path.join(repo, file));

  it('deletes untracked files and restores tracked ones on the primary path', async () => {
    const repo = dirtyRepo();

    await new GitService(repo).discard(['f0.txt', 'new.txt', 'fresh dir/a.txt']);

    expect(exists(repo, 'new.txt')).toBe(false);
    expect(exists(repo, 'fresh dir/a.txt')).toBe(false);
    expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('reads the status through the runner when the primary lost it', async () => {
    const repo = dirtyRepo();
    losePrimary('status');
    runnerAnswers.set('status', RUN_REAL_GIT);

    await new GitService(repo).discard(['f0.txt', 'new.txt']);

    expect(exists(repo, 'new.txt')).toBe(false);
    expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('touches nothing when the status cannot be read on either path', async () => {
    const repo = dirtyRepo();
    losePrimary('status');

    await expect(new GitService(repo).discard(['f0.txt', 'new.txt'])).rejects.toSatisfy(
      isGitOutputLostError
    );
    expect(exists(repo, 'new.txt')).toBe(true);
    expect(git(repo, 'diff', '--name-only').trim()).toBe('f0.txt');
  });

  /** `newdir/` is untracked; `.env` at the top is ignored. */
  function repoWithIgnoredSecret(): string {
    const repo = dirtyRepo();
    writeFileSync(path.join(repo, '.gitignore'), '.env\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'ignore');
    writeFileSync(path.join(repo, '.env'), 'secret\n');
    mkdirSync(path.join(repo, 'newdir'));
    writeFileSync(path.join(repo, 'newdir', 'x.txt'), 'x\n');
    return repo;
  }

  it('refuses a path through an untracked directory to an ignored file, touching nothing', async () => {
    const repo = repoWithIgnoredSecret();

    for (const target of ['newdir/../.env', './newdir/../.env', 'newdir/x/../../.env']) {
      await expect(new GitService(repo).discard(['f0.txt', target])).rejects.toThrow(
        `Invalid file path: path traversal detected - ${target}`
      );
    }
    await expect(new GitService(repo).discard(['../outside.txt'])).rejects.toThrow(
      'path traversal detected'
    );
    await expect(new GitService(repo).discard(['.'])).rejects.toThrow('Invalid file path');

    expect(readFileSync(path.join(repo, '.env'), 'utf8')).toBe('secret\n');
    expect(git(repo, 'diff', '--name-only').trim()).toBe('f0.txt');
    // Refused before git was asked anything.
    expect(spawnedCommands.filter((args) => args[0] === 'status')).toEqual([]);
  });

  it('never deletes an ignored file, nor anything in an untracked directory but the target', async () => {
    const repo = repoWithIgnoredSecret();
    writeFileSync(path.join(repo, 'newdir', 'keep.txt'), 'keep\n');

    // Not listed as untracked, so it goes to `git checkout`, which refuses it.
    await expect(new GitService(repo).discard(['.env'])).rejects.toThrow(/pathspec/);
    expect(exists(repo, '.env')).toBe(true);

    await new GitService(repo).discard(['newdir/x.txt']);
    expect(exists(repo, 'newdir/x.txt')).toBe(false);
    expect(exists(repo, 'newdir/keep.txt')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'restores a tracked "dir\\x.txt" next to an untracked "dir/" on POSIX instead of deleting it',
    async () => {
      const repo = initRepo('repo');
      writeFileSync(path.join(repo, 'dir\\x.txt'), 'committed\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'backslash');
      writeFileSync(path.join(repo, 'dir\\x.txt'), 'changed\n');
      mkdirSync(path.join(repo, 'dir'));
      writeFileSync(path.join(repo, 'dir', 'x.txt'), 'untracked\n');

      await new GitService(repo).discard(['dir\\x.txt']);

      expect(readFileSync(path.join(repo, 'dir\\x.txt'), 'utf8')).toBe('committed\n');
      expect(exists(repo, 'dir/x.txt')).toBe(true);
    }
  );

  it('names targets as git does: "\\" separates only on Windows, ".." never passes', () => {
    expect(resolveDiscardTarget('/repo', 'dir\\x.txt', path.posix)).toEqual({
      gitPath: 'dir\\x.txt',
      absolutePath: '/repo/dir\\x.txt',
    });
    expect(resolveDiscardTarget('/repo', './a//b.txt', path.posix).gitPath).toBe('a/b.txt');
    expect(resolveDiscardTarget('/repo', '/repo/a.txt', path.posix).gitPath).toBe('a.txt');
    expect(resolveDiscardTarget('/repo', 'nested/', path.posix).gitPath).toBe('nested/');
    expect(resolveDiscardTarget('/repo', '..a.txt', path.posix).gitPath).toBe('..a.txt');
    expect(resolveDiscardTarget('C:\\repo', 'dir\\x.txt', path.win32)).toEqual({
      gitPath: 'dir/x.txt',
      absolutePath: 'C:\\repo\\dir\\x.txt',
    });
    expect(resolveDiscardTarget('C:\\repo', 'nested\\', path.win32).gitPath).toBe('nested/');

    for (const [root, target, api] of [
      ['/repo', 'a/../b.txt', path.posix],
      ['/repo', '../repo/b.txt', path.posix],
      ['/repo', '/etc/passwd', path.posix],
      ['C:\\repo', 'newdir\\..\\.env', path.win32],
      ['C:\\repo', 'newdir/..\\.env', path.win32],
      ['C:\\repo', 'D:\\repo\\a.txt', path.win32],
    ] as const) {
      expect(() => resolveDiscardTarget(root, target, api)).toThrow('path traversal detected');
    }
    expect(() => resolveDiscardTarget('/repo', '', path.posix)).toThrow('Invalid file path');
  });

  /** 5001 tracked files under `build/` changed (listed before untracked ones), and `new.txt`. */
  function repoPastTheStatusCap(): { repo: string; built: string[] } {
    const repo = initRepo('repo');
    mkdirSync(path.join(repo, 'build'));
    const built = Array.from({ length: 5001 }, (_, i) => `build/b${i}.txt`);
    for (const file of built) writeFileSync(path.join(repo, file), 'committed\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'build');
    for (const file of built) writeFileSync(path.join(repo, file), 'changed\n');
    writeFileSync(path.join(repo, 'new.txt'), 'new\n');
    return { repo, built };
  }

  it('deletes an untracked file listed after 5000 tracked changes, alone and with all of them', async () => {
    const { repo, built } = repoPastTheStatusCap();
    // The changes list skips `build/`, so `new.txt` is what it shows.
    expect((await new GitService(repo).getStatus()).truncated).toBe(true);

    await new GitService(repo).discard(['new.txt']);
    expect(exists(repo, 'new.txt')).toBe(false);
    const ownStatus = spawnedCommands.filter((args) => args.includes('--untracked-files=all'));
    expect(ownStatus.at(-1)?.slice(-2)).toEqual(['--', 'new.txt']);

    // "Discard all": too many paths for one command line, so the whole status.
    writeFileSync(path.join(repo, 'new.txt'), 'new\n');
    spawnedCommands.length = 0;
    await new GitService(repo).discard([...built, 'new.txt']);
    expect(exists(repo, 'new.txt')).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const wholeStatus = spawnedCommands.filter((args) => args[0] === 'status');
    expect(wholeStatus).toEqual([
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
    ]);
  }, 60_000);

  it('runs its own status through the runner, never one already in flight', async () => {
    const repo = dirtyRepo();
    noteRunnerRecovered('test');
    let calls = 0;
    runnerAnswers.set('status', async (options) => {
      // Both in flight at once; apart when they finish, so the two checkouts
      // do not contend for the index lock.
      calls++;
      await delay(calls === 1 ? 20 : 150);
      return RUN_REAL_GIT(options);
    });
    const service = new GitService(repo);

    await Promise.all([service.discard(['f0.txt']), service.discard(['f0.txt'])]);

    expect(runnerCalls('status')).toHaveLength(2);
    expect(git(repo, 'diff', '--name-only').trim()).toBe('');
  });
});

describe('origin/HEAD, check-ignore and submodule reads go through the fallback', () => {
  it('recovers a lost origin/HEAD, and takes "not set" (exit 1) without the runner', async () => {
    const upstream = initRepo('upstream');
    const clone = path.join(root, 'clone');
    execFileSync('git', ['clone', '-q', upstream, clone]);

    losePrimary('symbolic-ref');
    runnerAnswers.set('symbolic-ref', 'refs/remotes/origin/main\n');
    await new GitService(clone).getBranches();
    expect(runnerCalls('symbolic-ref').map((call) => call.args)).toEqual([
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
    ]);
    expect(shouldRouteViaRunner(clone)).toBe(true);

    resetGitReadFallbackForTests();
    fakedCommands.clear();
    runGitViaNodeMock.mockClear();
    await new GitService(initRepo('no-remote')).getBranches();
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('marks ignored paths on the primary path, quoting nothing', async () => {
    const repo = initRepo('repo');
    writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n新*\n');

    await expect(
      readIgnoredPaths(repo, ['ignored.txt', 'f0.txt', '新 文件.txt', 'dir with space'])
    ).resolves.toEqual(new Set(['ignored.txt', '新 文件.txt']));
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('takes "none ignored" (exit 1) as an answer without the runner or the switch', async () => {
    const repo = initRepo('repo');
    await expect(readIgnoredPaths(repo, ['f0.txt'])).resolves.toEqual(new Set());
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
    expect(shouldRouteViaRunner(repo)).toBe(false);
  });

  it('recovers lost check-ignore output, and fails when the runner loses it too', async () => {
    const repo = initRepo('repo');
    writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
    losePrimary('-c');
    runnerAnswers.set('-c', RUN_REAL_GIT);

    await expect(readIgnoredPaths(repo, ['ignored.txt', 'f0.txt'])).resolves.toEqual(
      new Set(['ignored.txt'])
    );
    expect(shouldRouteViaRunner(repo)).toBe(true);

    resetGitReadFallbackForTests();
    runnerAnswers.set('-c', '');
    await expect(readIgnoredPaths(repo, ['ignored.txt'])).rejects.toSatisfy(isGitOutputLostError);
  });

  function repoWithSubmodule(): string {
    const sub = initRepo('sub-upstream');
    const repo = initRepo('repo');
    execFileSync(
      'git',
      ['-C', repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'libs/sub'],
      { env: { ...process.env, LC_ALL: 'C' } }
    );
    git(repo, 'commit', '-q', '-m', 'add submodule');
    return repo;
  }

  it('lists submodules on the primary path and recovers the listing when lost', async () => {
    const repo = repoWithSubmodule();
    const primary = await new GitService(repo).listSubmodules();
    expect(primary).toMatchObject([
      { path: 'libs/sub', status: 'clean', initialized: true, branch: 'main' },
    ]);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();

    losePrimary('submodule');
    runnerAnswers.set('submodule', RUN_REAL_GIT);
    runnerAnswers.set('config', RUN_REAL_GIT);
    runnerAnswers.set('status', RUN_REAL_GIT);
    await expect(new GitService(repo).listSubmodules()).resolves.toEqual(primary);
  });

  it('fails the submodule listing when it is lost on both paths, instead of "no submodules"', async () => {
    const repo = repoWithSubmodule();
    losePrimary('submodule');
    await expect(new GitService(repo).listSubmodules()).rejects.toSatisfy(isGitOutputLostError);
  });

  it('lists no submodules for a repository without .gitmodules, without the runner', async () => {
    const repo = initRepo('repo');
    await expect(new GitService(repo).listSubmodules()).resolves.toEqual([]);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it("reads a submodule's changes and branches through the same status and branch readers", async () => {
    const repo = repoWithSubmodule();
    writeFileSync(path.join(repo, 'libs/sub', 'f0.txt'), 'changed in sub\n');
    const service = new GitService(repo);

    await expect(service.getSubmoduleChanges('libs/sub')).resolves.toEqual([
      { path: 'f0.txt', status: 'M', staged: false },
    ]);
    await expect(service.getSubmoduleBranches('libs/sub')).resolves.toContainEqual(
      expect.objectContaining({ name: 'main', current: true })
    );

    losePrimary('status');
    runnerAnswers.set('status', RUN_REAL_GIT);
    await expect(new GitService(repo).getSubmoduleChanges('libs/sub')).resolves.toEqual([
      { path: 'f0.txt', status: 'M', staged: false },
    ]);
    expect(runnerCalls('status')[0]?.workdir).toBe(path.join(repo, 'libs/sub'));

    resetGitReadFallbackForTests();
    runnerAnswers.set('status', '');
    await expect(new GitService(repo).getSubmoduleChanges('libs/sub')).rejects.toSatisfy(
      isGitOutputLostError
    );
  });

  it('lists no submodules for a stale .gitmodules (gitlink gone from the index), on both paths', async () => {
    const repo = repoWithSubmodule();
    git(repo, 'rm', '-q', '--cached', 'libs/sub');

    await expect(new GitService(repo).listSubmodules()).resolves.toEqual([]);
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
    expect(shouldRouteViaRunner(repo)).toBe(false);

    // Through the runner (a recovered host): still an answer, not a loss.
    noteRunnerRecovered('test');
    runnerAnswers.set('submodule', RUN_REAL_GIT);
    runnerAnswers.set('config', RUN_REAL_GIT);
    await expect(new GitService(repo).listSubmodules()).resolves.toEqual([]);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('submodule'));
    expect(runnerCalls('submodule')).toHaveLength(1);
  });

  it('discards in a submodule like discard does, and refuses paths out of it', async () => {
    const repo = repoWithSubmodule();
    const sub = path.join(repo, 'libs/sub');
    writeFileSync(path.join(sub, 'f0.txt'), 'changed in sub\n');
    writeFileSync(path.join(sub, 'new.txt'), 'new\n');
    writeFileSync(path.join(repo, 'outside.txt'), 'outside\n');
    mkdirSync(path.join(sub, 'x'));
    const service = new GitService(repo);

    for (const target of ['x/../../../outside.txt', '../../outside.txt', 'x/../../..']) {
      await expect(service.discardSubmodule('libs/sub', [target])).rejects.toThrow(
        'path traversal detected'
      );
    }
    await expect(service.discardSubmodule('../..', ['f0.txt'])).rejects.toThrow(
      'path traversal detected'
    );
    expect(existsSync(path.join(repo, 'outside.txt'))).toBe(true);
    expect(existsSync(path.join(repo, 'f0.txt'))).toBe(true);
    expect(existsSync(path.join(sub, 'x'))).toBe(true);

    await service.discardSubmodule('libs/sub', ['f0.txt', 'new.txt']);
    expect(existsSync(path.join(sub, 'new.txt'))).toBe(false);
    expect(git(sub, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });
});

describe('WorktreeService merge reads: clean check, conflicts, merge state, merge commit', () => {
  function conflictedRepo(): string {
    const repo = initRepo('repo');
    git(repo, 'checkout', '-q', '-b', 'topic');
    writeFileSync(path.join(repo, 'f0.txt'), 'topic\n');
    git(repo, 'commit', '-q', '-am', 'topic');
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(path.join(repo, 'f0.txt'), 'main\n');
    git(repo, 'commit', '-q', '-am', 'main');
    try {
      git(repo, 'merge', 'topic');
    } catch {
      // The conflict is the point.
    }
    return repo;
  }

  it('reads conflicts and the merge state on the primary path', async () => {
    const repo = conflictedRepo();
    const service = new WorktreeService(repo);

    await expect(service.getConflicts(repo)).resolves.toEqual([
      { file: 'f0.txt', type: 'content' },
    ]);
    await expect(service.getMergeState(repo)).resolves.toEqual({
      inProgress: true,
      targetBranch: 'main',
      sourceBranch: 'topic',
      conflicts: [{ file: 'f0.txt', type: 'content' }],
    });
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('recovers the conflicts and merge state when their output is lost', async () => {
    const repo = conflictedRepo();
    const primary = await new WorktreeService(repo).getMergeState(repo);
    losePrimary('status');
    losePrimary('rev-parse');
    losePrimary('branch');
    runnerAnswers.set('status', RUN_REAL_GIT);
    runnerAnswers.set('rev-parse', RUN_REAL_GIT);
    runnerAnswers.set('branch', RUN_REAL_GIT);

    await expect(new WorktreeService(repo).getMergeState(repo)).resolves.toEqual(primary);
  });

  it('fails instead of reporting no conflicts when the status is lost on both paths', async () => {
    const repo = conflictedRepo();
    losePrimary('status');
    await expect(new WorktreeService(repo).getConflicts(repo)).rejects.toSatisfy(
      isGitOutputLostError
    );
    await expect(new WorktreeService(repo).getMergeState(repo)).rejects.toSatisfy(
      isGitOutputLostError
    );
  });

  it('reports no merge without the runner when MERGE_HEAD is absent', async () => {
    const repo = initRepo('repo');
    await expect(new WorktreeService(repo).getMergeState(repo)).resolves.toEqual({
      inProgress: false,
    });
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  function repoWithWorktree(): { repo: string; worktree: string } {
    const repo = initRepo('repo');
    const worktree = path.join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat', worktree);
    writeFileSync(path.join(worktree, 'feat.txt'), 'feat\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-q', '-m', 'feat');
    return { repo, worktree };
  }

  it('sees a dirty worktree before merging even when the status output is lost', async () => {
    const { repo, worktree } = repoWithWorktree();
    writeFileSync(path.join(worktree, 'feat.txt'), 'dirty\n');
    losePrimary('status');
    runnerAnswers.set('status', RUN_REAL_GIT);

    await expect(
      new WorktreeService(repo).merge({
        worktreePath: worktree,
        targetBranch: 'main',
        strategy: 'merge',
        autoStash: false,
      })
    ).resolves.toMatchObject({
      success: false,
      error: 'Worktree has uncommitted changes. Please commit or stash them first.',
    });
  });

  it('refuses to merge a worktree whose status cannot be read on either path', async () => {
    const { repo, worktree } = repoWithWorktree();
    losePrimary('status');
    await expect(
      new WorktreeService(repo).merge({
        worktreePath: worktree,
        targetBranch: 'main',
        strategy: 'merge',
        autoStash: false,
      })
    ).rejects.toSatisfy(isGitOutputLostError);
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('commit 0');
  });

  it("reads the merge commit back from HEAD when simple-git's log output is lost", async () => {
    const { repo, worktree } = repoWithWorktree();
    losePrimary('rev-parse');
    runnerAnswers.set('rev-parse', RUN_REAL_GIT);

    const result = await new WorktreeService(repo).merge({
      worktreePath: worktree,
      targetBranch: 'main',
      strategy: 'merge',
      autoStash: false,
    });

    expect(result).toMatchObject({ success: true, merged: true });
    expect(result.commitHash).toBe(git(repo, 'rev-parse', 'HEAD').trim());
  });
});
