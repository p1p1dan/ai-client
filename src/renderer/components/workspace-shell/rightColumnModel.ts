/**
 * dsh-rebase P1-11 (decisions 109, 126, 128): who holds the right column.
 *
 * Three occupants share one column and one width (`--shell-editor-w`), and at
 * most one shows. They stack: the session review on top, then the terminal
 * when it is in front, then the file editor. Closing the one on top reveals
 * the next, which is how "close the terminal and the file tabs come back
 * exactly as they were" (decision 126 rule 1) holds without remembering
 * anything: the editor's tabs never left the store.
 *
 * Pure so vitest's node environment covers it.
 */

export type RightColumnOccupant = 'review' | 'terminal' | 'editor' | null;

export function resolveRightColumnOccupant(input: {
  reviewOpen: boolean;
  /** The terminal of the folder on screen exists and is in front. */
  terminalFront: boolean;
  editorOpen: boolean;
}): RightColumnOccupant {
  if (input.reviewOpen) return 'review';
  if (input.terminalFront) return 'terminal';
  if (input.editorOpen) return 'editor';
  return null;
}

/**
 * The session bar's terminal button.
 *
 * - `unavailable`: the conversation has no folder (decision 126 rule 2) — the
 *   button is disabled and says why; there is no fallback directory.
 * - `closed`: no shell for this folder yet; a click starts one.
 * - `hidden`: the folder's shell is running behind the editor or the review;
 *   a click brings the same shell back. Marked, so a running process is never
 *   invisible.
 * - `open`: the terminal is what the column shows; a click hides it.
 */
export type TerminalButtonState = 'unavailable' | 'closed' | 'hidden' | 'open';

export function deriveTerminalButtonState(input: {
  /** The conversation resolves to a folder with a usable path. */
  available: boolean;
  /** A shell for that folder is running. */
  alive: boolean;
  /** `resolveRightColumnOccupant(...) === 'terminal'`. */
  visible: boolean;
}): TerminalButtonState {
  if (!input.available) return 'unavailable';
  if (input.visible) return 'open';
  return input.alive ? 'hidden' : 'closed';
}
