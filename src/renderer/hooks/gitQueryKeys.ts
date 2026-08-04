/**
 * T-12: single source of truth for every `['git', ...]` React Query key used
 * by `useGit.ts`, `useSourceControl.ts`, `useGitHistory.ts`, and
 * `useSubmodules.ts`.
 *
 * Fixes a verified win/mac defect (docs/plans/2026-08-04-t12-15-surface-spec.md
 * §0): `useGitStatus` built its key with `normalizePath(workdir)` (lowercases
 * on win/mac, collapses slash style) while `useSourceControl.ts`'s mutations
 * invalidated the RAW workdir. On Windows/macOS the two keys never matched,
 * so `commit`/`stage`/`unstage`/`discard` never invalidated the status query
 * and the git rail dot never refreshed. Centralizing normalization here means
 * every query key and every invalidate key for the same workdir is now
 * byte-identical no matter which casing/slash style the caller passes in.
 *
 * Each builder takes `workdir?: string | null`:
 * - omitted (`undefined`) -> the bare `['git', <scope>, ...]` root key, used
 *   to invalidate every workdir at once (e.g. after an auto-fetch tick).
 * - `null` or a path string -> a workdir-scoped key (`null` normalizes to
 *   `null`, mirroring "no workdir selected yet").
 *
 * Every builder's shorter-arity result is a prefix of its full-arity result,
 * so calling it with fewer trailing args is always a valid `invalidateQueries`
 * key for the fuller query.
 */
import type { FileChangeStatus } from '@shared/types';
import { normalizePath } from '@/App/storage';

/**
 * Root-path guard for `normalizePath` (T-12 batch-C, Codex minor finding):
 * `normalizePath` unconditionally strips *all* trailing separators before
 * lowercasing, which collapses root paths into non-root spellings and
 * breaks their cache-key identity:
 *   - `/` (POSIX root) -> `''` (empty string)
 *   - `C:\`, `C:/`, `C:` (Windows drive root) -> `c:` (a drive-relative
 *     form, not a root)
 * Restore a stable, root-distinct spelling for those two shapes before
 * falling through to the existing normalization for everything else,
 * including UNC share roots (e.g. `\\server\share`), which `normalizePath`
 * already handles correctly since they aren't made up entirely of
 * separators/drive-colon. Mirrors the root-preservation intent of
 * `trimTrailingPathSeparators` (shared/utils/path.ts) without duplicating
 * its (platform-agnostic) casing behavior.
 */
function normalizeWorkdirForKey(workdir: string): string {
  // POSIX root: input made up entirely of (one or more) separators.
  if (/^[\\/]+$/.test(workdir)) {
    return '/';
  }

  // Windows drive root: "C:", "C:\", "C:/" (any trailing separator count).
  const driveRootMatch = workdir.match(/^([a-zA-Z]):[\\/]*$/);
  if (driveRootMatch) {
    return `${driveRootMatch[1].toLowerCase()}:/`;
  }

  return normalizePath(workdir);
}

function scopedWorkdir(workdir: string | null | undefined): string | null | undefined {
  if (workdir === undefined) {
    return undefined;
  }
  return workdir === null ? null : normalizeWorkdirForKey(workdir);
}

/** `['git', ...segments]` when no workdir is given, else `['git', ...segments, workdir]`. */
function scopedKeyBuilder(...segments: string[]) {
  return (workdir?: string | null): readonly unknown[] => {
    const w = scopedWorkdir(workdir);
    return w === undefined ? [...segments] : [...segments, w];
  };
}

