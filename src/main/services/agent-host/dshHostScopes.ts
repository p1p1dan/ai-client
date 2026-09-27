/**
 * Decision 075 — the systemd user scopes a dead DSH host leaves behind
 * (dsh-rebase P1-3d, Linux desktop).
 *
 * With a user bus, DSH runs each tool in a transient scope of its own,
 * `dsh-subprocess-<host pid>-<hex>.scope` (a terminal in `dsh-terminal-…`;
 * `unitStem` in dsh-subprocess-local). A scope does not die with the process
 * that opened it, so a host that was SIGKILLed or crashed leaves its tools
 * running until they end by themselves (P1-3c measured 20 s of `sleep`). The
 * supervisor calls this before it starts the next host.
 *
 * Units are matched on the exact dead pid, listed first and checked against
 * the exact name shape. Each is then ended the way DSH ends its own scopes
 * when a host exits cleanly (`terminateForHostExit`): systemd SIGKILLs every
 * process in the unit (`kill --kill-whom=all`), and `stop` releases what is
 * still loaded. `stop` alone is not enough: it sends SIGTERM and waits up to
 * the unit's stop timeout (90 s) for a tool that ignores it (P1-3d measured a
 * DSH bash tool outlast a 5 s `stop`). Nothing here signals a pid itself.
 * Without a user bus nothing runs; systemctl missing or failing is a log line,
 * never an error.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** One systemctl call; DSH gives its own the same bound. */
export const SYSTEMCTL_TIMEOUT_MS = 5_000;

const SCOPE_KINDS = ['dsh-subprocess', 'dsh-terminal'] as const;

export type SystemctlExecFile = (
  file: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    windowsHide: boolean;
    encoding: 'utf8';
  },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => unknown;

export interface DeadHostScopeOptions {
  execFile?: SystemctlExecFile;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
  log?: (message: string) => void;
}

/** Unit globs for one host pid; systemctl expands them over loaded units only. */
export function dshScopePatterns(pid: number): string[] {
  return SCOPE_KINDS.map((kind) => `${kind}-${pid}-*.scope`);
}

/** Exactly a DSH tool or terminal scope opened by `pid`, and nothing a glob could over-match. */
export function isDshScopeOf(unit: string, pid: number): boolean {
  return SCOPE_KINDS.some((kind) => new RegExp(`^${kind}-${pid}-[0-9a-f]+\\.scope$`).test(unit));
}

/** Whether `systemctl --user` has a manager to talk to: the only case DSH opened scopes in. */
export function hasSystemdUserBus(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync
): boolean {
  if (platform !== 'linux') return false;
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (
    runtimeDir &&
    (exists(path.join(runtimeDir, 'systemd', 'private')) || exists(path.join(runtimeDir, 'bus')))
  ) {
    return true;
  }
  return Boolean(env.DBUS_SESSION_BUS_ADDRESS);
}

function runSystemctl(
  execFile: SystemctlExecFile,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<{ ok: boolean; stdout: string; detail: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        'systemctl',
        args,
        {
          env: { ...env, LC_ALL: 'C' },
          timeout: SYSTEMCTL_TIMEOUT_MS,
          windowsHide: true,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          resolve({
            ok: error === null,
            stdout: String(stdout ?? ''),
            detail: error ? `${error.message} ${String(stderr ?? '').trim()}`.trim() : '',
          });
        }
      );
    } catch (error) {
      resolve({
        ok: false,
        stdout: '',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * Ends the scopes `pid` left behind. Resolves how many it ended, or `null`
 * when it could not (no user bus, no systemctl, a failed call). Never rejects.
 */
export async function stopDeadHostScopes(
  pid: number,
  options: DeadHostScopeOptions = {}
): Promise<number | null> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.warn(message));
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (!hasSystemdUserBus(env, options.platform, options.exists)) return null;
  const execFile = options.execFile ?? (nodeExecFile as unknown as SystemctlExecFile);
  const listed = await runSystemctl(
    execFile,
    [
      '--user',
      'list-units',
      '--all',
      '--plain',
      '--no-legend',
      '--no-pager',
      ...dshScopePatterns(pid),
    ],
    env
  );
  if (!listed.ok) {
    log(`[dsh-host] could not list the tool scopes of dead host pid ${pid}: ${listed.detail}`);
    return null;
  }
  const units = listed.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((unit) => isDshScopeOf(unit, pid));
  if (units.length === 0) return 0;
  const killed = await runSystemctl(
    execFile,
    ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', ...units],
    env
  );
  // Whatever is still loaded; a scope already collected is simply not matched.
  const stopped = await runSystemctl(execFile, ['--user', 'stop', ...dshScopePatterns(pid)], env);
  if (!killed.ok || !stopped.ok) {
    log(
      `[dsh-host] could not end ${units.join(' ')} of dead host pid ${pid}: ` +
        `${killed.ok ? '' : `kill: ${killed.detail} `}${stopped.ok ? '' : `stop: ${stopped.detail}`}`.trim()
    );
    return null;
  }
  log(
    `[dsh-host] ended ${units.length} tool scope(s) left by dead host pid ${pid}: ${units.join(' ')}`
  );
  return units.length;
}
