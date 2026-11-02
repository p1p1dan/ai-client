import { describe, expect, it } from 'vitest';
import { diffLineArrays, lineDiffRows } from '../textDiff';

describe('[PILAB-R2] diffLineArrays', () => {
  it('diffs only the middle, so a small change in a large file stays small', () => {
    const before = Array.from({ length: 1001 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[500] = 'changed';
    const rows = diffLineArrays(before, after);
    expect(rows.filter((row) => row.kind === 'del')).toEqual([{ kind: 'del', text: 'line 500' }]);
    expect(rows.filter((row) => row.kind === 'add')).toEqual([{ kind: 'add', text: 'changed' }]);
    expect(rows).toHaveLength(1002);
    expect(rows[500]).toEqual({ kind: 'del', text: 'line 500' });
  });

  it('keeps the shape of small diffs', () => {
    expect(lineDiffRows('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
    expect(lineDiffRows('a\na', 'a')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'a' },
    ]);
    expect(lineDiffRows('', 'a')).toEqual([{ kind: 'add', text: 'a' }]);
    expect(lineDiffRows('a', 'a')).toEqual([{ kind: 'same', text: 'a' }]);
  });
});
