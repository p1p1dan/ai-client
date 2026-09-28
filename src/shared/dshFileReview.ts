// New in dsh-rebase P1-4d1

/**
 * The session-changes review record (`SessionFileChange`) of a DSH `write` or
 * `edit` call, built from the diff card DSH stored with its result
 * (dsh-rebase decision 099 rule 6). `tool/result.meta` is dsh-tool-fs's
 * `presentationMeta`:
 *
 *   write  { operation: 'create' | 'update', diffs: [{ path, oldText, newText }] }
 *   edit   { diffs: [{ path, oldText, newText }] }
 *
 * Nothing reads the file again, as 1.0.x did before every change
 * (`runtime/plugins/tools/file-change.ts`): DSH already compared the file
 * before and after the call.
 *
 * What the card keeps decides what the record can say:
 *   - a hunk is its text, three lines of context included, but not where it
 *     starts in the file — so an update's patch is its hunks under a bare
 *     `@@` separator and carries no line numbers (the review panel prints
 *     none rather than wrong ones);
 *   - a created file has no hunks at all (`diffs: []`) — its patch is the
 *     call's own `content`, the whole file from line 1.
 *
 * Pure and import-light: the bridge's live `tool.completed` and the history
 * projection build the same record from the same event.
 */

import type { SessionFileChange } from './sessionFileChange.ts';
import { diffLineArrays } from './textDiff.ts';

/** `REVIEW_PATCH_BYTES` of `sessionFileChange.ts`, which loads zod and is out of reach here. */
const PATCH_MAX = 64 * 1024;
/** 1.0.x's bounds for a reviewed file (`REVIEW_FILE_BYTES`, `REVIEW_LINES`). */
const FILE_MAX_BYTES = 256 * 1024;
const FILE_MAX_LINES = 4000;

/** Opens each hunk whose position in the file DSH did not keep. */
export const DSH_HUNK_SEPARATOR = '@@';

type Row = Record<string, unknown>;

interface Hunk {
  path: unknown;
  oldText: string | null;
  newText: string;
}

function recordOf(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

/** UTF-8 length without encoding the text. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** The card's hunks, or undefined when the meta is not a diff card at all. */
function hunksOf(meta: unknown): Hunk[] | undefined {
  const diffs = recordOf(meta)?.diffs;
  if (!Array.isArray(diffs)) return undefined;
  const hunks: Hunk[] = [];
  for (const raw of diffs) {
    const diff = recordOf(raw);
    if (!diff || typeof diff.newText !== 'string') return undefined;
    if (diff.oldText !== null && typeof diff.oldText !== 'string') return undefined;
    hunks.push({ path: diff.path, oldText: diff.oldText, newText: diff.newText });
  }
  return hunks;
}

/** A created file as one hunk from line 1, in 1.0.x's patch format; undefined past 1.0.x's bounds. */
function createdPatch(content: string): string | undefined {
  // Lines keep their newline, so a last line without one is marked as such.
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (utf8Length(content) > FILE_MAX_BYTES || lines.length > FILE_MAX_LINES) return undefined;
  // An empty file has nothing to show, as in 1.0.x.
  if (lines.length === 0) return '';
  const out = [`@@ -0,0 +1,${lines.length} @@`];
  for (const line of lines) {
    out.push(`+${line.replace(/\n$/, '')}`);
    if (!line.endsWith('\n')) out.push('\\ No newline at end of file');
  }
  return out.join('\n');
}

/** The record with its patch, or marked too large for the renderer's bound. */
function withPatch(base: SessionFileChange, patch: string | undefined): SessionFileChange {
  if (patch === undefined || patch.length > PATCH_MAX || utf8Length(patch) > PATCH_MAX) {
    return { ...base, unavailable: 'too-large' };
  }
  return { ...base, patch };
}

/** An update's hunks, each a line diff of its own old and new text. */
function hunkPatch(hunks: readonly Hunk[]): string {
  const out: string[] = [];
  for (const hunk of hunks) {
    // `oldText: null` is a hunk that had no old lines; an empty `newText` has no new ones.
    const oldLines = hunk.oldText === null ? [] : hunk.oldText.split('\n');
    const newLines = hunk.newText === '' ? [] : hunk.newText.split('\n');
    out.push(DSH_HUNK_SEPARATOR);
    for (const row of diffLineArrays(oldLines, newLines)) {
      out.push(`${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${row.text}`);
    }
  }
  return out.join('\n');
}

/**
 * The review record of one successful `write` / `edit` result, or undefined
 * for any other tool, a result without a diff card, or a call that names no
 * file. `args` are the call's parsed arguments.
 */
export function dshFileReview(
  toolName: string | undefined,
  args: unknown,
  meta: unknown
): SessionFileChange | undefined {
  if (toolName !== 'write' && toolName !== 'edit') return undefined;
  const hunks = hunksOf(meta);
  if (!hunks) return undefined;
  const call = recordOf(args);
  const named = [call?.file_path, hunks[0]?.path].find(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  if (!named) return undefined;
  const created = toolName === 'write' && recordOf(meta)?.operation === 'create';
  const base: SessionFileChange = {
    version: 1,
    path: named,
    status: created ? 'added' : 'modified',
  };
  if (created) {
    const content = call?.content;
    if (typeof content !== 'string') return base;
    if (content.includes('\0')) return { ...base, unavailable: 'binary' };
    return withPatch(base, createdPatch(content));
  }
  if (hunks.length === 0) return base;
  if (hunks.some((hunk) => hunk.newText.includes('\0') || hunk.oldText?.includes('\0'))) {
    return { ...base, unavailable: 'binary' };
  }
  return withPatch(base, hunkPatch(hunks));
}
