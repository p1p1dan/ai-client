import type { RuntimeHostIoService } from '../../contracts.ts';
import { RuntimeHostError } from '../../host/errors.ts';

export interface ReadLinesResult {
  text: string;
  truncated: boolean;
  nextOffset: number;
  /** Output ends mid-line: re-read from `nextOffset` for that whole line. */
  partialLine?: boolean;
  /** One line alone exceeds the budget; the rest of it is skipped. */
  longLine?: boolean;
}

/**
 * `ignoreBOM: true` keeps a leading U+FEFF in the text, so whoever writes the
 * string back does not silently drop the file's BOM (tools-05).
 */
export function utf8FileDecoder(): TextDecoder {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
}

/**
 * A binary or non-UTF-8 file reaches the decoder as an invalid sequence. Report
 * it with a contract code instead of the platform TypeError, which tells the
 * model neither which file failed nor what to do about it (tools-12).
 */
export function decodeFileText(
  decoder: TextDecoder,
  bytes: Uint8Array,
  stream: boolean,
  path: string
): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw new RuntimeHostError(
      'io_not_utf8',
      `${path} is not valid UTF-8 text; it is probably a binary file`
    );
  }
}

// HostIo uses byte windows; the model-facing read tool uses one-based lines.
export async function readLines(
  io: RuntimeHostIoService,
  path: string,
  offset: number,
  limit: number,
  maxBytes: number,
  signal?: AbortSignal
): Promise<ReadLinesResult> {
  let position = 0;
  let line = 1;
  let pending = '';
  let used = 0;
  let count = 0;
  let skippingLongLine = false;
  const output: string[] = [];
  const decoder = utf8FileDecoder();
  function accept(value: string): 'accepted' | 'budget' | 'oversize' {
    if (line++ < offset) return 'accepted';
    const bytes = Buffer.from(value);
    if (used + bytes.length > maxBytes) {
      const clipped = decodeFileText(
        utf8FileDecoder(),
        bytes.subarray(0, maxBytes - used),
        true,
        path
      );
      output.push(clipped);
      // Nothing else was in the way, so this one line is bigger than the whole
      // budget: re-reading from it would return the same bytes forever. Any
      // other failure means the window merely filled up, and re-reading the
      // line on its own does make progress (tools-04).
      return used === 0 ? 'oversize' : 'budget';
    }
    output.push(value);
    used += bytes.length;
    count++;
    return 'accepted';
  }
  /** Where the caller must resume after a line that did not fit. */
  function stop(status: 'budget' | 'oversize'): ReadLinesResult {
    return status === 'oversize'
      ? { text: output.join(''), truncated: true, nextOffset: line, longLine: true }
      : { text: output.join(''), truncated: true, nextOffset: line - 1, partialLine: true };
  }
  while (position < 64 * 1024 * 1024) {
    signal?.throwIfAborted();
    const chunk = await io.readFile(path, {
      offset: position,
      maxBytes: 32 * 1024,
      overflow: 'truncate',
      signal,
    });
    position += chunk.bytes.length;
    let text = decodeFileText(decoder, chunk.bytes, chunk.truncated, path);
    if (skippingLongLine) {
      const end = text.indexOf('\n');
      if (end < 0) {
        if (!chunk.truncated) return { text: output.join(''), truncated: false, nextOffset: line };
        continue;
      }
      text = text.slice(end + 1);
      skippingLongLine = false;
      line++;
    }
    pending += text;
    let end = pending.indexOf('\n');
    while (end >= 0) {
      if (count >= limit) return { text: output.join(''), truncated: true, nextOffset: line };
      const value = pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
      const status = accept(value);
      if (status !== 'accepted') return stop(status);
      end = pending.indexOf('\n');
    }
    if (Buffer.byteLength(pending) > maxBytes) {
      if (line < offset) {
        pending = '';
        skippingLongLine = true;
      } else {
        // `offset` past a long line resumes through the branch above, so
        // skipping it here still leaves the rest of the file reachable.
        const status = accept(pending);
        return stop(status === 'accepted' ? 'budget' : status);
      }
    }
    if (!chunk.truncated) {
      if (pending) {
        if (count >= limit) return { text: output.join(''), truncated: true, nextOffset: line };
        const status = accept(pending);
        if (status !== 'accepted') return stop(status);
      }
      return { text: output.join(''), truncated: false, nextOffset: line };
    }
    if (count >= limit) return { text: output.join(''), truncated: true, nextOffset: line };
  }
  throw new RuntimeHostError('io_limit', 'read line scan exceeded 64 MiB; narrow the input');
}
