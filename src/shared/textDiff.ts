export type ToolDiffRowKind = 'same' | 'add' | 'del';

export interface ToolDiffRow {
  kind: ToolDiffRowKind;
  text: string;
}

/**
 * Issue #26 item 2: a row with its line numbers, where the source knows them —
 * an SDK patch's hunk headers, a whole-file write. An argument preview has no
 * position in the file, so it carries none rather than invented ones.
 */
export interface ToolDiffLineRow extends ToolDiffRow {
  /** Line in the old file (`same` / `del`). */
  oldLine?: number;
  /** Line in the new file (`same` / `add`). */
  newLine?: number;
  /**
   * PiLab R2 (FR-07.4): the first row of a hunk that is a separate region of
   * the file. A DSH patch's bare `@@` and a multi-edit's pairs carry no line
   * numbers, so this is the only way the view knows to put 「⋯」 between them.
   */
  hunkStart?: true;
  /** PiLab R2 (FR-07.5): this line has no newline after it (`\ No newline at end of file`). */
  noFinalNewline?: true;
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
  // PiLab R2 (FR-07.4): lines both sides share at the start and end are the
  // same rows whatever the middle does, so only the middle goes through the
  // table — a one-line change in a 1001-line file no longer trips the bound
  // below and turns into 1001 deletions and 1001 additions.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  if (head === 0 && tail === 0) return diffMiddle(a, b);
  const same = (text: string): ToolDiffRow => ({ kind: 'same', text });
  return [
    ...a.slice(0, head).map(same),
    ...diffMiddle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map(same),
  ];
}

function diffMiddle(a: readonly string[], b: readonly string[]): ToolDiffRow[] {
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

/**
 * Whether two texts differ only in line endings. Git hands back the blob as
 * stored (LF) while a `core.autocrlf` checkout has CRLF on disk, so a clean
 * file compares unequal byte for byte; Monaco's diff ignores line endings too
 * and would show such a pair as a blank editor.
 */
export function sameIgnoringLineEndings(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

/** A text's lines, without the empty one a final newline would split off. */
function textLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text === '') return { lines: [], finalNewline: true };
  const finalNewline = text.endsWith('\n');
  return { lines: (finalNewline ? text.slice(0, -1) : text).split('\n'), finalNewline };
}

/**
 * PiLab R2 (07.9 / FR-05.5): a whole-file diff with each row's line numbers —
 * what a patch and the approval card's preview are built from. A final newline
 * ends the last line rather than adding an empty one, and a last line whose
 * newline is added or dropped reads as changed, the way `git diff` shows it.
 */
export function numberedLineDiff(oldText: string, newText: string): ToolDiffLineRow[] {
  const before = textLines(oldText);
  const after = textLines(newText);
  const rows: ToolDiffRow[] = diffLineArrays(before.lines, after.lines);
  const last = rows.at(-1);
  if (last?.kind === 'same' && before.finalNewline !== after.finalNewline) {
    rows.splice(-1, 1, { kind: 'del', text: last.text }, { kind: 'add', text: last.text });
  }
  let oldLine = 0;
  let newLine = 0;
  const numbered = rows.map((row): ToolDiffLineRow => {
    if (row.kind === 'add') return { ...row, newLine: ++newLine };
    if (row.kind === 'del') return { ...row, oldLine: ++oldLine };
    return { ...row, oldLine: ++oldLine, newLine: ++newLine };
  });
  // Mark the row that is each side's last line when that side has no final newline.
  for (const [side, info, total] of [
    ['old', before, oldLine],
    ['new', after, newLine],
  ] as const) {
    if (info.finalNewline || total === 0) continue;
    for (let index = numbered.length - 1; index >= 0; index -= 1) {
      const row = numbered[index] as ToolDiffLineRow;
      if ((side === 'old' ? row.oldLine : row.newLine) !== total) continue;
      row.noFinalNewline = true;
      break;
    }
  }
  return numbered;
}
