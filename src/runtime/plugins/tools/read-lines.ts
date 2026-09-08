import type { RuntimeHostIoService } from '../../contracts.ts';
import { RuntimeHostError } from '../../host/errors.ts';

// HostIo uses byte windows; the model-facing read tool uses one-based lines.
export async function readLines(
  io: RuntimeHostIoService,
  path: string,
  offset: number,
  limit: number,
  maxBytes: number,
  signal?: AbortSignal
) {
  let position = 0;
  let line = 1;
  let pending = '';
  let used = 0;
  let count = 0;
  let skippingLongLine = false;
  const output: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  function accept(value: string): boolean {
    if (line++ < offset) return true;
    const bytes = Buffer.from(value);
    if (used + bytes.length > maxBytes) {
      const clipped = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, maxBytes - used),
        { stream: true }
      );
      output.push(clipped);
      return false;
    }
    output.push(value);
    used += bytes.length;
    count++;
    return true;
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
    let text = decoder.decode(chunk.bytes, { stream: chunk.truncated });
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
      if (!accept(value))
        return { text: output.join(''), truncated: true, nextOffset: line - 1, partialLine: true };
      end = pending.indexOf('\n');
    }
    if (Buffer.byteLength(pending) > maxBytes) {
      if (line < offset) {
        pending = '';
        skippingLongLine = true;
      } else {
        accept(pending);
        return { text: output.join(''), truncated: true, nextOffset: line - 1, partialLine: true };
      }
    }
    if (!chunk.truncated) {
      if (pending) {
        if (count >= limit) return { text: output.join(''), truncated: true, nextOffset: line };
        if (!accept(pending))
          return {
            text: output.join(''),
            truncated: true,
            nextOffset: line - 1,
            partialLine: true,
          };
      }
      return { text: output.join(''), truncated: false, nextOffset: line };
    }
    if (count >= limit) return { text: output.join(''), truncated: true, nextOffset: line };
  }
  throw new RuntimeHostError('io_limit', 'read line scan exceeded 64 MiB; narrow the input');
}
