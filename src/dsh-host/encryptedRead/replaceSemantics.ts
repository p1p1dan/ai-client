/**
 * The literal search/replace semantics `editText` applies to decrypted
 * plaintext (dsh-rebase P1-13d; decision 135). A pure, DSH-free restatement of
 * `@deepseek-ai/dsh-fs-local`'s `normalizeLineEndings` / `detectLineEndings` /
 * `restoreLineEndings` / `applyLiteralEdit`, so the encrypted-edit path can
 * reuse dsh-fs-local's own write-back and version guard without copying its
 * read-match-write critical section, and so this half is unit-tested on every
 * platform.
 *
 * Every message and code here is dsh-fs-local's, verbatim: a caller that
 * already handles the unencrypted edit handles this one with no new branch.
 */

/** The host's `FsError` shape; injected so this module stays import-free. */
import type { FsErrorCtor } from './dshTypes.ts';

/** The caller's edit request, as dsh-tool-fs passes it to `editText`. */
export interface LiteralEdit {
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean;
}

/** LF-normalized content plus the style to restore when writing back. */
export type LineEndings = 'LF' | 'CRLF';

/** How much of the file decides the line-ending style, as dsh-fs-local samples. */
const LINE_ENDING_SAMPLE_CHARS = 4096;

/** Collapse CRLF to LF — the canonical in-memory form every edit uses. */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n');
}

/**
 * The file's dominant line-ending style, from its first 4096 characters:
 * CRLF only when the pairs outnumber the lone LFs, exactly as
 * dsh-fs-local's `detectLineEndings` decides it.
 */
export function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, LINE_ENDING_SAMPLE_CHARS);
  const crlfCount = sample.split('\r\n').length - 1;
  return crlfCount > sample.split('\n').length - 1 - crlfCount ? 'CRLF' : 'LF';
}

/**
 * Put LF-normalized content back into the file's own line-ending style. `LF`
 * returns it unchanged; `CRLF` normalizes first so an already-CRLF sequence is
 * never doubled to `\r\r\n`.
 */
export function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n');
}

/** Count non-overlapping occurrences of `needle` in `content`. */
function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  for (;;) {
    const found = content.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

/**
 * Apply a literal replacement to LF-normalized content, raising
 * dsh-fs-local's own codes: an empty or missing `oldString` is
 * `FS_EDIT_NOT_FOUND`, and several matches are `FS_AMBIGUOUS_EDIT` unless
 * `replaceAll` is true. CRLF inside either string is normalized to LF before
 * matching, so a model that quotes a Windows file's text literally still
 * matches.
 */
export function applyLiteralEdit(
  content: string,
  edit: LiteralEdit,
  displayPath: string,
  createError: FsErrorCtor
): { readonly content: string; readonly replacements: number } {
  const oldNorm = normalizeLineEndings(edit.oldString);
  if (oldNorm.length === 0) {
    throw new createError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND');
  }
  const newNorm = normalizeLineEndings(edit.newString);
  const replacements = countOccurrences(content, oldNorm);
  if (replacements === 0) {
    throw new createError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND');
  }
  if (edit.replaceAll !== true && replacements > 1) {
    throw new createError(
      `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
      'FS_AMBIGUOUS_EDIT'
    );
  }
  return { content: content.split(oldNorm).join(newNorm), replacements };
}
