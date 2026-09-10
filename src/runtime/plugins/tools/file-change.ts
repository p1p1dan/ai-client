import { REVIEW_PATCH_BYTES, type SessionFileChange } from '../../../shared/sessionFileChange.ts';
import { diffLineArrays, type ToolDiffRow } from '../../../shared/textDiff.ts';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode } from '../../host/errors.ts';

export const REVIEW_FILE_BYTES = 256 * 1024;
// Per side, as PI-Desktop's review.rs MAX_DIFF_LINES.
const REVIEW_LINES = 4000;

export type BeforeContent =
  | { text: string | null }
  | { unavailable: NonNullable<SessionFileChange['unavailable']> };

export async function readBeforeChange(
  io: RuntimeHostIoService,
  path: string,
  signal?: AbortSignal
): Promise<BeforeContent> {
  try {
    const data = await io.readFile(path, {
      maxBytes: REVIEW_FILE_BYTES,
      overflow: 'truncate',
      signal,
    });
    if (data.truncated) return { unavailable: 'too-large' };
    if (data.bytes.includes(0)) return { unavailable: 'binary' };
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(data.bytes) };
  } catch (error) {
    signal?.throwIfAborted();
    if (errorCode(error) === 'ENOENT') return { text: null };
    return { unavailable: 'unreadable' };
  }
}

function lines(text: string): string[] {
  if (!text) return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function createFileChange(
  path: string,
  before: BeforeContent,
  after: string
): SessionFileChange {
  // A truncated or binary read still proves the file existed; only a failed
  // read leaves that open.
  const existed = 'text' in before ? before.text !== null : before.unavailable !== 'unreadable';
  const base: SessionFileChange = {
    version: 1,
    path,
    status: existed ? 'modified' : 'text' in before ? 'added' : 'unknown',
  };
  if ('unavailable' in before) return { ...base, unavailable: before.unavailable };
  if (
    Buffer.byteLength(before.text ?? '') > REVIEW_FILE_BYTES ||
    Buffer.byteLength(after) > REVIEW_FILE_BYTES
  )
    return { ...base, unavailable: 'too-large' };
  if ((before.text ?? '').includes('\0') || after.includes('\0'))
    return { ...base, unavailable: 'binary' };
  const oldLines = lines(before.text ?? '');
  const newLines = lines(after);
  if (oldLines.length > REVIEW_LINES || newLines.length > REVIEW_LINES)
    return { ...base, unavailable: 'too-large' };

  let prefix = 0;
  while (prefix < oldLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix++;
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  if (oldMiddle.length * newMiddle.length > 1_000_000) return { ...base, unavailable: 'too-large' };

  const rows: ToolDiffRow[] = [
    ...oldLines.slice(0, prefix).map((text) => ({ kind: 'same' as const, text })),
    ...diffLineArrays(oldMiddle, newMiddle),
    ...oldLines.slice(oldLines.length - suffix).map((text) => ({ kind: 'same' as const, text })),
  ];
  const ranges: Array<{ start: number; end: number }> = [];
  rows.forEach((row, index) => {
    if (row.kind === 'same') return;
    const start = Math.max(0, index - 3);
    const end = Math.min(rows.length, index + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = end;
    else ranges.push({ start, end });
  });
  const patch: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const range of ranges) {
    while (cursor < range.start) {
      if (rows[cursor].kind !== 'add') oldLine++;
      if (rows[cursor].kind !== 'del') newLine++;
      cursor++;
    }
    const hunk = rows.slice(range.start, range.end);
    const oldCount = hunk.filter((row) => row.kind !== 'add').length;
    const newCount = hunk.filter((row) => row.kind !== 'del').length;
    patch.push(
      `@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`
    );
    for (const row of hunk) {
      const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
      patch.push(marker + row.text.replace(/\n$/, ''));
      if (!row.text.endsWith('\n')) patch.push('\\ No newline at end of file');
      if (row.kind !== 'add') oldLine++;
      if (row.kind !== 'del') newLine++;
      cursor++;
    }
  }
  const value = patch.join('\n');
  return Buffer.byteLength(value) > REVIEW_PATCH_BYTES
    ? { ...base, unavailable: 'too-large' }
    : { ...base, patch: value };
}
