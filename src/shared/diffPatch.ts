import type { ToolDiffLineRow } from './textDiff.ts';

/**
 * PiLab R2 (07.9): a diff as a standard unified patch — what 「复制补丁」 puts on
 * the clipboard, so a change can be pasted or `git apply`-ed whole: with its
 * +/- markers and the rows a view had folded away, which a mouse selection
 * loses. Also cuts a whole-file diff down to its hunks (the approval card's
 * preview, FR-05.5).
 */

/** Unchanged lines kept on each side of a change, as `git diff` does. */
export const PATCH_CONTEXT_LINES = 3;

/** Does `row` sit right after `previous` in the file, on each side both number? */
export function rowsContinue(previous: ToolDiffLineRow, row: ToolDiffLineRow): boolean {
  if (row.hunkStart) return false;
  const oldNext =
    previous.oldLine !== undefined
      ? previous.oldLine + (previous.kind === 'add' ? 0 : 1)
      : undefined;
  const newNext =
    previous.newLine !== undefined
      ? previous.newLine + (previous.kind === 'del' ? 0 : 1)
      : undefined;
  if (row.oldLine !== undefined && oldNext !== undefined && row.oldLine !== oldNext) return false;
  if (row.newLine !== undefined && newNext !== undefined && row.newLine !== newNext) return false;
  return true;
}

/** Does this diff carry line numbers at all? (Argument previews do not.) */
export function rowsHaveLineNumbers(rows: readonly ToolDiffLineRow[]): boolean {
  return rows.some((row) => row.oldLine !== undefined || row.newLine !== undefined);
}

export interface DiffHunk {
  rows: ToolDiffLineRow[];
  /** `null` when the rows carry no line numbers: the header is a bare `@@`. */
  header: { oldStart: number; oldCount: number; newStart: number; newCount: number } | null;
}

/** Runs of rows that are contiguous in the file. */
function regions(rows: readonly ToolDiffLineRow[]): ToolDiffLineRow[][] {
  const out: ToolDiffLineRow[][] = [];
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (!previous || !rowsContinue(previous, row)) out.push([]);
    out.at(-1)?.push(row);
  });
  return out;
}

/**
 * Where a side of a hunk starts. With no line on that side, the convention is
 * the line before the insertion point (0 at the top of the file).
 */
function sideStart(
  region: readonly ToolDiffLineRow[],
  from: number,
  to: number,
  side: 'oldLine' | 'newLine'
): number {
  const skip = side === 'oldLine' ? 'add' : 'del';
  let seen = 0;
  for (let index = from; index < to; index += 1) {
    const row = region[index] as ToolDiffLineRow;
    if (row.kind === skip) continue;
    const line = row[side];
    if (line !== undefined) return line - seen;
    seen += 1;
  }
  for (let index = from - 1; index >= 0; index -= 1) {
    const row = region[index] as ToolDiffLineRow;
    const line = row.kind === skip ? undefined : row[side];
    if (line !== undefined) return line;
  }
  for (let index = to; index < region.length; index += 1) {
    const row = region[index] as ToolDiffLineRow;
    const line = row.kind === skip ? undefined : row[side];
    if (line !== undefined) return line - 1;
  }
  return 0;
}

/**
 * The diff's hunks: each change with up to `context` unchanged rows either
 * side, never joined across a break in the file. Rows without line numbers
 * are an argument preview's snippets — each region is one hunk, uncut, since
 * there is no position to say where trimmed context went.
 */
export function diffHunks(
  rows: readonly ToolDiffLineRow[],
  context: number = PATCH_CONTEXT_LINES
): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const region of regions(rows)) {
    const changed = region.flatMap((row, index) => (row.kind === 'same' ? [] : [index]));
    if (changed.length === 0) continue;
    if (!rowsHaveLineNumbers(region)) {
      hunks.push({ rows: [...region], header: null });
      continue;
    }
    const windows: Array<[number, number]> = [];
    for (const index of changed) {
      const from = Math.max(0, index - context);
      const to = Math.min(region.length, index + context + 1);
      const last = windows.at(-1);
      if (last && from <= last[1]) last[1] = to;
      else windows.push([from, to]);
    }
    for (const [from, to] of windows) {
      const slice = region.slice(from, to);
      hunks.push({
        rows: slice,
        header: {
          oldStart: sideStart(region, from, to, 'oldLine'),
          oldCount: slice.filter((row) => row.kind !== 'add').length,
          newStart: sideStart(region, from, to, 'newLine'),
          newCount: slice.filter((row) => row.kind !== 'del').length,
        },
      });
    }
  }
  return hunks;
}

/** The hunks' rows back to back, each later hunk's first row marked `hunkStart`. */
export function hunkRows(hunks: readonly DiffHunk[]): ToolDiffLineRow[] {
  return hunks.flatMap((hunk, index) =>
    hunk.rows.map((row, at) => {
      const { hunkStart: _drop, ...rest } = row;
      return index > 0 && at === 0 ? { ...rest, hunkStart: true as const } : rest;
    })
  );
}

export interface PatchFile {
  /** Repo-relative, `/`-separated (see `patchPath`). */
  path: string;
  rows: readonly ToolDiffLineRow[];
  /** The file did not exist before: `--- /dev/null`. */
  created?: boolean;
}

/**
 * The path a patch header names: relative to `root` when inside it, with `/`
 * separators. A path outside the root stays as given, which `git apply`
 * refuses rather than writing somewhere unexpected.
 */
export function patchPath(path: string, root?: string | null): string {
  const slashed = path.replace(/\\/g, '/');
  const base = root?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && slashed.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
    return slashed.slice(base.length + 1);
  }
  return slashed.replace(/^\.\//, '');
}

const SIGN = { same: ' ', add: '+', del: '-' } as const;

/**
 * Files as one unified patch; `''` when none has a change. Two entries for the
 * same path are two patches in order (a file edited twice), which `git apply`
 * applies one after the other.
 */
export function formatPatch(files: readonly PatchFile[]): string {
  const lines: string[] = [];
  for (const file of files) {
    const hunks = diffHunks(file.rows);
    if (hunks.length === 0) continue;
    lines.push(file.created ? '--- /dev/null' : `--- a/${file.path}`, `+++ b/${file.path}`);
    for (const hunk of hunks) {
      const header = hunk.header;
      lines.push(
        header
          ? `@@ -${header.oldStart},${header.oldCount} +${header.newStart},${header.newCount} @@`
          : '@@'
      );
      for (const row of hunk.rows) {
        lines.push(`${SIGN[row.kind]}${row.text}`);
        if (row.noFinalNewline) lines.push('\\ No newline at end of file');
      }
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
