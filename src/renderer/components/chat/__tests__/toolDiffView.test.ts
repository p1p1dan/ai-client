import { describe, expect, it } from 'vitest';
import { deriveToolDiff, type ToolDiffLineRow } from '../toolDiff';
import { buildDiffView, DIFF_CONTEXT_LINES, diffHasLineNumbers } from '../toolDiffView';

/** Issue #26 item 2: line numbers and folded unchanged runs in the inline diff. */

const same = (n: number): ToolDiffLineRow => ({
  kind: 'same',
  text: `s${n}`,
  oldLine: n,
  newLine: n,
});

describe('line numbers', () => {
  it('an SDK patch numbers its rows from the hunk header', () => {
    const diff = deriveToolDiff({
      toolName: 'Edit',
      input: { file_path: 'a.ts', old_string: 'b', new_string: 'B' },
      status: 'ok',
      result: {
        details: { patch: '--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +10,3 @@\n a\n-b\n+B\n c\n' },
      },
    });
    expect(diff?.rows).toEqual([
      { kind: 'same', text: 'a', oldLine: 10, newLine: 10 },
      { kind: 'del', text: 'b', oldLine: 11 },
      { kind: 'add', text: 'B', newLine: 11 },
      { kind: 'same', text: 'c', oldLine: 12, newLine: 12 },
    ]);
    expect(diffHasLineNumbers(diff?.rows ?? [])).toBe(true);
  });

  it('a whole-file write numbers the new file from 1', () => {
    const diff = deriveToolDiff({ toolName: 'Write', input: { file_path: 'a', content: 'x\ny' } });
    expect(diff?.rows.map((row) => row.newLine)).toEqual([1, 2]);
  });

  it('an argument preview has no position in the file, so no numbers are invented', () => {
    const diff = deriveToolDiff({
      toolName: 'edit',
      input: { path: 'a.ts', oldText: 'before', newText: 'after' },
    });
    expect(diffHasLineNumbers(diff?.rows ?? [])).toBe(false);
  });
});

describe('folding unchanged runs', () => {
  it('keeps 3 lines either side of a change and folds the rest', () => {
    const rows: ToolDiffLineRow[] = [
      ...Array.from({ length: 10 }, (_, i) => same(i + 1)),
      { kind: 'add', text: 'new', newLine: 11 },
      ...Array.from({ length: 10 }, (_, i) => ({ ...same(i + 11), newLine: i + 12 })),
    ];
    const items = buildDiffView(rows);
    expect(DIFF_CONTEXT_LINES).toBe(3);
    expect(items.map((item) => item.kind)).toEqual([
      'fold',
      'row',
      'row',
      'row',
      'row',
      'row',
      'row',
      'row',
      'fold',
    ]);
    expect(items[0]).toMatchObject({ kind: 'fold', count: 7, start: 0 });
    expect(items.at(-1)).toMatchObject({ kind: 'fold', count: 7, start: 14 });
  });

  it('an opened fold shows its rows in place', () => {
    const rows: ToolDiffLineRow[] = [
      ...Array.from({ length: 6 }, (_, i) => same(i + 1)),
      { kind: 'del', text: 'gone', oldLine: 7 },
    ];
    const closed = buildDiffView(rows);
    expect(closed[0]).toMatchObject({ kind: 'fold', count: 3, key: 'fold-0' });
    const opened = buildDiffView(rows, new Set(['fold-0']));
    expect(opened.every((item) => item.kind === 'row')).toBe(true);
    expect(opened).toHaveLength(7);
  });

  it('never folds a single row: the fold would cost the row it hides', () => {
    const rows: ToolDiffLineRow[] = [
      same(1),
      same(2),
      same(3),
      same(4),
      { kind: 'add', text: 'x', newLine: 5 },
    ];
    expect(buildDiffView(rows).every((item) => item.kind === 'row')).toBe(true);
  });

  it('a diff with no change folds nothing; one with only changes has nothing to fold', () => {
    const unchanged = Array.from({ length: 20 }, (_, i) => same(i + 1));
    expect(buildDiffView(unchanged)).toHaveLength(20);
    const write = deriveToolDiff({
      toolName: 'Write',
      input: { file_path: 'a', content: 'a\nb\nc' },
    });
    expect(buildDiffView(write?.rows ?? []).every((item) => item.kind === 'row')).toBe(true);
  });

  it('marks the jump between two SDK hunks, which the patch does not carry', () => {
    const rows: ToolDiffLineRow[] = [
      { kind: 'add', text: 'a', newLine: 2 },
      same(3),
      { kind: 'add', text: 'b', newLine: 40 },
    ];
    // Hunk 2 starts at line 40: rows 1 -> 2 are not contiguous.
    const items = buildDiffView(rows);
    expect(items.map((item) => item.kind)).toEqual(['row', 'row', 'gap', 'row']);
  });
});
