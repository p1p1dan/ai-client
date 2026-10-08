import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * F3: on the encrypted Windows host (TSD driver) git's stdout is lost when the
 * Electron Main process is git's parent, but arrives intact when the parent is
 * the bundled node.exe, which TSD whitelists (the same binary `tsdSafeRead`
 * relies on). This module runs one git command with that node.exe in between:
 *
 *   node -e <NODE_GIT_RUNNER_SCRIPT> -- <workdir> <git args...>
 *
 * Pure apart from the injected `exec`, and free of `./runtime` imports, so it
 * is testable without node-pty and without spawning anything.
 */

/** Stable marker for "git ran but its stdout never reached us". */
export const GIT_OUTPUT_LOST = 'GIT_OUTPUT_LOST';

export class GitOutputLostError extends Error {
  readonly code = GIT_OUTPUT_LOST;
}

export function isGitOutputLostError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === GIT_OUTPUT_LOST;
}

export type NodeGitRunnerFailure =
  | 'git-exit'
  | 'git-spawn'
  | 'node-spawn'
  | 'timeout'
  | 'signal'
  | 'max-buffer'
  | 'unknown';

export class NodeGitRunnerError extends Error {
  readonly failure: NodeGitRunnerFailure;
  readonly exitCode: number | string | null;
  readonly signal: string | null;
  /** git's stderr as relayed (capped like the message), for `git-exit`. */
  readonly stderr: string;

  constructor(
    message: string,
    failure: NodeGitRunnerFailure,
    exitCode: number | string | null,
    signal: string | null,
    stderr = ''
  ) {
    super(message);
    this.failure = failure;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr;
  }
}

/** Written to stderr by the inner script when git itself cannot be spawned. */
export const GIT_SPAWN_ERROR_MARKER = '__AICLIENT_NODE_GIT_SPAWN_ERROR__';
/** Exit code of the inner script when git could not be spawned. */
export const GIT_SPAWN_ERROR_EXIT_CODE = 127;

/**
 * Runs inside the bundled node: spawn git in argv[1] with argv[2..], relay
 * both streams byte for byte, and exit with git's code. `process.exitCode`
 * (not `process.exit`) lets piped stdout drain before node exits. A spawn
 * failure is tagged on stderr and exits 127, so it cannot pass for a git run
 * whose output was lost. Single quotes only: the script travels as one argv
 * entry through Windows command-line quoting.
 */
export const NODE_GIT_RUNNER_SCRIPT = [
  "const{spawn}=require('child_process');",
  'let failed=false;',
  `const fail=e=>{failed=true;process.stderr.write('${GIT_SPAWN_ERROR_MARKER} '+String((e&&e.code)||'unknown'));process.exitCode=${GIT_SPAWN_ERROR_EXIT_CODE};};`,
  'let g;',
  "try{g=spawn('git',process.argv.slice(2),{cwd:process.argv[1],windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(e){fail(e);}",
  'if(g){',
  "g.on('error',fail);",
  'g.stdout.pipe(process.stdout,{end:false});',
  'g.stderr.pipe(process.stderr,{end:false});',
  "g.on('close',c=>{if(!failed)process.exitCode=typeof c==='number'?c:1;});",
  '}',
].join('');

export const NODE_GIT_RUNNER_TIMEOUT_MS = 30_000;
export const NODE_GIT_RUNNER_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * The node that git is run under. Same resolution as
 * `tsdSafeRead.resolveDecryptingNode`: `AICLIENT_TSD_NODE_PATH` overrides,
 * then the bundled runtime on Windows (the binary whitelisting was verified
 * against), then PATH `node` for dev and other platforms.
 */
export function resolveBundledNode(): string {
  const override = process.env.AICLIENT_TSD_NODE_PATH?.trim();
  if (override) return override;
  if (process.platform !== 'win32') return 'node';
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return 'node';
  const bundled = path.join(resourcesPath, 'node-runtime', 'node.exe');
  return existsSync(bundled) ? bundled : 'node';
}

type ExecFileOptions = {
  encoding: 'utf8' | 'buffer';
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
  windowsHide: boolean;
};

