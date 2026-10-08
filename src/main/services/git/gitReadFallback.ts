import { existsSync } from 'node:fs';
import {
  GitOutputLostError,
  NODE_GIT_RUNNER_MAX_BUFFER,
  NodeGitRunnerError,
  runGitViaNode,
} from './nodeGitRunner';
import { createGitEnv, isWslGitRepository, spawnGit } from './runtime';

/**
 * F3, shared by every git READ in `GitService`, `WorktreeService`,
 * `encoding.gitShow`, `checkIgnore` and the AI commit-message / code-review
 * diffs (`services/ai`).
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
 *
 * ## Failures that are not answers
 *
 * A read that could not finish — timed out, outgrew `maxBytes` (or the
 * runner's buffer), lost its output on both paths, or had no directory to run
 * in — rejects with its own type (`isGitReadTimeout`, `isGitOutputTooLarge`,
 * `GitWorkdirMissingError`), never with an empty answer: callers that turn
 * git's "no" into an empty value (`isGitExitError`) must not turn these into
 * one too.
 */

/** Same budget as simple-git's block timeout in `createSimpleGit`. */
export const GIT_READ_TIMEOUT_MS = 30_000;

/**
 * Blob reads (`git show <rev>:<path>`) for the diff and conflict views. Before
 * F3 they had no deadline at all; 30 s cut off a large file on a slow
 * (encrypted, relayed) disk, so they get a generous one rather than none: a
 * git that never exits still frees its slot. The size cap is the runner's
 * buffer on both paths, so a file is "too large" on every machine alike.
 */
export const GIT_BLOB_READ_TIMEOUT_MS = 120_000;
export const GIT_BLOB_MAX_BYTES = NODE_GIT_RUNNER_MAX_BUFFER;

const STDERR_CAPTURE_LIMIT = 8192;

/** A git command that ran and failed (non-zero exit), timed out or was killed. */
export class GitCommandError extends Error {
  /** `null` when git did not exit on its own (timeout, signal). */
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly reason: 'exit' | 'timeout' | 'signal';

  constructor(
    message: string,
    exitCode: number | null,
    stderr: string,
    reason: 'exit' | 'timeout' | 'signal' = exitCode === null ? 'signal' : 'exit'
  ) {
    super(message);
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.reason = reason;
  }
}

export const GIT_OUTPUT_TOO_LARGE = 'GIT_OUTPUT_TOO_LARGE';

/** The primary path stopped git once its stdout passed the read's `maxBytes`. */
export class GitOutputTooLargeError extends Error {
  readonly code = GIT_OUTPUT_TOO_LARGE;
  readonly limitBytes: number;

  constructor(message: string, limitBytes: number) {
    super(message);
    this.limitBytes = limitBytes;
  }
}

export const GIT_WORKDIR_MISSING = 'GIT_WORKDIR_MISSING';

/**
 * Git could not start because its working directory does not exist (a
 * submodule that was never checked out, a deleted worktree). Node reports that
 * as `spawn git ENOENT`, which reads as "git is not installed".
 */
export class GitWorkdirMissingError extends Error {
  readonly code = GIT_WORKDIR_MISSING;
  readonly workdir: string;

  constructor(workdir: string) {
    super(`git cannot run in ${workdir}: the directory does not exist`);
    this.workdir = workdir;
  }
}

/** git's own stderr for a failed run (`isGitExitError`), on either path. */
export function gitExitStderr(error: unknown): string {
  if (error instanceof GitCommandError || error instanceof NodeGitRunnerError) {
    return error.stderr.trim();
  }
  return '';
}

/** The read outgrew its cap, on either path. */
export function isGitOutputTooLarge(error: unknown): boolean {
  if (error instanceof GitOutputTooLargeError) return true;
  return error instanceof NodeGitRunnerError && error.failure === 'max-buffer';
}

/** The read hit its deadline, on either path. */
export function isGitReadTimeout(error: unknown): boolean {
  if (error instanceof GitCommandError) return error.reason === 'timeout';
  return error instanceof NodeGitRunnerError && error.failure === 'timeout';
}

/**
 * A spawn failure, explained: `ENOENT` for a directory that is not there is
 * the directory's fault, not git's. Anything else is returned unchanged.
 */
export function explainGitSpawnError(error: unknown, workdir: string): unknown {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' && !existsSync(workdir)) return new GitWorkdirMissingError(workdir);
  return error;
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
  inFlightRunnerReads.clear();
}

// ---- the runner, logged ------------------------------------------------------

