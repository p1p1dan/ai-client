import { PI_TOOL_NAMES } from './piToolNames';

/**
 * T12-b slice 2 — turn an `edit`/`write` call's ARGUMENTS into a diff.
 *
 * Expanding one of these rows today shows the raw argument JSON: an `oldText`
 * and a `newText` blob with escaped newlines, side by side in a `<pre>`. That
 * is the least readable presentation of the one tool call users most need to
 * read, because it is the only one that CHANGES their files.
 *
 * Derived from the arguments, not from the tool's output: pi's `edit` returns a
 * success string, not a patch, and the arguments already carry both sides
 * exactly (`edits[].oldText` / `edits[].newText`). That also means the preview
 * works for a call that is still running, and for one that was DENIED — where
 * showing what would have happened is the whole point.
 *
 * ## On the diff algorithm
 *
 * A positional compare (line i vs line i, which is what the reference
 * implementation in pi-app does) is wrong the moment line counts differ: insert
 * one line at the top and every following line reads as changed. This uses a
 * standard LCS so an insertion stays an insertion. Written here rather than
 * pulled from a package: `diff` is present in the tree but only as a
 * TRANSITIVE dependency (it disappears the day its parent drops it), and the
 * one direct diff dependency (`@pierre/diffs`) has no usages in `src/` at all.
 * A ~35-line textbook algorithm with its own tests is the smaller liability.
 */

export type ToolDiffRowKind = 'same' | 'add' | 'del';

export interface ToolDiffRow {
  kind: ToolDiffRowKind;
  text: string;
}

export interface ToolDiff {
  /** File the change lands in, when the arguments name one. */
  path?: string;
  rows: ToolDiffRow[];
  added: number;
  removed: number;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringField(rec: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = rec?.[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read the `oldText`/`newText` pairs off an `edit` call.
 *
 * Field-name tolerant on purpose: pi's schema says `oldText`/`newText`, but the
 * same tool shape reaches us from other dialects (`old_string`/`new_string` is
 * Claude's), and an unrecognised spelling would silently render an
 * all-insertions diff — which looks like a plausible answer rather than a
 * failure, so it would not get reported.
 */
function editPairs(rec: Record<string, unknown> | undefined): Array<[string, string]> {
  const edits = rec?.edits;
  if (!Array.isArray(edits)) return [];
  const pairs: Array<[string, string]> = [];
  for (const raw of edits) {
    const edit = asRecord(raw);
    if (!edit) continue;
    const before = stringField(edit, 'oldText') ?? stringField(edit, 'old_string');
    const after = stringField(edit, 'newText') ?? stringField(edit, 'new_string');
    if (before === undefined && after === undefined) continue;
    pairs.push([before ?? '', after ?? '']);
  }
  return pairs;
}

function countRows(rows: readonly ToolDiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'add') added += 1;
    else if (row.kind === 'del') removed += 1;
  }
  return { added, removed };
}

/**
 * The diff for a tool call, or `null` when this call is not a file change.
 *
 * `null` is not a failure — it means "no better view than the default", and the
 * row keeps its existing raw input/output body.
 */
export function deriveToolDiff(run: { toolName: string; input: unknown }): ToolDiff | null {
  const rec = asRecord(run.input);
  const path = stringField(rec, 'path') ?? stringField(rec, 'file_path');

  // Both dialects, for the same reason `editPairs` reads both field spellings:
  // gating on pi's lowercase names alone would have made that tolerance
  // unreachable — a branch that cannot run, which is how a "we handle that"
  // comment outlives the code that handled it. (Caught by its own test.)
  if (run.toolName === PI_TOOL_NAMES.write || run.toolName === 'Write') {
    const content = stringField(rec, 'content');
    if (content === undefined) return null;
    // A write has no "before" — every line is an insertion. Still worth
    // rendering: it puts the new file's contents on screen in reading order
    // instead of as one escaped JSON string.
    const rows = lineDiffRows('', content);
    return { path, rows, ...countRows(rows) };
  }

  if (
    run.toolName === PI_TOOL_NAMES.edit ||
    run.toolName === 'Edit' ||
    run.toolName === 'MultiEdit'
  ) {
    const pairs = editPairs(rec);
    if (pairs.length === 0) return null;
    // Multiple hunks concatenate. They are separate regions of the file, but
    // pi gives no line numbers to place them by, so inventing a separator with
    // fake positions would be inventing information.
    const rows = pairs.flatMap(([before, after]) => lineDiffRows(before, after));
    return { path, rows, ...countRows(rows) };
  }

  return null;
}
