/**
 * T-13 spec §3 "光标映射": maps a `FileOpenIntent`'s `line`/`endLine` into the
 * args `useEditor().navigateToFile(path, line, column, matchLength)` expects.
 *
 * `EditorArea`'s pending-cursor effect is frozen (#12) and only ever builds a
 * SAME-LINE selection (`endLineNumber: line`, `endColumn: startColumn +
 * matchLength` — see `EditorArea.tsx`'s two `pendingCursor` effects). A
 * genuine multi-line range (anchored at `line`, extending through `endLine`)
 * is therefore not representable without touching that frozen file — flagged
 * as a spec gap, not silently worked around.
 *
 * What IS representable today: selecting the entirety of the anchor line.
 * `WHOLE_LINE_MATCH_LENGTH` is a deliberately oversized `matchLength`; Monaco
 * clamps an out-of-range `endColumn` to the model's actual line length, so
 * this reliably highlights "the whole line" without needing the file's
 * content here (this function is pure — no model access). This is the
 * documented, correct use of `matchLength`; the bug this function exists to
 * prevent (Codex's finding) is deriving `matchLength` from `endLine - line`,
 * which is a LINE count fed into a field that only ever means a same-line
 * CHARACTER count — that silently produces a nonsense short/negative
 * selection instead of highlighting anything meaningful.
 */
export interface CursorTarget {
  line: number;
  column: number;
  matchLength?: number;
}

export const WHOLE_LINE_MATCH_LENGTH = Number.MAX_SAFE_INTEGER;

export interface FileIntentCursorInput {
  line?: number;
  endLine?: number;
}

/**
 * - No `line` → `undefined` (nothing to navigate to).
 * - `line` only → cursor at line start, no selection ("行首").
 * - `endLine` present (and different from `line`) → whole-line selection
 *   anchored at `line` (see module doc for why this doesn't reach `endLine`).
 */
export function fileIntentToCursor(intent: FileIntentCursorInput): CursorTarget | undefined {
  if (intent.line === undefined) {
    return undefined;
  }
  if (intent.endLine !== undefined && intent.endLine !== intent.line) {
    return { line: intent.line, column: 0, matchLength: WHOLE_LINE_MATCH_LENGTH };
  }
  return { line: intent.line, column: 0 };
}
