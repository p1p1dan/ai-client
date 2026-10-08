import { GitOutputLostError, NodeGitRunnerError, runGitViaNode } from './nodeGitRunner';
import { createGitEnv, isWslGitRepository, spawnGit } from './runtime';

/**
 * F3, shared by every git READ in `GitService`, `WorktreeService` and
 * `encoding.gitShow`.
 *
 * On the encrypted Windows host (TSD driver) a git spawned directly by the
 * Electron Main process exits normally and its stderr and exit code come back
 * (field: `fatal: not a git repository` reached the renderer; the dsh.6 branch
 * fallback was driven by `rev-parse --verify HEAD`'s exit code), but its stdout
 * never arrives. The same command with the bundled node.exe as git's parent
 * (`nodeGitRunner`) delivers it.
 *
 * ## Judging "lost"
 *
 * An empty stdout is only evidence of loss when the command always prints on
 * success. Each read says which kind it is (`lostWhen`):
 * - `'empty'`: success always prints (worktree list, `cat-file -p`, the first
 *   `git log` page, `rev-parse HEAD`), so exit 0 with no output is a loss;
 * - `'never'`: an empty answer is legitimate (an empty blob, no diff, the page
 *   after the last commit), so the primary result is taken as is;
 * - a predicate, for answers that are only sometimes non-empty.
 * Non-zero exits are never losses: they are git's own answer.
 *
 * ## Routing after a recovery
 *
 * Once the runner has recovered output the primary path lost, this process is
 * on such a host: the loss is a property of Main being git's parent, not of
 * one repository or one command. From then on reads go straight through the
 * runner (`shouldRouteViaRunner`), which
 * - makes the `'never'` reads above correct there too (their empty primary
 *   answer cannot be told apart from a lost one), and
 * - stops paying a lost primary run before every poll.
 * The switch only flips on a demonstrated recovery (primary lost AND runner
 * delivered), so an ordinary machine never takes it. WSL repositories go
 * through wsl.exe, which the runner does not route; they never fall back.
 *
 * Writes (checkout, commit, add, ...) do not come here: their exit code and
 * stderr are delivered, which is all they report. Callers that need the
 * outcome of a write read it back through here (see `GitService.checkout`).
 */

/** Same budget as simple-git's block timeout in `createSimpleGit`. */
export const GIT_READ_TIMEOUT_MS = 30_000;

const STDERR_CAPTURE_LIMIT = 8192;

