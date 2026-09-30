// New in dsh-rebase P1-6b (decision 134): one canonical spelling for the roots the gate compares against.

import { resolve } from 'node:path';

/**
 * A synchronous canonical resolver, injected by the host (this library does
 * no filesystem work of its own).
 *
 * It MUST be the synchronous twin of the resolver the host canonicalizes
 * targets with (`PermissionFileSystem.realpath`). In Node that pairing is
 * `fs.realpathSync.native` with `fs/promises` `realpath`: both are libuv's
 * `uv_fs_realpath`, which on Windows also expands 8.3 short names
 * (`C:\Users\RUNNER~1` -> `C:\Users\runneradmin`) and returns the on-disk
 * case. Plain `fs.realpathSync` is Node's JavaScript walk: it resolves links
 * but keeps every other component as spelled, so a root it canonicalized
 * never contains a target the native one canonicalized once `%TEMP%` (or the
 * workspace) is an 8.3 path, and every read in the workspace asked.
 */
export type SyncRealpath = (path: string) => string;

/** `path` canonicalized by `realpath`, or resolved lexically when it cannot be (missing, unreadable). */
export function canonicalSpelling(path: string, realpath: SyncRealpath): string {
  try {
    return realpath(path);
  } catch {
    return resolve(path);
  }
}

/** What a gate is told about its workspace; see `PermissionConfig.cwdAliases`. */
export interface WorkspaceSpellings {
  /** The canonical spelling: targets are canonicalized the same way. */
  cwd: string;
  /** The spelling the session was opened with, when it differs (a symlink, an 8.3 name). */
  cwdAliases: string[];
}

/**
 * The workspace by every spelling a tool call can name it with: the canonical
 * one targets resolve to, and the one the session was opened with, which is
 * what the model sees and what shell operands are written against.
 */
export function workspaceSpellings(cwd: string, realpath: SyncRealpath): WorkspaceSpellings {
  const lexical = resolve(cwd);
  const canonical = canonicalSpelling(lexical, realpath);
  return { cwd: canonical, cwdAliases: canonical === lexical ? [] : [lexical] };
}
