import type { ToolDiffLineRow } from '@/components/chat/toolDiff';

export interface ReviewPatchLine {
  text: string;
  kind: 'add' | 'del' | 'context' | 'meta';
  oldLine?: number;
  newLine?: number;
}

/** Hunk coordinates are the only source of line numbers; previews have none. */
export function reviewPatchLines(patch: string): ReviewPatchLine[] {
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  return patch
    .split('\n')
    .filter(Boolean)
    .map((text) => {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[3]);
        oldRemaining = Number(hunk[2] ?? 1);
        newRemaining = Number(hunk[4] ?? 1);
        return { text, kind: 'meta' };
      }
      if (text.startsWith('\\ No newline')) return { text, kind: 'meta' };
      const kind = text.startsWith('+')
        ? 'add'
        : text.startsWith('-')
          ? 'del'
          : text.startsWith(' ')
            ? 'context'
            : 'meta';
      const consumesOld = kind === 'del' || kind === 'context';
      const consumesNew = kind === 'add' || kind === 'context';
      // Stop at the declared hunk boundary. A malformed or missing header must
      // not inherit coordinates from a previous hunk or from a file header.
      if (
        kind === 'meta' ||
        (consumesOld && oldRemaining === 0) ||
        (consumesNew && newRemaining === 0)
      ) {
        oldRemaining = newRemaining = 0;
        return { text, kind };
      }
      const row: ReviewPatchLine = { text, kind };
      if (consumesOld) {
        if (oldLine > 0) row.oldLine = oldLine;
        oldLine += 1;
        oldRemaining -= 1;
      }
      if (consumesNew) {
        if (newLine > 0) row.newLine = newLine;
        newLine += 1;
        newRemaining -= 1;
      }
      return row;
    });
}

/**
 * User, 2026-10-23: the pane draws its diffs the way the timeline does
 * (`buildDiffView`), so an entry becomes `ToolDiffLineRow`s. A preview passes
 * its rows through untouched — they carry the line numbers it has, which the
 * old text round-trip dropped — and a recorded patch keeps its hunk numbers;
 * hunk headers and 「No newline」 markers are not rows (a hunk break shows as
 * the view's own gap).
 */
export function reviewEntryRows(entry: {
  patch?: string;
  preview?: { rows: readonly ToolDiffLineRow[] };
}): ToolDiffLineRow[] {
  if (entry.patch === undefined) return [...(entry.preview?.rows ?? [])];
  const rows: ToolDiffLineRow[] = [];
  for (const line of reviewPatchLines(entry.patch)) {
    if (line.kind === 'meta') continue;
    rows.push({
      kind: line.kind === 'context' ? 'same' : line.kind,
      text: line.text.slice(1),
      ...(line.oldLine !== undefined ? { oldLine: line.oldLine } : {}),
      ...(line.newLine !== undefined ? { newLine: line.newLine } : {}),
    });
  }
  return rows;
}
