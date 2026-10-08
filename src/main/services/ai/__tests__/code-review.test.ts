import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-15 (decision 125): the code review streams from the shared
 * DSH host (`dshCompletionService`). The prompt, the 10 min deadline, the
 * chunk / complete / error callbacks and Stop are what they were; only the
 * engine changed.
 *
 * Decision 162: the repository reads go through the F3 lost-output fallback.
 * Real git runs on scratch repositories; the encrypted host is stood in for by
 * dropping the stdout of chosen primary commands (exit code and stderr stay
 * real, as they are there), and the node runner is stubbed — nothing here
 * starts node.
 */

const complete = vi.fn();
const cancel = vi.fn(() => true);

vi.mock('../../agent-host/DshCompletionService', () => ({
  dshCompletionService: { complete, cancel },
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

type RunnerOptions = { workdir: string; args: string[] };
/** `false`: the runner loses the output too. */
let runnerWorks = true;
const runner = vi.hoisted(() => ({
  NodeGitRunnerError:
    null as unknown as typeof import('../../git/nodeGitRunner').NodeGitRunnerError,
}));
/** A working runner runs git for real; git's own refusal comes back as `git-exit`. */
const runGitViaNodeMock = vi.fn(async (options: RunnerOptions) => {
  if (!runnerWorks) return { stdout: '', stderr: '' };
  try {
    const stdout = execFileSync('git', options.args, {
      cwd: options.workdir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '' };
  } catch (error) {
    const status = (error as { status?: number }).status ?? 1;
    throw new runner.NodeGitRunnerError(`exit ${status}`, 'git-exit', status, null);
  }
});
vi.mock('../../git/nodeGitRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../git/nodeGitRunner')>();
  runner.NodeGitRunnerError = actual.NodeGitRunnerError;
  return { ...actual, runGitViaNode: (options: RunnerOptions) => runGitViaNodeMock(options) };
});

const { startCodeReview, stopAllCodeReviews, stopCodeReview } = await import('../code-review');
const { resetGitReadFallbackForTests, shouldRouteViaRunner } = await import(
  '../../git/gitReadFallback'
);

let root: string;

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function initRepo(name: string): string {
  const repo = path.join(root, name);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  return repo;
}

/** One commit `feat: x` with `x`, then an uncommitted `+new line` in `x`. */
function changedRepo(): string {
  const repo = initRepo('repo');
  writeFileSync(path.join(repo, 'x'), 'old line\n');
  git(repo, 'add', 'x');
  git(repo, 'commit', '-q', '-m', 'feat: x');
  writeFileSync(path.join(repo, 'x'), 'old line\nnew line\n');
  return repo;
}

function callbacks() {
  return { onChunk: vi.fn(), onComplete: vi.fn(), onError: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(path.join(tmpdir(), 'aiclient-code-review-'));
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

describe('startCodeReview', () => {
  it('streams a code-review completion from the DSH host under the review id, then completes', async () => {
    const repo = changedRepo();
    complete.mockImplementationOnce(async (request: { onDelta: (text: string) => void }) => {
      request.onDelta('Looks ');
      request.onDelta('fine.');
      return { text: 'Looks fine.', model: 'gw/m1' };
    });
    const cb = callbacks();

    await startCodeReview({
      workdir: repo,
      language: 'English',
      reviewId: 'review-1',
      model: 'gw/m1',
      effort: 'medium',
      ...cb,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      operationId: 'review-1',
      purpose: 'code-review',
      model: 'gw/m1',
      effort: 'medium',
      timeoutMs: 600_000,
    });
    expect(request).not.toHaveProperty('cwd');
    expect(request.prompt).toContain('Always reply in English.');
    expect(request.prompt).toContain('diff --git a/x b/x');
    expect(request.prompt).toContain(' old line\n+new line');
    // No origin: the branch range fails and the last ten commits stand in.
    expect(request.prompt).toMatch(/[0-9a-f]{7,} feat: x/);
    expect(cb.onChunk.mock.calls).toEqual([['Looks '], ['fine.']]);
    expect(cb.onComplete).toHaveBeenCalledTimes(1);
    expect(cb.onError).not.toHaveBeenCalled();
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
  });

  it('asks nothing when there is nothing to review', async () => {
    const repo = initRepo('unborn');
    const cb = callbacks();

    await startCodeReview({ workdir: repo, language: 'English', reviewId: 'r', ...cb });

    expect(cb.onError).toHaveBeenCalledWith('No changes to review');
    expect(complete).not.toHaveBeenCalled();
  });

  it('reports a failed or unreachable engine through onError, as the panel shows it', async () => {
    const repo = changedRepo();
    complete.mockRejectedValueOnce(
      new Error('CREDENTIALS_UNAVAILABLE: the engine asked for the key and got none')
    );
    const cb = callbacks();

    await startCodeReview({ workdir: repo, language: 'English', reviewId: 'r2', ...cb });

    expect(cb.onError).toHaveBeenCalledWith(
      'CREDENTIALS_UNAVAILABLE: the engine asked for the key and got none'
    );
    expect(cb.onComplete).not.toHaveBeenCalled();
  });

  it('Stop cancels the running review by its id, and quit cancels every running one', async () => {
    const repo = changedRepo();
    let release!: () => void;
    complete.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          release = () =>
            reject(Object.assign(new Error('cancelled'), { code: 'COMPLETION_CANCELLED' }));
        })
    );
    const cb = callbacks();

    const running = startCodeReview({
      workdir: repo,
      language: '中文',
      reviewId: 'review-9',
      ...cb,
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    stopAllCodeReviews();
    expect(cancel).toHaveBeenCalledWith('review-9');
    stopCodeReview('review-9');
    expect(cancel).toHaveBeenCalledTimes(2);
    release();
    await running;
    expect(cb.onError).toHaveBeenCalledWith('cancelled');
    // Settled: nothing is left for quit to cancel.
    cancel.mockClear();
    stopAllCodeReviews();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('startCodeReview on the encrypted host (F3, decision 162)', () => {
  it('recovers a lost diff and history through the node runner', async () => {
    const repo = changedRepo();
    lostStdout.add('diff');
    lostStdout.add('log');
    complete.mockResolvedValueOnce({ text: 'ok' });
    const cb = callbacks();

    await startCodeReview({ workdir: repo, language: 'English', reviewId: 'r3', ...cb });

    expect(cb.onError).not.toHaveBeenCalled();
    const prompt: string = complete.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain(' old line\n+new line');
    expect(prompt).toMatch(/[0-9a-f]{7,} feat: x/);
    expect(prompt).not.toContain('(No diff available)');
    expect(shouldRouteViaRunner(repo)).toBe(true);
  });

  it('says it could not read the changes instead of reviewing none', async () => {
    const repo = changedRepo();
    lostStdout.add('diff');
    runnerWorks = false;
    const cb = callbacks();

    await startCodeReview({ workdir: repo, language: 'English', reviewId: 'r4', ...cb });

    expect(cb.onError).toHaveBeenCalledWith(
      expect.stringMatching(/^Could not read the changes to review: .*output was lost/)
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('takes a clean tree as no diff without the runner or the switch', async () => {
    const repo = changedRepo();
    git(repo, 'checkout', '-q', '--', 'x');
    complete.mockResolvedValueOnce({ text: 'ok' });
    const cb = callbacks();

    await startCodeReview({ workdir: repo, language: 'English', reviewId: 'r5', ...cb });

    expect(complete.mock.calls[0]?.[0].prompt).toContain('(No diff available)');
    expect(runGitViaNodeMock).not.toHaveBeenCalled();
    expect(shouldRouteViaRunner(repo)).toBe(false);
  });
});
