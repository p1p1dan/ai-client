import { describe, expect, it } from 'vitest';
import { sessionReviewDiffTarget } from '../sessionReviewDiffTarget';

describe('sessionReviewDiffTarget', () => {
  it('converts absolute review paths to Git-relative paths with the real target contract', () => {
    expect(
      sessionReviewDiffTarget({ path: '/repo/src/a.ts', status: 'modified' }, '/repo')
    ).toEqual({
      kind: 'workdir',
      path: 'src/a.ts',
      staged: false,
      status: 'M',
    });
  });

  it('normalizes relative paths, Windows paths, and trailing root separators', () => {
    expect(sessionReviewDiffTarget({ path: 'src/../a.ts', status: 'added' }, '/repo/')?.path).toBe(
      'a.ts'
    );
    expect(
      sessionReviewDiffTarget({ path: 'c:\\Repo\\src\\a.ts', status: 'added' }, 'C:/repo')?.path
    ).toBe('src/a.ts');
    expect(
      sessionReviewDiffTarget(
        { path: '//server/share/repo/a.ts', status: 'added' },
        '//server/share/repo'
      )?.status
    ).toBe('A');
    expect(sessionReviewDiffTarget({ path: '/a.ts', status: 'unknown' }, '/')?.path).toBe('a.ts');
  });

  it('does not invent a known Git status for historical previews', () => {
    expect(
      sessionReviewDiffTarget({ path: 'a.ts', status: 'unknown' }, '/repo')?.status
    ).toBeUndefined();
  });

  it('does not open outside-workspace paths as a misleading whole-file addition', () => {
    for (const path of [
      '/repo-other/a.ts',
      '../a.ts',
      '/repo/../a.ts',
      'C:relative.ts',
      '/Repo/a.ts',
    ]) {
      expect(sessionReviewDiffTarget({ path, status: 'modified' }, '/repo')).toBeNull();
    }
  });
});
