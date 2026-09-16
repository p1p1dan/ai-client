/**
 * "Is this directory inside that one?" — the single answer both workspace kinds
 * ask before they create or delete anything.
 *
 * Both sides used to answer it their own way and both were wrong in a different
 * direction (batch-D audit main-aux-01 / main-aux-07): the scratch root
 * compared canonicalised strings by prefix, and that key never resolves `..`,
 * so `<root>/../secret` counted as "one of ours"; the temp workspace base
 * resolved only the candidate and compared it against the raw string the user
 * typed in Settings, so a trailing separator turned every comparison false.
 *
 * The rule here is the one the audit asked for: expand `~`, `path.resolve` BOTH
 * sides, then judge with `path.relative`. A `..` that survives in the result is
 * exactly "the candidate is not under this directory".
 *
 * `platform` is injectable (defaults to `process.platform`) for the same reason
 * `windows-paths.ts` (T039) injects it: on `win32` the filesystem folds case
 * (NTFS/ReFS are case-insensitive by default), so `C:\Users\JC\scratch` and
 * `c:\users\jc\SCRATCH` must be recognised as the same directory (main-aux-01
 * FIX). `path.win32` / `path.posix` are pure algorithms independent of the host
 * OS, so this can be exercised on a Linux CI box without actually running on
 * Windows.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { expandHomePath } from '@shared/defaultPaths';

/** The path module whose resolve/relative/sep semantics match `platform`. */
function pathModuleFor(platform: NodeJS.Platform): typeof path {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Absolute, `..`-free form of a path that came from a setting, an index row or
 * an IPC payload — i.e. from outside this process's control.
 */
export function resolveWorkspacePath(
  candidate: string,
  platform: NodeJS.Platform = process.platform
): string {
  const mod = pathModuleFor(platform);
  return mod.resolve(expandHomePath(candidate, homedir(), mod.sep));
}

/**
 * The `path.relative` result, or null when either side is blank.
 *
 * Both sides are lower-cased before `relative` runs, but only on `win32`:
 * POSIX filesystems are case-sensitive, so folding there would make two
 * genuinely different directories (`/tmp/Scratch` and `/tmp/scratch`) compare
 * as the same one.
 */
function relativeFrom(
  directory: string,
  candidate: string,
  platform: NodeJS.Platform
): string | null {
  if (!directory.trim() || !candidate.trim()) return null;
  const mod = pathModuleFor(platform);
  const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
  return mod.relative(
    fold(resolveWorkspacePath(directory, platform)),
    fold(resolveWorkspacePath(candidate, platform))
  );
}

/**
 * True when `candidate` resolves to something strictly inside `directory`, at
 * any depth. The directory itself is not inside itself.
 *
 * `rel` is only checked for a leading `..` SEGMENT: a child legitimately named
 * `..config` starts with the same two characters and must not be rejected.
 */
export function isInsideDirectory(
  directory: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const mod = pathModuleFor(platform);
  const rel = relativeFrom(directory, candidate, platform);
  if (rel === null || rel === '' || rel === '..') return false;
  return !rel.startsWith(`..${mod.sep}`) && !mod.isAbsolute(rel);
}

/**
 * True when `candidate` resolves to a DIRECT child of `directory`.
 *
 * The narrower question the temp workspace handlers ask: the create handler
 * only ever makes direct children, so anything deeper is not one of theirs.
 */
export function isDirectChildOf(
  directory: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const mod = pathModuleFor(platform);
  const rel = relativeFrom(directory, candidate, platform);
  if (rel === null || rel === '' || rel === '..') return false;
  return !rel.includes(mod.sep) && !mod.isAbsolute(rel);
}
