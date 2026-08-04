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

  describe('root path guard (T-12 batch-C, Codex minor fix)', () => {
    it('POSIX root "/" keeps its own identity instead of collapsing to an empty string', () => {
      expect(gitQueryKeys.status('/')).toEqual(['git', 'status', '/']);
    });

    it('POSIX root is distinct from the omitted (bare) root key', () => {
      expect(gitQueryKeys.status('/')).not.toEqual(gitQueryKeys.status());
    });

    it('Windows drive root spellings ("C:\\", "C:/", "C:") all normalize to the same key', () => {
      const keys = [
        gitQueryKeys.status('C:\\'),
        gitQueryKeys.status('C:/'),
        gitQueryKeys.status('C:'),
      ];
      for (const key of keys) {
        expect(key).toEqual(keys[0]);
      }
      expect(keys[0]).toEqual(['git', 'status', 'c:/']);
    });

    it('Windows drive root is distinct from a same-drive non-root path', () => {
      expect(gitQueryKeys.status('C:\\')).not.toEqual(gitQueryKeys.status('C:\\Repo'));
    });

    it('UNC share root keeps its shape across trailing-slash/separator spellings', () => {
      const keys = [
        gitQueryKeys.status('\\\\server\\share'),
        gitQueryKeys.status('\\\\server\\share\\'),
        gitQueryKeys.status('//server/share'),
      ];
      for (const key of keys) {
        expect(key).toEqual(keys[0]);
      }
      expect(keys[0]).toEqual(['git', 'status', '//server/share']);
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

    it('submoduleChanges() appends submodulePath only when provided', () => {
      expect(gitQueryKeys.submoduleChanges('/repo', 'libs/sub')).toEqual([
        'git',
        'submodule',
        'changes',
        '/repo',
        'libs/sub',
      ]);
    });

    it('diff() appends staged only when provided', () => {
      expect(gitQueryKeys.diff('/repo')).toEqual(['git', 'diff', '/repo']);
      expect(gitQueryKeys.diff('/repo', true)).toEqual(['git', 'diff', '/repo', true]);
    });

    it('logInfinite() is workdir-scoped and appends submodulePath only when provided', () => {
      expect(gitQueryKeys.logInfinite('/repo')).toEqual(['git', 'log-infinite', '/repo']);
      expect(gitQueryKeys.logInfinite('/repo', 'libs/sub')).toEqual([
        'git',
        'log-infinite',
        '/repo',
        'libs/sub',
      ]);
    });

    it('commitFiles() cascades workdir -> hash -> submodulePath', () => {
      expect(gitQueryKeys.commitFiles('/repo')).toEqual(['git', 'commit-files', '/repo']);
      expect(gitQueryKeys.commitFiles('/repo', 'abc123')).toEqual([
        'git',
        'commit-files',
        '/repo',
        'abc123',
      ]);
      expect(gitQueryKeys.commitFiles('/repo', 'abc123', 'libs/sub')).toEqual([
        'git',
        'commit-files',
        '/repo',
        'abc123',
        'libs/sub',
      ]);
    });

    it('commitDiff() cascades workdir -> hash -> filePath -> status -> submodulePath', () => {
      expect(gitQueryKeys.commitDiff('/repo')).toEqual(['git', 'commit-diff', '/repo']);
      expect(gitQueryKeys.commitDiff('/repo', 'abc123', 'src/index.ts', 'M', 'libs/sub')).toEqual([
        'git',
        'commit-diff',
        '/repo',
        'abc123',
        'src/index.ts',
        'M',
        'libs/sub',
      ]);
    });

    it('submoduleDiff() cascades workdir -> submodulePath -> filePath -> staged', () => {
      expect(gitQueryKeys.submoduleDiff('/repo')).toEqual(['git', 'submodule', 'diff', '/repo']);
      expect(gitQueryKeys.submoduleDiff('/repo', 'libs/sub')).toEqual([
        'git',
        'submodule',
        'diff',
        '/repo',
        'libs/sub',
      ]);
      expect(gitQueryKeys.submoduleDiff('/repo', 'libs/sub', 'src/index.ts', true)).toEqual([
        'git',
        'submodule',
        'diff',
        '/repo',
        'libs/sub',
        'src/index.ts',
        true,
      ]);
    });

    it('submoduleBranches() nests scope segments before workdir/submodulePath', () => {
      expect(gitQueryKeys.submoduleBranches('/repo', 'libs/sub')).toEqual([
        'git',
        'submodule',
        'branches',
        '/repo',
        'libs/sub',
      ]);
    });
  });

  // Coordinator follow-up (T-12 batch-C, second pass): useGitHistory.ts and
  // useSubmodules.ts previously built their query keys with raw workdir while
  // this factory's normalization only ran on invalidate calls elsewhere,
  // reintroducing the exact win/mac mismatch shape T-12 fixed. Both files now
  // build every query/invalidate key exclusively through this factory, so
  // parity is structural (same builder call -> same array) rather than
  // something that needs re-verifying per call site.
  describe('query key <-> invalidate key parity (useGitHistory / useSubmodules scopes)', () => {
    it('logInfinite query key equals its invalidate prefix for an equivalent workdir spelling', () => {
      const queryKey = gitQueryKeys.logInfinite('C:\\Repo', 'libs/sub');
      const invalidateKey = gitQueryKeys.logInfinite('c:/repo/');
      expect(queryKey.slice(0, invalidateKey.length)).toEqual(invalidateKey);
    });

    it('submodules query key equals the mutation invalidate key', () => {
      const queryKey = gitQueryKeys.submodules('C:\\Repo');
      const invalidateKey = gitQueryKeys.submodules('c:/repo');
      expect(queryKey).toEqual(invalidateKey);
    });

    it('submoduleChanges query key equals the stage/unstage/discard invalidate key', () => {
      const queryKey = gitQueryKeys.submoduleChanges('C:\\Repo', 'libs/sub');
      const invalidateKey = gitQueryKeys.submoduleChanges('c:/repo', 'libs/sub');
      expect(queryKey).toEqual(invalidateKey);
    });

    it('submoduleDiff invalidate key (workdir + submodulePath) is a prefix of the full query key', () => {
      const fullKey = gitQueryKeys.submoduleDiff('/repo', 'libs/sub', 'src/index.ts', true);
      const invalidateKey = gitQueryKeys.submoduleDiff('/repo', 'libs/sub');
      expect(fullKey.slice(0, invalidateKey.length)).toEqual(invalidateKey);
    });

    it('submoduleBranches query key equals the checkout mutation invalidate key', () => {
      const queryKey = gitQueryKeys.submoduleBranches('C:\\Repo', 'libs/sub');
      const invalidateKey = gitQueryKeys.submoduleBranches('c:/repo', 'libs/sub');
      expect(queryKey).toEqual(invalidateKey);
    });

    it('branches query key (useGit.ts) equals the worktree-merge invalidate key (useWorktree.ts)', () => {
      const queryKey = gitQueryKeys.branches('C:\\Repo');
      const invalidateKey = gitQueryKeys.branches('c:/repo');
      expect(queryKey).toEqual(invalidateKey);
    });
  });
});
