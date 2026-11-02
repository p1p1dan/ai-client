// New in PiLab R2 (FR-05.5): approval cards of both engines show the change as a diff.
/**
 * PiLab R2 (FR-05.5): what an edit or write approval card shows — the change
 * as a diff against the file as it is now, with its real line numbers (the
 * way Claude Code's own edit prompt reads), instead of the call's argument
 * JSON. Shared by the DSH host's request builder and the Claude SDK host's
 * `describeCall`, so the two engines' cards say the same thing.
 *
 * The result rides on the existing `PermissionFileChange.diff` (a unified
 * diff string), which 1.0.x's Codex path already filled and the card already
 * counts. It is a preview only: the tool still applies its own arguments.
 */
import { diffHunks, formatPatch, hunkRows } from '../diffPatch.ts';
import { lineDiffRows, numberedLineDiff, type ToolDiffLineRow } from '../textDiff.ts';

/** Rows a card's diff keeps; the rest is dropped and the change marked truncated. */
export const APPROVAL_DIFF_MAX_ROWS = 400;

/** Files above this are not read for a preview; the card falls back to the arguments. */
export const APPROVAL_DIFF_MAX_FILE_BYTES = 1024 * 1024;

/** What reading the target file before the card gave. */
export type ApprovalFileRead =
  | { kind: 'text'; text: string }
  /** No file there: a write creates it. */
  | { kind: 'missing' }
  /** Present but not read: too large, not text, encrypted, or the read failed. */
  | { kind: 'unreadable' };

/**
 * Why the diff is the arguments' own before/after snippets rather than the
 * file's: it could not be read, it does not exist (`no-file`), or the text to
 * replace is not in it (`not-found`) / is in it more than once without
 * `replace_all` (`ambiguous`) — the last three are what the tool would refuse.
 */
export type ApprovalDiffNote = 'unreadable' | 'not-found' | 'ambiguous' | 'no-file';

export interface ApprovalFileDiff {
  /** Unified diff; bare `@@` hunks when `note` is set (no line numbers). */
  diff: string;
  truncated?: true;
  /** The write creates the file. */
  created?: true;
  note?: ApprovalDiffNote;
  /** `replace_all` edits: how many matches the file has. */
  replacements?: number;
  /** A `replace_all` edit whose matches could not be counted (`note` is set). */
  replaceAll?: true;
}

/** The fields of a `PermissionFileChange` an approval diff fills in. */
export function fileChangeDiffFields(diff: ApprovalFileDiff) {
  return {
    diff: diff.diff,
    ...(diff.truncated ? { truncated: true } : {}),
    ...(diff.note ? { note: diff.note } : {}),
    ...(diff.replacements !== undefined ? { replacements: diff.replacements } : {}),
    ...(diff.replaceAll ? { replaceAll: true } : {}),
  };
}