type RunnerCall = {
  what: string;
  workdir: string;
  args: string[];
  timeoutMs?: number;
  maxBytes?: number;
  /** `false`: never join (or be joined by) another run; see `shareRunnerRead`. */
  share?: boolean;
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

/**
 * The runner's own spawn failure (`git-spawn`) has the same blind spot as the
 * primary path: a missing directory reads as a missing git.
 */
function explainRunnerFailure(error: unknown, workdir: string): unknown {
  if (error instanceof NodeGitRunnerError && error.failure === 'git-spawn') {
    if (!existsSync(workdir)) return new GitWorkdirMissingError(workdir);
  }
  return error;
}

function runnerOptions(call: RunnerCall) {
  return {
    workdir: call.workdir,
    args: call.args,
    env: createGitEnv(call.workdir),
    ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
    ...(call.maxBytes !== undefined ? { maxBuffer: call.maxBytes } : {}),
  };
}

/**
 * Identical runner reads in flight share one node.exe. The git panel's two
 * 5 s polls (`getStatus`, `getFileChanges`) run the same `git status` command
 * line on the same tick; once a host routes through the runner, each would
 * otherwise start its own node.exe for the same answer.
 *
 * Nothing is cached past the run, but a caller that joins gets the answer of a
 * run that started before it asked, so it can be older than the answer of a
 * run of its own. For a poll that is the same answer a moment late. For a read
 * that decides or confirms a write it can be the state from before that write
 * (a status taken before an `add` + `commit` marks a just-committed file
 * untracked and `discard` deletes it; a HEAD read from before a commit reports
 * that HEAD did not move). Those reads pass `share: false`: they neither join
 * a run in flight nor let a later caller join theirs. They are `discard`'s and
 * `discardSubmodule`'s status, the HEAD reads before and after a commit or
 * merge (`readHeadCommit`), the checkout read-back (`confirmHeadOnBranch`),
 * and in `WorktreeService.merge` / `continueMerge` the worktree list, the
 * clean checks and the conflict checks.
 */
const inFlightRunnerReads = new Map<string, Promise<string | Buffer>>();

function shareRunnerRead<T extends string | Buffer>(
  call: RunnerCall,
  encoding: 'utf8' | 'buffer',
  start: () => Promise<T>
): Promise<T> {
  if (call.share === false) return start();
  const key = JSON.stringify([
    encoding,
    call.workdir,
    call.args,
    call.timeoutMs ?? null,
    call.maxBytes ?? null,
  ]);
  const running = inFlightRunnerReads.get(key);
  if (running) return running as Promise<T>;
  const shared = start().finally(() => {
    inFlightRunnerReads.delete(key);
  });
  inFlightRunnerReads.set(key, shared);
  return shared;
}

/** `git <args>` through the runner, as text. Rejects with `NodeGitRunnerError`. */
export function runGitTextViaRunner(call: RunnerCall): Promise<string> {
  return shareRunnerRead(call, 'utf8', async () => {
    try {
      const { stdout } = await runGitViaNode(runnerOptions(call));
      return stdout;
    } catch (error) {
      logRunnerFailure(call.what, error);
      throw explainRunnerFailure(error, call.workdir);
    }
  });
}

function runGitBufferViaRunner(call: RunnerCall): Promise<Buffer> {
  return shareRunnerRead(call, 'buffer', async () => {
    try {
      const { stdout } = await runGitViaNode({ ...runnerOptions(call), encoding: 'buffer' });
      return stdout;
    } catch (error) {
      logRunnerFailure(call.what, error);
      throw explainRunnerFailure(error, call.workdir);
    }
  });
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
function captureGit(
  workdir: string,
  args: string[],
  timeoutMs: number,
  maxBytes?: number
): Promise<CapturedGit> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawnGit>;
    try {
      proc = spawnGit(workdir, args, {
        cwd: workdir,
        env: createGitEnv(workdir),
        windowsHide: true,
      });
    } catch (error) {
      reject(explainGitSpawnError(error, workdir));
      return;
    }

    const chunks: Buffer[] = [];
    let byteLength = 0;
    let stderr = '';
    let timedOut = false;
    let tooLarge = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (!proc.killed) proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      byteLength += chunk.length;
      if (maxBytes !== undefined && byteLength > maxBytes) {
        // Stop reading and stop git: the answer is "too large", not its prefix.
        tooLarge = true;
        chunks.length = 0;
        if (!proc.killed) proc.kill('SIGKILL');
        return;
      }
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
      reject(explainGitSpawnError(error, workdir));
    });
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const command = args[0] ?? '';
      if (tooLarge && maxBytes !== undefined) {
        reject(
          new GitOutputTooLargeError(`git ${command} output exceeded ${maxBytes} bytes`, maxBytes)
        );
        return;
      }
      if (timedOut) {
        reject(
          new GitCommandError(
            `git ${command} timed out after ${timeoutMs}ms`,
            null,
            stderr,
            'timeout'
          )
        );
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
  /**
   * Cap on stdout, on both paths (the runner's buffer otherwise). Beyond it the
   * read rejects as too large (`isGitOutputTooLarge`) instead of answering.
   */
  maxBytes?: number;
  /**
   * `false` for a read that decides or confirms a write: through the runner it
   * always runs on its own instead of joining an identical run already in
   * flight, which may have started before the write (`shareRunnerRead`).
   */
  share?: boolean;
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

  const primary = await captureGit(
    spec.workdir,
    spec.args,
    spec.timeoutMs ?? GIT_READ_TIMEOUT_MS,
    spec.maxBytes
  );
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
