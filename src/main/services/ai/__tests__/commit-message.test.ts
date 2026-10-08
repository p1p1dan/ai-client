import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-15 (decision 125): the commit message is a one-shot completion
 * on the shared DSH host (`dshCompletionService`). The prompt and the fence
 * stripping are what they were; only the engine changed.
 *
 * Decision 162: the repository reads go through the F3 lost-output fallback.
 * Real git runs on scratch repositories; the encrypted host is stood in for by
 * dropping the stdout of chosen primary commands (exit code and stderr stay
 * real, as they are there), and the node runner is stubbed — nothing here
 * starts node.
 */

const complete = vi.fn();

vi.mock('../../agent-host/DshCompletionService', () => ({
  dshCompletionService: { complete },
}));

// git/runtime -> terminal/PtyManager pulls the node-pty native module.
vi.mock('../../terminal/PtyManager', () => ({
  getEnhancedPath: () => process.env.PATH ?? '',
}));

/** Primary commands (by subcommand) whose stdout is lost. */
const lostStdout = new Set<string>();
const runtimeActual = vi.hoisted(() => ({
  spawnGit: null as unknown as (...args: unknown[]) => unknown,
}));
vi.mock('../../git/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git/runtime')>();
  runtimeActual.spawnGit = actual.spawnGit as (...args: unknown[]) => unknown;
  return {
    ...actual,
    spawnGit: (workdir: string, args: string[], options?: unknown) => {
      const proc = runtimeActual.spawnGit(workdir, args, options) as { stdout: PassThrough };
      if (lostStdout.has(args[0] ?? '')) {
        proc.stdout.resume();
        Object.defineProperty(proc, 'stdout', { value: new PassThrough(), configurable: true });
      }
      return proc;
    },
  };
});

type RunnerOptions = { workdir: string; args: string[]; maxBuffer?: number };
/** `false`: the runner loses the output too. */
let runnerWorks = true;
const runner = vi.hoisted(() => ({
  NodeGitRunnerError:
    null as unknown as typeof import('../../git/nodeGitRunner').NodeGitRunnerError,
}));
/**
 * A working runner runs git for real, within its buffer (32 MB unless the read
 * caps it); git's own refusal comes back as `git-exit`.
 */
const runGitViaNodeMock = vi.fn(async (options: RunnerOptions) => {
  if (!runnerWorks) return { stdout: '', stderr: '' };
  try {
    const stdout = execFileSync('git', options.args, {
      cwd: options.workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    });
    return { stdout, stderr: '' };
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOBUFS') {
      throw new runner.NodeGitRunnerError(
        'output exceeded the buffer',
        'max-buffer',
        'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        null
      );
    }
    const status = (error as { status?: number }).status ?? 1;
    throw new runner.NodeGitRunnerError(`exit ${status}`, 'git-exit', status, null);
  }
});
vi.mock('../../git/nodeGitRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git/nodeGitRunner')>();
  runner.NodeGitRunnerError = actual.NodeGitRunnerError;
  return { ...actual, runGitViaNode: (options: RunnerOptions) => runGitViaNodeMock(options) };
});

const { STAGED_DIFF_MAX_BYTES, STAGED_DIFF_TOO_LARGE_NOTE, generateCommitMessage } = await import(
  '../commit-message'
);
const { noteRunnerRecovered, resetGitReadFallbackForTests, shouldRouteViaRunner } = await import(
  '../../git/gitReadFallback'
);

let root: string;

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

