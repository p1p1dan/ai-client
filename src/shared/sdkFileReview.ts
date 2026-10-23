/**
 * Issue #27: the session-changes review record (`SessionFileChange`) of a
 * Claude Agent SDK `Edit` / `Write` call, built from the result the CLI keeps
 * beside the model's text — `tool_use_result` on the live user message,
 * `toolUseResult` on the transcript row (`FileEditOutput` /
 * `FileWriteOutput` in the SDK's `sdk-tools.d.ts`):
 *
 *   Edit   { filePath, oldString, newString, originalFile, structuredPatch, staged? }
 *   Write  { type: 'create' | 'update', filePath, content, originalFile, structuredPatch }
 *
 * `structuredPatch` is the CLI's own hunks with their line numbers, so the
 * patch keeps real `@@ -a,b +c,d @@` headers. A created file has no hunks;
 * its patch is the written content from line 1, as DSH's (`dshFileReview.ts`).
 *
 * Pure: the host's live `tool.completed` and its transcript reader build the
 * same record from the same object.
 */

import { createdPatch, withPatch } from './dshFileReview.ts';
import type { SessionFileChange } from './sessionFileChange.ts';

type Row = Record<string, unknown>;

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

function recordOf(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

/** The CLI's hunks, or undefined when any of them is not one. */
function hunksOf(value: unknown): Hunk[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hunks: Hunk[] = [];
  for (const raw of value) {
    const hunk = recordOf(raw);
    if (!hunk) return undefined;
    const { oldStart, oldLines, newStart, newLines, lines } = hunk;
    if (
      typeof oldStart !== 'number' ||
      typeof oldLines !== 'number' ||
      typeof newStart !== 'number' ||
      typeof newLines !== 'number' ||
      !Array.isArray(lines) ||
      !lines.every((line) => typeof line === 'string')
    ) {
      return undefined;
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: lines as string[] });
  }
  return hunks;
}

/**
 * The review record of one successful file-tool result, or undefined for any
 * other result, an edit held for review (`staged`, the file is unchanged), or
 * an update whose diff the CLI gave up on — the row falls back to its argument
 * preview then.
 */
export function sdkFileReview(result: unknown): SessionFileChange | undefined {
  const r = recordOf(result);
  if (!r || typeof r.filePath !== 'string' || r.filePath.length === 0) return undefined;
  const isWrite = r.type === 'create' || r.type === 'update';
  if (!isWrite && typeof r.oldString !== 'string') return undefined;
  if (r.staged === true) return undefined;
  const hunks = hunksOf(r.structuredPatch);
  if (!hunks) return undefined;
  const created = r.type === 'create';
  const base: SessionFileChange = {
    version: 1,
    path: r.filePath,
    status: created ? 'added' : 'modified',
  };
  if (hunks.length === 0) {
    if (created) {
      if (typeof r.content !== 'string') return base;
      if (r.content.includes('\0')) return { ...base, unavailable: 'binary' };
      return withPatch(base, createdPatch(r.content));
    }
    // An update's empty patch: nothing changed, the old file was too large to
    // keep, or the diff timed out.
    if (isWrite && r.originalFile === null) return { ...base, unavailable: 'too-large' };
    if (isWrite && r.originalFile !== r.content) return undefined;
    return { ...base, patch: '' };
  }
  if (hunks.some((hunk) => hunk.lines.some((line) => line.includes('\0')))) {
    return { ...base, unavailable: 'binary' };
  }
  const out: string[] = [];
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    out.push(...hunk.lines);
  }
  return withPatch(base, out.join('\n'));
}
