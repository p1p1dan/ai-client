import { describe, expect, it } from 'vitest';
import { reviewPatchLines } from '../sessionReviewPatch';

describe('reviewPatchLines', () => {
  it('reads both hunk origins, advances context on both sides, and resets for another hunk', () => {
    const rows = reviewPatchLines(
      '@@ -10,2 +20,3 @@\n same\n-old\n+new\n+extra\n@@ -30 +41 @@\n-before\n+after'
    );
    expect(rows.map(({ oldLine, newLine }) => [oldLine, newLine])).toEqual([
      [undefined, undefined],
      [10, 20],
      [11, undefined],
      [undefined, 21],
      [undefined, 22],
      [undefined, undefined],
      [30, undefined],
      [undefined, 41],
    ]);
  });

  it('handles new files and no-newline markers without inventing old-side coordinates', () => {
    const rows = reviewPatchLines(
      '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+first\n\\ No newline at end of file\n+second'
    );
    expect(rows[0].oldLine).toBeUndefined();
    expect(rows[1].newLine).toBeUndefined();
    expect(rows[3]).toMatchObject({ kind: 'add', newLine: 1 });
    expect(rows[3].oldLine).toBeUndefined();
    expect(rows[5].newLine).toBe(2);
  });

  it('keeps numbers blank without valid hunk evidence, including truncated or malformed patches', () => {
    const rows = reviewPatchLines(
      '-old\n+new\n@@ -5 +6 @@\n-a\n+b\n+overflow\n@@ invalid\n+unknown'
    );
    for (const index of [0, 1, 5, 6, 7]) {
      expect(rows[index].oldLine).toBeUndefined();
      expect(rows[index].newLine).toBeUndefined();
    }
  });

  it('counts empty context lines and treats header-looking content inside a hunk as content', () => {
    const rows = reviewPatchLines('@@ -8,2 +9,2 @@\n \n---content\n+++content');
    expect(rows[1]).toMatchObject({ oldLine: 8, newLine: 9 });
    expect(rows[2]).toMatchObject({ oldLine: 9 });
    expect(rows[3]).toMatchObject({ newLine: 10 });
  });
});