/** Two commits (`fix: before`, then `feat: earlier`) and `a.ts` staged with three lines. */
function stagedRepo(): string {
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  for (const subject of ['fix: before', 'feat: earlier']) {
    git(repo, 'commit', '-q', '--allow-empty', '-m', subject);
  }
  writeFileSync(path.join(repo, 'a.ts'), 'one\ntwo\nthree\n');
  git(repo, 'add', 'a.ts');
  return repo;
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(path.join(tmpdir(), 'aiclient-commit-msg-'));
  resetGitReadFallbackForTests();
  lostStdout.clear();
  runnerWorks = true;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('generateCommitMessage', () => {
  it('asks the DSH host for a commit-message completion built from the staged diff', async () => {
    const repo = stagedRepo();
    complete.mockResolvedValueOnce({ text: '```\nfeat: add three lines\n```', model: 'gw/m1' });

    const result = await generateCommitMessage({
      workdir: repo,
      maxDiffLines: 2,
      timeout: 45,
      model: 'gw/m1',
      effort: 'off',
    });

    expect(result).toEqual({ success: true, message: 'feat: add three lines' });
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      purpose: 'commit-message',
      model: 'gw/m1',
      effort: 'off',
      timeoutMs: 45_000,
    });
    expect(Object.keys(request).sort()).toEqual([
      'effort',
      'model',
      'prompt',
      'purpose',
      'timeoutMs',
    ]);
    // The 1.0.x prompt: the recent subjects, the stat, the diff cut to maxDiffLines.
    expect(request.prompt).toContain('feat: earlier\nfix: before');
    expect(request.prompt).toContain('a.ts | 3 +++');
    expect(request.prompt).toContain('diff --git a/a.ts b/a.ts\nnew file mode 100644');
    expect(request.prompt).not.toContain('+one');
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('fills a custom template once, without re-reading placeholders from the diff', async () => {
    const repo = path.join(root, 'unborn');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(path.join(repo, 'x.txt'), '{recent_commits}\n');
    git(repo, 'add', 'x.txt');
    complete.mockResolvedValueOnce({ text: 'chore: x' });

    await generateCommitMessage(
      {
        workdir: repo,
        maxDiffLines: 10,
        timeout: 30,
        prompt: 'P: {staged_diff} | {recent_commits}',
      },
      { complete }
    );

    const prompt: string = complete.mock.calls[0]?.[0].prompt;
    expect(prompt.startsWith('P: diff --git a/x.txt b/x.txt\n')).toBe(true);
    expect(prompt).toContain('\n+{recent_commits} | (no recent commits)');
  });

  it('reports a timeout as `timeout`, which the commit box shows as "Generation timed out"', async () => {
    const repo = stagedRepo();
    complete.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'COMPLETION_TIMEOUT' })
    );

    const result = await generateCommitMessage({ workdir: repo, maxDiffLines: 10, timeout: 1 });

    expect(result).toEqual({ success: false, error: 'timeout' });
  });

  it('reports the engine’s failure as its coded sentence', async () => {
    const repo = stagedRepo();
    complete.mockRejectedValueOnce(
      new Error('DSH_HOST_UNAVAILABLE: the DSH host went down 4 times within 5 min')
    );

    const result = await generateCommitMessage({ workdir: repo, maxDiffLines: 10, timeout: 1 });

    expect(result).toEqual({
      success: false,
      error: 'DSH_HOST_UNAVAILABLE: the DSH host went down 4 times within 5 min',
    });
  });
});

