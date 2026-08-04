import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitQueryKeys } from '../gitQueryKeys';

// normalizePath (src/renderer/App/storage.ts) only lowercases on win32/darwin,
// so the case-equivalence half of the win/mac defect (docs/plans/2026-08-04-
// t12-15-surface-spec.md §0) only reproduces under a win32/darwin
// `navigator.platform`. Stub it the same way useWorktreeSync.utils.test.ts
// does so this suite actually exercises the branch that was broken.
describe('gitQueryKeys', () => {
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  beforeEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform: 'Win32' },
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
      return;
    }
    Reflect.deleteProperty(globalThis, 'navigator');
  });

  const equivalentWorkdirs = [
    'C:\\Users\\Foo\\Bar',
    'c:/users/foo/bar',
    'C:/Users/Foo/Bar/',
    'C:\\Users\\Foo\\Bar\\\\',
    'c:\\USERS\\FOO\\BAR',
  ];

  describe('case/slash/trailing-slash equivalence', () => {
    it('status() produces the same key for every equivalent workdir spelling', () => {
      const keys = equivalentWorkdirs.map((w) => gitQueryKeys.status(w));
      for (const key of keys) {
        expect(key).toEqual(keys[0]);
      }
    });

    it('fileChanges() produces the same key for every equivalent workdir spelling', () => {
      const keys = equivalentWorkdirs.map((w) => gitQueryKeys.fileChanges(w));
      for (const key of keys) {
        expect(key).toEqual(keys[0]);
      }
    });

    it('fileDiff() produces the same key for every equivalent workdir spelling', () => {
      const keys = equivalentWorkdirs.map((w) => gitQueryKeys.fileDiff(w, 'src/index.ts', false));
      for (const key of keys) {
        expect(key).toEqual(keys[0]);
      }
    });

    it('log() produces the same key for every equivalent workdir spelling', () => {
      const keys = equivalentWorkdirs.map((w) => gitQueryKeys.log(w, 50));
      for (const key of keys) {
        expect(key).toEqual(keys[0]);
      }
    });
  });

  // The bug this factory fixes: a query key and its mutation's invalidate key
  // must be byte-identical (deep-equal, same length, same order) for the same
  // workdir — a mismatch is exactly what let commit/stage/unstage silently
  // stop refreshing status/rail dot on win/mac.
  describe('query key <-> invalidate key parity', () => {
    it('status query key equals the commit mutation invalidate key', () => {
      const queryKey = gitQueryKeys.status('C:\\Repo');
      const invalidateKey = gitQueryKeys.status('c:/repo/');
      expect(queryKey).toEqual(invalidateKey);
    });

    it('fileChanges query key equals the stage/unstage/discard invalidate key', () => {
      const queryKey = gitQueryKeys.fileChanges('C:\\Repo');
      const invalidateKey = gitQueryKeys.fileChanges('c:/repo');
      expect(queryKey).toEqual(invalidateKey);
    });

    it('fileDiff invalidate key (workdir-only) is a prefix of the full query key', () => {
      const fullKey = gitQueryKeys.fileDiff('/repo', 'src/index.ts', true);
      const invalidateKey = gitQueryKeys.fileDiff('/repo');
      expect(fullKey.slice(0, invalidateKey.length)).toEqual(invalidateKey);
    });

    it('log invalidate key (workdir-only, no maxCount) is a prefix of the full query key', () => {
      const fullKey = gitQueryKeys.log('/repo', 50);
      const invalidateKey = gitQueryKeys.log('/repo');
      expect(fullKey.slice(0, invalidateKey.length)).toEqual(invalidateKey);
    });
  });

  describe('root keys (no workdir arg) for whole-namespace invalidation', () => {
    it('status() with no args returns the bare root key', () => {
      expect(gitQueryKeys.status()).toEqual(['git', 'status']);
    });

    it('branches() with no args returns the bare root key', () => {
      expect(gitQueryKeys.branches()).toEqual(['git', 'branches']);
    });

    it('root key is a strict prefix of every workdir-scoped key', () => {
      const root = gitQueryKeys.status();
      const scoped = gitQueryKeys.status('/repo');
      expect(scoped.slice(0, root.length)).toEqual(root);
      expect(scoped.length).toBeGreaterThan(root.length);
    });

    it('explicit null workdir is distinct from the omitted (root) key', () => {
      expect(gitQueryKeys.status(null)).toEqual(['git', 'status', null]);
      expect(gitQueryKeys.status(null)).not.toEqual(gitQueryKeys.status());
    });
  });

  describe('per-scope key shapes', () => {
    it('submoduleChanges() nests scope segments before the workdir', () => {
      expect(gitQueryKeys.submoduleChanges('/repo')).toEqual([
        'git',
        'submodule',
        'changes',
        '/repo',
      ]);
    });

    it('diff() appends staged only when provided', () => {
      expect(gitQueryKeys.diff('/repo')).toEqual(['git', 'diff', '/repo']);
      expect(gitQueryKeys.diff('/repo', true)).toEqual(['git', 'diff', '/repo', true]);
    });

    it('logInfinite() is workdir-scoped', () => {
      expect(gitQueryKeys.logInfinite('/repo')).toEqual(['git', 'log-infinite', '/repo']);
    });
  });
});
