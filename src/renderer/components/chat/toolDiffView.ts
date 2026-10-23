/**
 * Issue #26 item 2: how an inline diff is laid out — line numbers where the
 * source has them, and unchanged runs folded down to the 3 lines either side
 * of a change, the rest as one 「N 行未改动」 row the reader can open.
 *
 * Pure, so the folding rule is tested without a DOM. Which folds are open is
 * the component's state (a set of fold keys); this only reads it.
 */
import type { ToolDiffLineRow } from './toolDiff';

/** Unchanged lines kept on each side of a change (the usual unified-diff context). */
export const DIFF_CONTEXT_LINES = 3;

export type DiffViewItem =
  | { kind: 'row'; row: ToolDiffLineRow; key: string }
  /** `count` unchanged rows, `start`..`start + count - 1`, folded; `key` names it. */
  | { kind: 'fold'; count: number; start: number; key: string }
  /** Two SDK hunks with lines between them the patch does not carry. */
  | { kind: 'gap'; key: string };

/** Does this diff carry line numbers at all? (Argument previews do not.) */
export function diffHasLineNumbers(rows: readonly ToolDiffLineRow[]): boolean {
  return rows.some((row) => row.oldLine !== undefined || row.newLine !== undefined);
}

/** The line after `row` on each side, to tell one hunk from the next. */
function continues(previous: ToolDiffLineRow, row: ToolDiffLineRow): boolean {
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

/**
 * The diff's items in order. A run of unchanged rows keeps `context` rows next
 * to each change it borders; what is left folds when it is at least two rows
 * (folding one row would cost the row it hides). A diff with no change at all
 * folds nothing. `open` holds the keys of folds the reader opened.
 */
export function buildDiffView(
  rows: readonly ToolDiffLineRow[],
  open: ReadonlySet<string> = new Set(),
  context: number = DIFF_CONTEXT_LINES
): DiffViewItem[] {
  const changed = rows.map((row) => row.kind !== 'same');
  const anyChange = changed.some(Boolean);
  // Distance (in rows) to the nearest change, either side.
  const near: boolean[] = rows.map(() => !anyChange);
  if (anyChange) {
    rows.forEach((_, index) => {
      for (let offset = -context; offset <= context; offset += 1) {
        if (changed[index + offset]) {
          near[index] = true;
          return;
        }
      }
    });
  }

  const items: DiffViewItem[] = [];
  const emit = (at: number) => {
    const row = rows[at] as ToolDiffLineRow;
    const previous = rows[at - 1];
    // Only between two rows both on screen: a fold already says lines are hidden.
    if (previous && items.at(-1)?.key === `row-${at - 1}` && !continues(previous, row)) {
      items.push({ kind: 'gap', key: `gap-${at}` });
    }
    items.push({ kind: 'row', row, key: `row-${at}` });
  };
  let index = 0;
  while (index < rows.length) {
    if (near[index]) {
      emit(index);
      index += 1;
      continue;
    }
    let end = index;
    while (end < rows.length && !near[end]) end += 1;
    const count = end - index;
    const key = `fold-${index}`;
    if (count < 2 || open.has(key)) {
      for (let at = index; at < end; at += 1) emit(at);
    } else {
      items.push({ kind: 'fold', count, start: index, key });
    }
    index = end;
  }
  return items;
}