describe('generateCommitMessage on the encrypted host (F3, decision 162)', () => {
  it('recovers a lost staged diff and history through the node runner', async () => {
    const repo = stagedRepo();
    lostStdout.add('diff');
    lostStdout.add('log');
    complete.mockResolvedValueOnce({ text: 'feat: three lines' });

    await generateCommitMessage({ workdir: repo, maxDiffLines: 50, timeout: 30 });

    const prompt: string = complete.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain('feat: earlier\nfix: before');
    expect(prompt).toContain('a.ts | 3 +++');
    expect(prompt).toContain('+one\n+two\n+three');
    expect(prompt).not.toContain('(no staged changes detected)');
    expect(runGitViaNodeMock.mock.calls.map(([options]) => options.args[0])).toContain('diff');
    expect(shouldRouteViaRunner(repo)).toBe(true);
  });

  it('says it could not read the staged changes instead of asking about none', async () => {
    const repo = stagedRepo();
    lostStdout.add('diff');
    runnerWorks = false;

    const result = await generateCommitMessage({ workdir: repo, maxDiffLines: 50, timeout: 30 });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Could not read the staged changes: .*output was lost/);
    expect(complete).not.toHaveBeenCalled();
  });

  it('takes "nothing staged" as an answer without the runner or the switch', async () => {
    const repo = stagedRepo();
    git(repo, 'reset', '-q');
    complete.mockResolvedValueOnce({ text: 'chore: nothing' });

    await generateCommitMessage({ workdir: repo, maxDiffLines: 50, timeout: 30 });

    expect(complete.mock.calls[0]?.[0].prompt).toContain('(no staged changes detected)');
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
    expect(shouldRouteViaRunner(repo)).toBe(false);
  });
});

describe('generateCommitMessage: subject-less history and oversized diffs', () => {
  it('reads a history of empty subjects as "no recent commits", not as lost output', async () => {
    const repo = path.join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    for (let i = 0; i < 2; i++) {
      git(repo, 'commit', '-q', '--allow-empty', '--allow-empty-message', '-m', '');
    }
    writeFileSync(path.join(repo, 'a.ts'), 'one\n');
    git(repo, 'add', 'a.ts');
    complete.mockResolvedValue({ text: 'feat: a' });

    const result = await generateCommitMessage({ workdir: repo, maxDiffLines: 50, timeout: 30 });

    expect(result).toEqual({ success: true, message: 'feat: a' });
    expect(complete.mock.calls[0]?.[0].prompt).toContain('参考风格：\n(no recent commits)\n');
    expect(runGitViaNodeMock).not.toHaveBeenCalled();

    // Mixed: the subjects that exist, without the hashes that carried them.
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'fix: named');
    await generateCommitMessage({ workdir: repo, maxDiffLines: 50, timeout: 30 });
    expect(complete.mock.calls[1]?.[0].prompt).toContain('参考风格：\nfix: named\n\n变更摘要');
  });

  /** `big.txt` staged, its diff a little over the cap. */
  function stagedBigFile(): string {
    const repo = stagedRepo();
    const line = `${'x'.repeat(99)}\n`;
    writeFileSync(
      path.join(repo, 'big.txt'),
      line.repeat(Math.ceil(STAGED_DIFF_MAX_BYTES / line.length) + 1000)
    );
    git(repo, 'add', 'big.txt');
    return repo;
  }

  it('writes the message from the stat when the staged diff is over the cap', async () => {
    const repo = stagedBigFile();
    complete.mockResolvedValueOnce({ text: 'feat: big' });

    const result = await generateCommitMessage({ workdir: repo, maxDiffLines: 50, timeout: 30 });

    expect(result).toEqual({ success: true, message: 'feat: big' });
    const prompt: string = complete.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain('big.txt | ');
    expect(prompt).toContain(STAGED_DIFF_TOO_LARGE_NOTE);
    expect(prompt).not.toContain('diff --git');
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('does the same through the runner, which is held to the same cap', async () => {
    const repo = stagedBigFile();
    noteRunnerRecovered('test');
    complete.mockResolvedValueOnce({ text: 'feat: big' });

    const result = await generateCommitMessage({ workdir: repo, maxDiffLines: 50, timeout: 30 });

    expect(result).toEqual({ success: true, message: 'feat: big' });
    expect(complete.mock.calls[0]?.[0].prompt).toContain(STAGED_DIFF_TOO_LARGE_NOTE);
    const diffRead = runGitViaNodeMock.mock.calls
      .map(([options]) => options)
      .find((options) => options.args.join(' ') === 'diff --cached');
    expect(diffRead?.maxBuffer).toBe(STAGED_DIFF_MAX_BYTES);
  });
});
