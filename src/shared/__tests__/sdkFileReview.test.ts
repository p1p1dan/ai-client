import { describe, expect, it } from 'vitest';
import { sdkFileReview } from '../sdkFileReview.ts';
import { parseSessionFileChange } from '../sessionFileChange.ts';

/**
 * Issue #27: a Claude Agent SDK `Edit` / `Write` result's review record comes
 * off the CLI's own `structuredPatch`, with its line numbers.
 */

const hunk = (lines: string[], oldStart = 3, oldLines = 3, newStart = 3, newLines = 3) => ({
  oldStart,
  oldLines,
  newStart,
  newLines,
  lines,
});

describe('sdkFileReview — from the CLI’s tool results', () => {
  it('an Edit keeps its hunks under real headers', () => {
    const review = sdkFileReview({
      filePath: '/repo/a.ts',
      oldString: 'b',
      newString: 'B',
      originalFile: 'x\ny\na\nb\nc\n',
      structuredPatch: [hunk([' a', '-b', '+B', ' c']), hunk(['-z', '+Z'], 40, 1, 40, 1)],
      userModified: false,
      replaceAll: false,
    });
    expect(review).toEqual({
      version: 1,
      path: '/repo/a.ts',
      status: 'modified',
      patch: '@@ -3,3 +3,3 @@\n a\n-b\n+B\n c\n@@ -40,1 +40,1 @@\n-z\n+Z',
    });
    expect(parseSessionFileChange(review)).toEqual(review);
  });

  it('a created file is added, its patch the whole content from line 1', () => {
    expect(
      sdkFileReview({
        type: 'create',
        filePath: '/repo/new.ts',
        content: 'one\ntwo',
        structuredPatch: [],
        originalFile: null,
      })
    ).toEqual({
      version: 1,
      path: '/repo/new.ts',
      status: 'added',
      patch: '@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file',
    });
  });

  it('an overwrite with hunks is modified', () => {
    expect(
      sdkFileReview({
        type: 'update',
        filePath: '/repo/b.md',
        content: '2\n',
        structuredPatch: [hunk(['-1', '+2'], 1, 1, 1, 1)],
        originalFile: '1\n',
      })
    ).toMatchObject({ status: 'modified', patch: '@@ -1,1 +1,1 @@\n-1\n+2' });
  });

  it('an overwrite without hunks: unchanged, too large, or no diff to show', () => {
    const update = { type: 'update', filePath: 'f', content: 'same', structuredPatch: [] };
    expect(sdkFileReview({ ...update, originalFile: 'same' })).toMatchObject({ patch: '' });
    expect(sdkFileReview({ ...update, originalFile: null })).toMatchObject({
      unavailable: 'too-large',
    });
    // The CLI's diff timed out: the row keeps its argument preview.
    expect(sdkFileReview({ ...update, originalFile: 'other' })).toBeUndefined();
  });

  it('binary content and an oversized patch are marked, not shown', () => {
    expect(
      sdkFileReview({ type: 'create', filePath: 'b', content: 'a\0b', structuredPatch: [] })
    ).toMatchObject({ unavailable: 'binary' });
    const big = Array.from({ length: 3000 }, (_, i) => `+${'x'.repeat(30)}${i}`);
    expect(
      sdkFileReview({ filePath: 'c', oldString: '', structuredPatch: [hunk(big, 1, 0, 1, 3000)] })
    ).toMatchObject({ unavailable: 'too-large' });
  });

  it('nothing for other results, an edit held for review, or malformed hunks', () => {
    expect(sdkFileReview(undefined)).toBeUndefined();
    expect(sdkFileReview('The file was updated.')).toBeUndefined();
    expect(sdkFileReview({ stdout: '', stderr: '' })).toBeUndefined();
    expect(
      sdkFileReview({
        filePath: 'a',
        oldString: 'x',
        structuredPatch: [hunk(['-x', '+y'])],
        staged: true,
      })
    ).toBeUndefined();
    expect(
      sdkFileReview({ filePath: 'a', oldString: 'x', structuredPatch: [{ lines: ['-x'] }] })
    ).toBeUndefined();
  });
});