/** A git command that ran and failed (non-zero exit), timed out or was killed. */
export class GitCommandError extends Error {
  /** `null` when git did not exit on its own (timeout, signal). */
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Git ran and answered with a non-zero exit, on either path. Callers use this
 * to tell "git said no" (an unborn HEAD, a missing ref) from "we could not
 * get an answer" (lost output, a runner that failed to start).
 */
export function isGitExitError(error: unknown): boolean {
  if (error instanceof GitCommandError) return error.exitCode !== null;
  return error instanceof NodeGitRunnerError && error.failure === 'git-exit';
}

// ---- process-wide routing state ---------------------------------------------

let runnerRecoveredLostOutput = false;
const reportedRunnerReads = new Set<string>();

/** Whether reads in `workdir` should skip the primary path (see the header). */
export function shouldRouteViaRunner(workdir: string): boolean {
  return runnerRecoveredLostOutput && !isWslGitRepository(workdir);
}

/** The runner just delivered what the primary path lost: route reads through it. */
export function noteRunnerRecovered(what: string): void {
  if (runnerRecoveredLostOutput) return;
  runnerRecoveredLostOutput = true;
  console.warn(
    `[git-fallback] node runner recovered lost ${what} output; ` +
      'git reads go through the node runner from now on'
  );
}

/**
 * One line per kind of read, the first time the runner answers it: enough for
 * a field log to show which reads ran through the runner, without the line
 * per poll that the fallback used to write.
 */
export function noteRunnerRead(what: string, detail: string): void {
  if (reportedRunnerReads.has(what)) return;
  reportedRunnerReads.add(what);
  console.info(`[git-fallback] ${what} via node runner ok: ${detail}`);
}

export function noteLostOutput(what: string): void {
  console.warn(`[git-fallback] ${what} output lost; retrying via node runner`);
}

/** Test seam: the routing switch is process-wide state. */
export function resetGitReadFallbackForTests(): void {
  runnerRecoveredLostOutput = false;
  reportedRunnerReads.clear();
}

// ---- the runner, logged ------------------------------------------------------

type RunnerCall = {
  what: string;
  workdir: string;
  args: string[];
  timeoutMs?: number;
};

/**
 * Logs the failure kind and exit code of a runner that could not answer.
 * A plain git failure (`git-exit`) is git's own answer and already travels in
 * the thrown error; logging it would write a line for every missing ref.
 */
function logRunnerFailure(what: string, error: unknown): void {
  if (error instanceof NodeGitRunnerError && error.failure !== 'git-exit') {
    console.warn(
      `[git-fallback] ${what} via node runner failed: ${error.failure} exit=${error.exitCode}`
    );
  }
}

function runnerOptions(call: RunnerCall) {
  return {
    workdir: call.workdir,
    args: call.args,
    env: createGitEnv(call.workdir),
    ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
  };
}

/** `git <args>` through the runner, as text. Rejects with `NodeGitRunnerError`. */
export async function runGitTextViaRunner(call: RunnerCall): Promise<string> {
  try {
    const { stdout } = await runGitViaNode(runnerOptions(call));
    return stdout;
  } catch (error) {
    logRunnerFailure(call.what, error);
    throw error;
  }
}

async function runGitBufferViaRunner(call: RunnerCall): Promise<Buffer> {
  try {
    const { stdout } = await runGitViaNode({ ...runnerOptions(call), encoding: 'buffer' });
    return stdout;
  } catch (error) {
    logRunnerFailure(call.what, error);
    throw error;
  }
}

// ---- the primary path --------------------------------------------------------

type CapturedGit = { stdout: Buffer; stderr: string; exitCode: number };

/**
 * Run git the way Main always has (`spawnGit`: wsl.exe for WSL repositories,
 * the enhanced PATH and safe.directory env) and capture the whole stdout.
 * Unlike simple-git, a non-zero exit with an empty stderr is still reported as
 * that exit code — simple-git resolves it as success, which would make
 * `symbolic-ref --quiet` on a detached HEAD look like a lost answer.
 */
function captureGit(workdir: string, args: string[], timeoutMs: number): Promise<CapturedGit> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawnGit>;
    try {
      proc = spawnGit(workdir, args, {
        cwd: workdir,
        env: createGitEnv(workdir),
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const chunks: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (!proc.killed) proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length > STDERR_CAPTURE_LIMIT) return;
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const command = args[0] ?? '';
      if (timedOut) {
        reject(new GitCommandError(`git ${command} timed out after ${timeoutMs}ms`, null, stderr));
        return;
      }
      if (typeof code !== 'number') {
        reject(
          new GitCommandError(`git ${command} terminated by ${signal ?? 'a signal'}`, null, stderr)
        );
        return;
      }
      resolve({ stdout: Buffer.concat(chunks), stderr, exitCode: code });
    });
  });
}

/**
 * The exit code of `git <args>` on the primary path. Exit codes are delivered
 * even where stdout is lost, so a question git answers by exit code alone
 * (`rev-parse --verify --quiet`, `show-ref --verify --quiet`) needs no runner.
 */
export async function probeGitExitCode(
  workdir: string,
  args: string[],
  timeoutMs = GIT_READ_TIMEOUT_MS
): Promise<number> {
  const { exitCode } = await captureGit(workdir, args, timeoutMs);
  return exitCode;
}

// ---- reads -------------------------------------------------------------------

export type GitLostWhen<T> = 'empty' | 'never' | ((stdout: T) => boolean);

export type GitReadSpec<T> = {
  /** Short label for log lines, e.g. `log`, `worktree-list`. */
  what: string;
  /** The directory git runs in (a submodule's own directory for submodule reads). */
  workdir: string;
  /** The exact git arguments; both paths run the same command line. */
  args: string[];
  /** When a zero-exit stdout means the output was lost (see the header). */
  lostWhen: GitLostWhen<T>;
  /**
   * Non-zero exits that are answers rather than failures (`symbolic-ref
   * --quiet` exits 1 on a detached HEAD). They resolve with that exit code;
   * through the runner their stdout is not relayed and comes back empty.
   */
  okExitCodes?: readonly number[];
  timeoutMs?: number;
};

