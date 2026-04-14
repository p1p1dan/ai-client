import type { GitWorktree } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeComparablePath,
  pathsEqualIncludingSlashes,
  worktreeListBelongsToRepo,
} from '../useWorktreeSync.utils';

describe('useWorktreeSync utils', () => {
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

  it('normalizes slashes, case, and trailing separators', () => {
    expect(normalizeComparablePath('C:\\Repo\\Foo\\')).toBe('c:/repo/foo');
  });

  it('treats paths with different slash styles as equal', () => {
    expect(pathsEqualIncludingSlashes('C:\\Repo\\Foo', 'c:/repo/foo/')).toBe(true);
  });

  it('detects whether a worktree list belongs to a selected repo', () => {
    const worktrees: GitWorktree[] = [
      {
        path: 'c:/repo',
        head: '',
        branch: 'main',
        isMainWorktree: true,
        isLocked: false,
        prunable: false,
      },
      {
        path: 'c:/repo/wt-1',
        head: '',
        branch: 'feature/test',
        isMainWorktree: false,
        isLocked: false,
        prunable: false,
      },
    ];

    expect(worktreeListBelongsToRepo(worktrees, 'C:\\Repo')).toBe(true);
    expect(worktreeListBelongsToRepo(worktrees, 'C:\\other')).toBe(false);
    expect(worktreeListBelongsToRepo(worktrees, 'c:/repo2')).toBe(false);
  });
});

