import { describe, expect, it } from 'vitest';
import { DSH_HUNK_SEPARATOR, dshFileReview } from '../dshFileReview.ts';
import { parseSessionFileChange } from '../sessionFileChange.ts';

/**
 * dsh-rebase P1-4d1 (decision 099 rule 6): a `write` / `edit` result's review
 * record comes off the diff card DSH stored with it (dsh-tool-fs
 * `presentationMeta`), never off a second read of the file.
 */

describe('dshFileReview — from DSH diff cards', () => {
  it('a created file is added, its patch the whole content from line 1', () => {
    const review = dshFileReview(
      'write',
      { file_path: 'src/new.ts', content: 'one\ntwo\n' },
      { operation: 'create', diffs: [] }
    );
    expect(review).toEqual({
      version: 1,
      path: 'src/new.ts',
      status: 'added',
      patch: '@@ -0,0 +1,2 @@\n+one\n+two',
    });
    // The renderer's own validator accepts it.
    expect(parseSessionFileChange(review)).toEqual(review);
  });

  it('marks a created last line without a newline, as 1.0.x did', () => {
    const review = dshFileReview(
      'write',
      { file_path: 'a.txt', content: 'only' },
      { operation: 'create', diffs: [] }
    );
    expect(review?.patch).toBe('@@ -0,0 +1,1 @@\n+only\n\\ No newline at end of file');
  });

  it('an update is modified, each hunk a line diff under a bare separator', () => {
    const review = dshFileReview(
      'write',
      { file_path: 'a.txt', content: 'ignored for an update' },
      {
        operation: 'update',
        diffs: [
          { path: 'a.txt', oldText: 'keep\nold\nkeep2', newText: 'keep\nnew\nkeep2' },
          { path: 'a.txt', oldText: null, newText: 'appended' },
        ],
      }
    );
    expect(review).toEqual({
      version: 1,
      path: 'a.txt',
      status: 'modified',
      patch: [
        DSH_HUNK_SEPARATOR,
        ' keep',
        '-old',
        '+new',
        ' keep2',
        DSH_HUNK_SEPARATOR,
        '+appended',
      ].join('\n'),
    });
    expect(parseSessionFileChange(review)).toEqual(review);
  });

  it('an edit reads the same card, which carries no operation', () => {
    const review = dshFileReview(
      'edit',
      { file_path: '/ws/b.ts', old_string: 'x', new_string: 'y' },
      { diffs: [{ path: '/ws/b.ts', oldText: 'a\nx', newText: 'a\ny' }] }
    );
    expect(review).toEqual({
      version: 1,
      path: '/ws/b.ts',
      status: 'modified',
      patch: `${DSH_HUNK_SEPARATOR}\n a\n-x\n+y`,
    });
  });

  it('falls back to the hunk path when the call named none', () => {
    expect(
      dshFileReview('edit', {}, { diffs: [{ path: 'c.ts', oldText: 'a', newText: 'b' }] })?.path
    ).toBe('c.ts');
  });

  it('says what it cannot show instead of showing it: binary, too large', () => {
    expect(
      dshFileReview(
        'write',
        { file_path: 'bin', content: 'a\0b' },
        { operation: 'create', diffs: [] }
      )
    ).toMatchObject({ status: 'added', unavailable: 'binary' });
    const big = `${'x'.repeat(99)}\n`.repeat(1_000);
    expect(
      dshFileReview('write', { file_path: 'big', content: big }, { operation: 'create', diffs: [] })
    ).toMatchObject({ status: 'added', unavailable: 'too-large' });
    const wide = 'y'.repeat(70 * 1024);
    expect(
      dshFileReview(
        'edit',
        { file_path: 'w' },
        { diffs: [{ path: 'w', oldText: 'a', newText: wide }] }
      )
    ).toMatchObject({ status: 'modified', unavailable: 'too-large' });
  });

  it('an empty created file and a card with no hunks carry no patch', () => {
    expect(
      dshFileReview('write', { file_path: 'e', content: '' }, { operation: 'create', diffs: [] })
    ).toEqual({ version: 1, path: 'e', status: 'added', patch: '' });
    expect(dshFileReview('write', { file_path: 'e' }, { operation: 'update', diffs: [] })).toEqual({
      version: 1,
      path: 'e',
      status: 'modified',
    });
  });

  it('gives nothing for another tool, a result without a card, or a malformed card', () => {
    expect(dshFileReview('bash', {}, { diffs: [] })).toBeUndefined();
    expect(dshFileReview('write', { file_path: 'a' }, undefined)).toBeUndefined();
    expect(dshFileReview('write', { file_path: 'a' }, { diffs: [{ path: 'a' }] })).toBeUndefined();
    expect(
      dshFileReview('edit', { file_path: 'a' }, { diffs: [{ oldText: 3, newText: 'b' }] })
    ).toBeUndefined();
    expect(dshFileReview('edit', {}, { diffs: [] })).toBeUndefined();
  });
});
