export type ToolDiffRowKind = 'same' | 'add' | 'del';

export interface ToolDiffRow {
  kind: ToolDiffRowKind;
  text: string;
}

/** Longest common subsequence table over two line arrays. */
function lcsLengths(a: readonly string[], b: readonly string[]): Uint32Array[] {
  const table: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1)
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/**
 * Line-level diff of two strings.
 *
 * Deletions are emitted before insertions at the same position, which is what
 * makes a replacement read as "was X / now Y" rather than the reverse.
 */
export function lineDiffRows(oldText: string, newText: string): ToolDiffRow[] {
  // An empty side means the whole other side is one block, and splitting ''
  // would otherwise yield [''] — a phantom blank line on every new file.
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  return diffLineArrays(a, b);
}

export function diffLineArrays(a: readonly string[], b: readonly string[]): ToolDiffRow[] {
  // Keep argument previews bounded; large replacements can be shown as a whole hunk.
  if (a.length * b.length > 1_000_000) {
    return [
      ...a.map((text) => ({ kind: 'del' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text })),
    ];
  }
  const table = lcsLengths(a, b);

  const rows: ToolDiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ kind: 'del', text: a[i] });
      i += 1;
    } else {
      rows.push({ kind: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    rows.push({ kind: 'del', text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    rows.push({ kind: 'add', text: b[j] });
    j += 1;
  }
  return rows;
}
