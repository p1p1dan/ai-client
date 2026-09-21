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
