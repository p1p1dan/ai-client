/**
 * Shell `workdir` checks (GitHub issue #2, decision 164).
 *
 * Node reports a spawn whose cwd does not exist as `spawn <program> ENOENT`
 * (a cwd that cannot be entered as `EACCES`), which reads like a missing
 * shell: a model told so gives up on the shell altogether. Two checks, for
 * `bash` / `pwsh` only:
 *
 *   syntax     before the gate, no disk access: on Windows a rooted path with
 *              no drive (`/Users/...`, `\work`). The gate resolves it onto the
 *              session's drive, DSH's runner onto the host process's current
 *              drive, so a card would name a directory the command does not
 *              run in; refusing it outright also spares a pointless card.
 *   existence  after the gate allowed the call: the directory DSH will spawn
 *              in exists, is a directory and can be entered. Not before the
 *              gate, so an unapproved call cannot probe the disk.
 *
 * The target is computed as the tools do: bash `${cwd}${sep}${workdir}`
 * (dsh-tool-bash `resolveWorkdir`), pwsh `resolve(cwd, workdir)`
 * (dsh-tool-pwsh), an absolute workdir as is, none -> the session cwd.
 */

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { classifyTool } from './classification.ts';
import type { DshPreToolDecision } from './dshTypes.ts';

/**
 * `info.name` of these refusals. Not `PermissionDenial`: the history and the
 * live tool row would mark the call as refused by the gate.
 */
export const SHELL_WORKDIR_DENIAL = 'ShellWorkdir';

export type ShellWorkdirDenial = Extract<DshPreToolDecision, { kind: 'deny' }>;

/** The disk reads of the existence check; node:fs by default. */
export interface WorkdirProbe {
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  /** Rejects when the directory cannot be entered (`X_OK`, as DSH's `isUsableWorkdir`). */
  access(path: string): Promise<void>;
}

export const nodeWorkdirProbe: WorkdirProbe = {
  stat: (path) => stat(path),
  access: (path) => access(path, constants.X_OK),
};

/** Rooted without a drive: `/x` or `\x`, not a UNC `//server` or `\\server`. */
const DRIVELESS_ROOT = /^[\\/](?![\\/])/;

function workdirOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>).workdir;
  // An empty workdir runs in the session cwd under both tools.
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pathsOf(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function deny(code: string, reason: string): ShellWorkdirDenial {
  return { kind: 'deny', reason, info: { name: SHELL_WORKDIR_DENIAL, code } };
}

/** The directory DSH's shell tool spawns the command in. */
export function shellWorkdirTarget(
  tool: string,
  workdir: string | undefined,
  sessionCwd: string,
  platform: NodeJS.Platform
): string {
  if (workdir === undefined) return sessionCwd;
  const paths = pathsOf(platform);
  if (paths.isAbsolute(workdir)) return workdir;
  return tool === 'pwsh'
    ? paths.resolve(sessionCwd, workdir)
    : `${sessionCwd}${paths.sep}${workdir}`;
}

/** Step 1, before the gate: a Windows workdir with no drive. */
export function workdirSyntaxDenial(
  tool: string,
  args: unknown,
  sessionCwd: string,
  platform: NodeJS.Platform
): ShellWorkdirDenial | undefined {
  if (platform !== 'win32' || classifyTool(tool) !== 'shell') return undefined;
  const workdir = workdirOf(args);
  if (workdir === undefined || !DRIVELESS_ROOT.test(workdir)) return undefined;
  return deny(
    'workdir_no_drive',
    `workdir "${workdir}" has no drive letter; on Windows give a full path such as ${sessionCwd}, or omit workdir to run in the session workspace`
  );
}

/** Step 2, after the gate allowed the call: the directory exists and can be entered. */
export async function workdirExistenceDenial(
  tool: string,
  args: unknown,
  sessionCwd: string,
  platform: NodeJS.Platform,
  probe: WorkdirProbe = nodeWorkdirProbe
): Promise<ShellWorkdirDenial | undefined> {
  if (classifyTool(tool) !== 'shell') return undefined;
  const workdir = workdirOf(args);
  const target = shellWorkdirTarget(tool, workdir, sessionCwd, platform);
  let directory: boolean;
  try {
    directory = (await probe.stat(target)).isDirectory();
  } catch (error) {
    const code = errnoOf(error);
    // Anything else (EPERM, a network share's own error): the tool reports it.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
    if (workdir === undefined)
      return deny(
        'workdir_missing',
        `the session workspace does not exist: ${target}; it may have been moved or deleted`
      );
    const workspace = target === sessionCwd ? '' : ` (the session workspace is ${sessionCwd})`;
    const tilde = workdir.startsWith('~')
      ? '; "~" is not expanded in workdir, give the full path'
      : '';
    return deny(
      'workdir_missing',
      `working directory does not exist: ${target}${workspace}${tilde}`
    );
  }
  if (!directory)
    return deny('workdir_not_directory', `working directory is not a directory: ${target}`);
  try {
    await probe.access(target);
  } catch (error) {
    if (errnoOf(error) === 'EACCES')
      return deny('workdir_not_accessible', `working directory is not accessible: ${target}`);
  }
  return undefined;
}
