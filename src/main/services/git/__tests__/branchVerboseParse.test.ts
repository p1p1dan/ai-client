import { describe, expect, it } from 'vitest';
import { parseBranchVerbose } from '../branchVerboseParse';

/**
 * The F3 fallback parses `git branch --no-color -a -v` (run with LC_ALL=C)
 * itself, and must yield what simple-git's `parseBranchSummary` yields for the
 * same text. Fixtures are real git 2.53 output from scratch repos.
 */

const LISTING = [
  '* feature            2f440a2 [gone] fix: a -> b',
  '  main               2f440a2 [ahead 1, behind 1] fix: a -> b',
  '+ wtbranch           2f440a2 fix: a -> b',
  '  remotes/origin/HEAD -> origin/main',
  '  remotes/origin/main 949ed87 upstream2',
  '',
].join('\n');

describe('parseBranchVerbose', () => {
  it('reads current, worktree, remote and upstream-tracking entries', () => {
    expect(parseBranchVerbose(LISTING)).toEqual({
      feature: { current: true, commit: '2f440a2', label: '[gone] fix: a -> b' },
      main: { current: false, commit: '2f440a2', label: '[ahead 1, behind 1] fix: a -> b' },
      wtbranch: { current: false, commit: '2f440a2', label: 'fix: a -> b' },
      'remotes/origin/main': { current: false, commit: '949ed87', label: 'upstream2' },
    });
  });

  it('keeps branches whose subject contains "->", and skips only the symref', () => {
    const branches = parseBranchVerbose(LISTING);
    expect(Object.keys(branches)).toContain('feature');
    expect(Object.keys(branches)).not.toContain('remotes/origin/HEAD');
  });

  it('names a detached HEAD after its target, as simple-git does', () => {
    expect(
      parseBranchVerbose(
        [
          '* (HEAD detached at b8c47c2) b8c47c2 first',
          '  main                       2f440a2 second',
        ].join('\n')
      )
    ).toEqual({
      b8c47c2: { current: true, commit: 'b8c47c2', label: 'first' },
      main: { current: false, commit: '2f440a2', label: 'second' },
    });
    expect(parseBranchVerbose('* (HEAD detached at origin/main) 949ed87 upstream2\n')).toEqual({
      'origin/main': { current: true, commit: '949ed87', label: 'upstream2' },
    });
    expect(parseBranchVerbose('* (HEAD detached from v1.0) 949ed87 later\n')).toEqual({
      'v1.0': { current: true, commit: '949ed87', label: 'later' },
    });
  });

  it('tolerates CRLF line ends', () => {
    expect(parseBranchVerbose('* main 2f440a2 subject\r\n  dev 949ed87 other\r\n')).toEqual({
      main: { current: true, commit: '2f440a2', label: 'subject' },
      dev: { current: false, commit: '949ed87', label: 'other' },
    });
  });

  it('returns nothing for empty output', () => {
    expect(parseBranchVerbose('')).toEqual({});
  });
});