export interface LiteralEditArgs {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export type ApprovalFileCall =
  | { tool: 'write'; content: string }
  | { tool: 'edit'; edits: readonly LiteralEditArgs[] };

/** The `%TSD-Header-###%` an encrypted file starts with when read raw (encryptedRead). */
const TSD_HEADER_TEXT = '%TSD-Header-###%';

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * An edit's replacements from its arguments: one `old_string`/`new_string`
 * pair, or a MultiEdit's `edits`. `null` when any pair is incomplete.
 */
export function literalEditsOf(args: unknown): LiteralEditArgs[] | null {
  if (typeof args !== 'object' || args === null) return null;
  const record = args as Record<string, unknown>;
  const raw = Array.isArray(record.edits) ? record.edits : [record];
  const edits: LiteralEditArgs[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const edit = item as Record<string, unknown>;
    const oldString = stringField(edit, 'old_string', 'oldText');
    const newString = stringField(edit, 'new_string', 'newText');
    if (oldString === undefined || newString === undefined) return null;
    edits.push({ oldString, newString, replaceAll: edit.replace_all === true });
  }
  return edits.length ? edits : null;
}

const lf = (text: string) => text.replaceAll('\r\n', '\n');

function countMatches(content: string, needle: string): number {
  let count = 0;
  for (
    let index = content.indexOf(needle);
    index !== -1;
    index = content.indexOf(needle, index + needle.length)
  ) {
    count += 1;
  }
  return count;
}

/** Each edit's own before/after, one region per edit. */
function snippetRows(edits: readonly LiteralEditArgs[]): ToolDiffLineRow[] {
  return edits.flatMap((edit, index) =>
    lineDiffRows(lf(edit.oldString), lf(edit.newString)).map(
      (row, at): ToolDiffLineRow => (index > 0 && at === 0 ? { ...row, hunkStart: true } : row)
    )
  );
}

function finish(
  path: string,
  rows: ToolDiffLineRow[],
  extra: Omit<ApprovalFileDiff, 'diff' | 'truncated'>
): ApprovalFileDiff {
  const truncated = rows.length > APPROVAL_DIFF_MAX_ROWS;
  const kept = truncated ? rows.slice(0, APPROVAL_DIFF_MAX_ROWS) : rows;
  return {
    diff: formatPatch([{ path, rows: kept, ...(extra.created ? { created: true } : {}) }]),
    ...(truncated ? { truncated: true as const } : {}),
    ...extra,
  };
}

/**
 * The card's diff for one write or edit. Matching follows both engines' edit
 * tools: literal, line endings normalized to LF, an empty `old_string` never
 * matches. `undefined` when there is nothing to show (an edit that changes
 * nothing).
 */
export function approvalFileDiff(
  path: string,
  call: ApprovalFileCall,
  file: ApprovalFileRead
): ApprovalFileDiff | undefined {
  const read: ApprovalFileRead =
    file.kind === 'text' && file.text.startsWith(TSD_HEADER_TEXT) ? { kind: 'unreadable' } : file;
  if (call.tool === 'write') {
    const after = lf(call.content);
    if (read.kind === 'unreadable') {
      return finish(path, lineDiffRows('', after), { note: 'unreadable' });
    }
    const before = read.kind === 'text' ? lf(read.text) : '';
    const rows = hunkRows(diffHunks(numberedLineDiff(before, after)));
    if (rows.length === 0) return undefined;
    return finish(path, rows, read.kind === 'missing' ? { created: true } : {});
  }
  const [only] = call.edits;
  if (read.kind === 'missing' && call.edits.length === 1 && only?.oldString === '') {
    // Claude's Edit creates a missing file from an empty `old_string`.
    return approvalFileDiff(path, { tool: 'write', content: only.newString }, read);
  }
  // A snippet diff cannot count matches, so a replace-all says so in words.
  const replaceAll = call.edits.some((edit) => edit.replaceAll)
    ? { replaceAll: true as const }
    : {};
  if (read.kind !== 'text') {
    const rows = snippetRows(call.edits);
    const note = read.kind === 'missing' ? ('no-file' as const) : ('unreadable' as const);
    return rows.length ? finish(path, rows, { note, ...replaceAll }) : undefined;
  }
  const before = lf(read.text);
  let after = before;
  let replacements = 0;
  for (const edit of call.edits) {
    const needle = lf(edit.oldString);
    const matches = needle ? countMatches(after, needle) : 0;
    if (matches === 0 || (matches > 1 && !edit.replaceAll)) {
      return finish(path, snippetRows(call.edits), {
        note: matches === 0 ? 'not-found' : 'ambiguous',
        ...replaceAll,
      });
    }
    if (edit.replaceAll) replacements += matches;
    after = after.split(needle).join(lf(edit.newString));
  }
  const rows = hunkRows(diffHunks(numberedLineDiff(before, after)));
  if (rows.length === 0) return undefined;
  return finish(path, rows, replacements > 0 ? { replacements } : {});
}