export const gitQueryKeys = {
  status: scopedKeyBuilder('git', 'status'),
  branches: scopedKeyBuilder('git', 'branches'),
  fileChanges: scopedKeyBuilder('git', 'file-changes'),
  submodules: scopedKeyBuilder('git', 'submodules'),

  /** `log(workdir)` omits `maxCount` -> a valid invalidate prefix for every maxCount. */
  log: (workdir?: string | null, maxCount?: number): readonly unknown[] => {
    const w = scopedWorkdir(workdir);
    if (w === undefined) return ['git', 'log'];
    if (maxCount === undefined) return ['git', 'log', w];
    return ['git', 'log', w, maxCount];
  },

  /** `logInfinite(workdir)` omits `submodulePath` -> a valid invalidate prefix for every submodule (incl. the main repo, where `submodulePath` is omitted/null). */
  logInfinite: (workdir?: string | null, submodulePath?: string | null): readonly unknown[] => {
    const w = scopedWorkdir(workdir);
    if (w === undefined) return ['git', 'log-infinite'];
    if (submodulePath === undefined) return ['git', 'log-infinite', w];
    return ['git', 'log-infinite', w, submodulePath];
  },

  /** `commitFiles(workdir)` / `commitFiles(workdir, hash)` are valid invalidate prefixes. */
  commitFiles: (
    workdir?: string | null,
    hash?: string | null,
    submodulePath?: string | null
  ): readonly unknown[] => {
    const w = scopedWorkdir(workdir);
    if (w === undefined) return ['git', 'commit-files'];
    if (hash === undefined) return ['git', 'commit-files', w];
    if (submodulePath === undefined) return ['git', 'commit-files', w, hash];
    return ['git', 'commit-files', w, hash, submodulePath];
  },

  /**
   * `commitDiff(workdir)` / `commitDiff(workdir, hash)` / `commitDiff(workdir, hash, filePath)`
   * / `commitDiff(workdir, hash, filePath, status)` are valid invalidate prefixes.
   */
  commitDiff: (
    workdir?: string | null,
    hash?: string | null,
    filePath?: string | null,
    status?: FileChangeStatus,
    submodulePath?: string | null
  ): readonly unknown[] => {
    const w = scopedWorkdir(workdir);
    if (w === undefined) return ['git', 'commit-diff'];
    if (hash === undefined) return ['git', 'commit-diff', w];
    if (filePath === undefined) return ['git', 'commit-diff', w, hash];
    if (status === undefined) return ['git', 'commit-diff', w, hash, filePath];
    if (submodulePath === undefined) return ['git', 'commit-diff', w, hash, filePath, status];
    return ['git', 'commit-diff', w, hash, filePath, status, submodulePath];
  },

  /**
   * `fileDiff(workdir)` / `fileDiff(workdir, path)` are valid invalidate prefixes.
   * Known boundary (Codex, unconfirmed): unlike `workdir`, `path` is used
   * verbatim here and is never run through normalization, so two callers
   * passing differently-slashed spellings of the same relative path would
   * produce distinct cache keys. Not reproduced or fixed in this batch.
   */
  fileDiff: (
    workdir?: string | null,
    path?: string | null,
    staged?: boolean
  ): readonly unknown[] => {
    const w = scopedWorkdir(workdir);
    if (w === undefined) return ['git', 'file-diff'];
    if (path === undefined) return ['git', 'file-diff', w];
    if (staged === undefined) return ['git', 'file-diff', w, path];
    return ['git', 'file-diff', w, path, staged];
  },

  /** `diff(workdir)` is a valid invalidate prefix for both `staged` values. */
  diff: (workdir?: string | null, staged?: boolean): readonly unknown[] => {
    const w = scopedWorkdir(workdir);
    if (w === undefined) return ['git', 'diff'];
    if (staged === undefined) return ['git', 'diff', w];
    return ['git', 'diff', w, staged];
  },

  /** `submoduleChanges(workdir)` omits `submodulePath` -> a valid invalidate prefix for every submodule. */
  submoduleChanges: (
    workdir?: string | null,
    submodulePath?: string | null
  ): readonly unknown[] => {
    const w = scopedWorkdir(workdir);
    if (w === undefined) return ['git', 'submodule', 'changes'];
    if (submodulePath === undefined) return ['git', 'submodule', 'changes', w];
    return ['git', 'submodule', 'changes', w, submodulePath];
  },

  /**
   * `submoduleDiff(workdir)` / `submoduleDiff(workdir, submodulePath)` /
   * `submoduleDiff(workdir, submodulePath, filePath)` are valid invalidate prefixes.
   */
  submoduleDiff: (
    workdir?: string | null,
    submodulePath?: string | null,
    filePath?: string | null,
    staged?: boolean
  ): readonly unknown[] => {
    const w = scopedWorkdir(workdir);
    if (w === undefined) return ['git', 'submodule', 'diff'];
    if (submodulePath === undefined) return ['git', 'submodule', 'diff', w];
    if (filePath === undefined) return ['git', 'submodule', 'diff', w, submodulePath];
    if (staged === undefined) return ['git', 'submodule', 'diff', w, submodulePath, filePath];
    return ['git', 'submodule', 'diff', w, submodulePath, filePath, staged];
  },

  /** `submoduleBranches(workdir)` omits `submodulePath` -> a valid invalidate prefix for every submodule. */
  submoduleBranches: (
    workdir?: string | null,
    submodulePath?: string | null
  ): readonly unknown[] => {
    const w = scopedWorkdir(workdir);
    if (w === undefined) return ['git', 'submodule', 'branches'];
    if (submodulePath === undefined) return ['git', 'submodule', 'branches', w];
    return ['git', 'submodule', 'branches', w, submodulePath];
  },
};
