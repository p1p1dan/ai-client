/**
 * Process helpers. Signals only ever go to a ChildProcess spawned here, or to
 * the process group it leads (docs/agent-project-engineering.md Appendix B1):
 * `killTree` refuses any pid that is not a real child of ours.
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

/** Whether `child` was spawned detached (its own process group on POSIX). */
const detachedChildren = new WeakSet<ChildProcess>();
/** Tracked children still running, for `killAllTracked` on Ctrl+C. */
const liveChildren = new Set<ChildProcess>();

/** Spawns `file` with `args`; on POSIX in its own process group so `killTree` reaches its children. */
export function spawnTracked(
  file: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; shell?: boolean; stdin?: boolean }
): ChildProcess {
  const detached = process.platform !== 'win32';
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell ?? false,
    detached,
    windowsHide: true,
    stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (detached) detachedChildren.add(child);
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  child.once('error', () => liveChildren.delete(child));
  return child;
}

/** Kills every tracked child still running (a detached group does not get the terminal's Ctrl+C). */
export function killAllTracked(): void {
  for (const child of liveChildren) killTree(child);
}

/** Kills `child` and everything it started. Only ever our own child's pid or group. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || pid <= 1 || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    if (detachedChildren.has(child)) process.kill(-pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Runs to completion with a timeout; output is kept up to `maxOutput` characters per stream. */
export function runCommand(
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    shell?: boolean;
    timeoutMs: number;
    maxOutput?: number;
  }
): Promise<RunResult> {
  const started = performance.now();
  const max = options.maxOutput ?? 20_000;
  const child = spawnTracked(file, args, {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length < max) stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < max) stderr += chunk;
  });
  return new Promise((done) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);
    const finish = (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      done({
        code,
        signal,
        stdout: stdout.slice(0, max),
        stderr: stderr.slice(0, max),
        timedOut,
        ms: Math.round(performance.now() - started),
      });
    };
    child.once('error', (error) => {
      stderr += String(error);
      finish(null, null);
    });
    child.once('close', (code, signal) => finish(code, signal));
  });
}

/**
 * git with line endings left alone: the workspace must diff exactly what the
 * agent wrote, whatever the machine's `core.autocrlf` says.
 */
export function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.safecrlf=false',
      '-c',
      'core.quotepath=false',
      ...args,
    ],
    {
      cwd,
      env: env ?? process.env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
}