export type GitReadResult<T> = { stdout: T; exitCode: number };

type Codec<T> = {
  decode: (buffer: Buffer) => T;
  isEmpty: (stdout: T) => boolean;
  viaRunner: (call: RunnerCall) => Promise<T>;
};

const TEXT: Codec<string> = {
  decode: (buffer) => buffer.toString('utf8'),
  isEmpty: (stdout) => stdout.trim() === '',
  viaRunner: runGitTextViaRunner,
};

const BYTES: Codec<Buffer> = {
  decode: (buffer) => buffer,
  isEmpty: (stdout) => stdout.length === 0,
  viaRunner: runGitBufferViaRunner,
};

function isLost<T>(spec: GitReadSpec<T>, codec: Codec<T>, stdout: T): boolean {
  if (spec.lostWhen === 'never') return false;
  if (spec.lostWhen === 'empty') return codec.isEmpty(stdout);
  return spec.lostWhen(stdout);
}

function lostOutputError(spec: { args: string[] }, via: string): GitOutputLostError {
  return new GitOutputLostError(
    `git ${spec.args[0] ?? ''}${via} exited 0 without the output it always prints; ` +
      'its output was lost'
  );
}

async function readViaRunner<T>(
  spec: GitReadSpec<T>,
  codec: Codec<T>,
  afterLoss: boolean
): Promise<GitReadResult<T>> {
  let stdout: T;
  try {
    stdout = await codec.viaRunner(spec);
  } catch (error) {
    if (
      error instanceof NodeGitRunnerError &&
      error.failure === 'git-exit' &&
      typeof error.exitCode === 'number' &&
      spec.okExitCodes?.includes(error.exitCode)
    ) {
      return { stdout: codec.decode(Buffer.alloc(0)), exitCode: error.exitCode };
    }
    throw error;
  }
  if (isLost(spec, codec, stdout)) {
    console.warn(`[git-fallback] ${spec.what} via node runner lost its output too`);
    throw lostOutputError(spec, ' via the node runner');
  }
  if (afterLoss) noteRunnerRecovered(spec.what);
  noteRunnerRead(spec.what, `length=${(stdout as string | Buffer).length}`);
  return { stdout, exitCode: 0 };
}

async function readGitWith<T>(spec: GitReadSpec<T>, codec: Codec<T>): Promise<GitReadResult<T>> {
  if (shouldRouteViaRunner(spec.workdir)) return readViaRunner(spec, codec, false);

  const primary = await captureGit(spec.workdir, spec.args, spec.timeoutMs ?? GIT_READ_TIMEOUT_MS);
  if (primary.exitCode !== 0) {
    if (spec.okExitCodes?.includes(primary.exitCode)) {
      return { stdout: codec.decode(primary.stdout), exitCode: primary.exitCode };
    }
    throw new GitCommandError(
      primary.stderr.trim() || `git ${spec.args[0] ?? ''} failed (exit ${primary.exitCode})`,
      primary.exitCode,
      primary.stderr
    );
  }

  const stdout = codec.decode(primary.stdout);
  if (!isLost(spec, codec, stdout)) return { stdout, exitCode: 0 };
  if (isWslGitRepository(spec.workdir)) throw lostOutputError(spec, '');
  noteLostOutput(spec.what);
  return readViaRunner(spec, codec, true);
}

/**
 * Read `git <args>` as UTF-8 text with the F3 fallback. Rejects with
 * `GitCommandError` (primary: git failed), `NodeGitRunnerError` (runner) or
 * `GitOutputLostError` (both paths lost the output).
 */
export function readGit(spec: GitReadSpec<string>): Promise<GitReadResult<string>> {
  return readGitWith(spec, TEXT);
}

/** `readGit` for raw bytes (blob contents whose encoding the caller detects). */
export function readGitBuffer(spec: GitReadSpec<Buffer>): Promise<GitReadResult<Buffer>> {
  return readGitWith(spec, BYTES);
}