export type NodeGitRunnerExec = (
  file: string,
  args: string[],
  options: ExecFileOptions
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const execFileAsync = promisify(execFile) as unknown as NodeGitRunnerExec;

/** The error shape `execFile` rejects with. */
type ExecFileError = {
  code?: number | string | null;
  signal?: string | null;
  killed?: boolean;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

function streamText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

function describeStderr(stderr: string): string {
  const text = stderr.trim();
  return text ? `: ${text.slice(0, 500)}` : '';
}

/**
 * Turn an `execFile` rejection into a typed failure. Every rejection is a
 * failure: a non-zero exit, a kill (timeout or signal) or a maxBuffer overflow
 * leaves partial stdout that must not be parsed as a complete answer.
 */
export function toNodeGitRunnerError(
  error: unknown,
  command: string,
  timeoutMs: number,
  maxBuffer = NODE_GIT_RUNNER_MAX_BUFFER
): NodeGitRunnerError {
  const e = (error ?? {}) as ExecFileError;
  // Buffer mode (`encoding: 'buffer'`) rejects with Buffer streams.
  const stderr = streamText(e.stderr);
  const code = e.code ?? null;
  const signal = e.signal ?? null;
  const prefix = `git ${command} via the node runner failed`;

  const spawnMarker = stderr.indexOf(GIT_SPAWN_ERROR_MARKER);
  if (spawnMarker >= 0) {
    const reason =
      stderr
        .slice(spawnMarker + GIT_SPAWN_ERROR_MARKER.length)
        .trim()
        .split(/\s/)[0] || 'unknown';
    return new NodeGitRunnerError(
      `${prefix}: git could not be started (${reason})`,
      'git-spawn',
      code,
      signal
    );
  }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new NodeGitRunnerError(
      `${prefix}: output exceeded ${maxBuffer} bytes`,
      'max-buffer',
      code,
      signal
    );
  }
  if (e.killed) {
    return new NodeGitRunnerError(
      `${prefix}: timed out after ${timeoutMs}ms`,
      'timeout',
      code,
      signal
    );
  }
  if (signal) {
    return new NodeGitRunnerError(`${prefix}: terminated by ${signal}`, 'signal', code, signal);
  }
  if (typeof code === 'string') {
    return new NodeGitRunnerError(
      `${prefix}: node could not be started (${code})`,
      'node-spawn',
      code,
      signal
    );
  }
  if (typeof code === 'number') {
    return new NodeGitRunnerError(
      `${prefix}: exit ${code}${describeStderr(stderr)}`,
      'git-exit',
      code,
      signal,
      stderr.trim().slice(0, 500)
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new NodeGitRunnerError(`${prefix}: ${message}`, 'unknown', code, signal);
}

export type RunGitViaNodeOptions = {
  workdir: string;
  args: string[];
  /** Git environment of the primary path (`createGitEnv(workdir)`). */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * `'buffer'` relays stdout as raw bytes, for content whose encoding the
   * caller detects itself (blobs from `git show`). Default `'utf8'`.
   */
  encoding?: 'utf8' | 'buffer';
  /** Cap on the relayed stdout; beyond it the run fails as `max-buffer`. */
  maxBuffer?: number;
  exec?: NodeGitRunnerExec;
};

/**
 * Run `git <args>` in `workdir` with the bundled node as git's parent.
 * Resolves only on a clean exit 0; anything else rejects with
 * `NodeGitRunnerError`. Whether a successful run actually carried output is
 * the caller's judgement (it knows what a complete answer looks like).
 */
export async function runGitViaNode(
  options: RunGitViaNodeOptions & { encoding: 'buffer' }
): Promise<{ stdout: Buffer; stderr: Buffer }>;
export async function runGitViaNode(
  options: RunGitViaNodeOptions & { encoding?: 'utf8' }
): Promise<{ stdout: string; stderr: string }>;
export async function runGitViaNode(
  options: RunGitViaNodeOptions
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  const timeoutMs = options.timeoutMs ?? NODE_GIT_RUNNER_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? NODE_GIT_RUNNER_MAX_BUFFER;
  const exec = options.exec ?? execFileAsync;
  try {
    return await exec(
      resolveBundledNode(),
      ['-e', NODE_GIT_RUNNER_SCRIPT, '--', options.workdir, ...options.args],
      {
        encoding: options.encoding ?? 'utf8',
        // Porcelain formats are not localized, but git's own messages and the
        // detached-HEAD text of `git branch` are; parse English only.
        env: { ...options.env, LC_ALL: 'C', LANGUAGE: 'C' },
        maxBuffer,
        timeout: timeoutMs,
        windowsHide: true,
      }
    );
  } catch (error) {
    throw toNodeGitRunnerError(error, options.args[0] ?? '', timeoutMs, maxBuffer);
  }
}
