/**
 * T-12: single source of truth for every `['git', ...]` React Query key used
 * by `useGit.ts` and `useSourceControl.ts`.
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
import { normalizePath } from '@/App/storage';

function scopedWorkdir(workdir: string | null | undefined): string | null | undefined {
  if (workdir === undefined) {
    return undefined;
  }
  return workdir === null ? null : normalizePath(workdir);
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
  logInfinite: scopedKeyBuilder('git', 'log-infinite'),
  submodules: scopedKeyBuilder('git', 'submodules'),
  submoduleChanges: scopedKeyBuilder('git', 'submodule', 'changes'),

  /** `log(workdir)` omits `maxCount` -> a valid invalidate prefix for every maxCount. */
  log: (workdir?: string | null, maxCount?: number): readonly unknown[] => {
    const w = scopedWorkdir(workdir);
    if (w === undefined) return ['git', 'log'];
    if (maxCount === undefined) return ['git', 'log', w];
    return ['git', 'log', w, maxCount];
  },

  /** `fileDiff(workdir)` / `fileDiff(workdir, path)` are valid invalidate prefixes. */
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
};
