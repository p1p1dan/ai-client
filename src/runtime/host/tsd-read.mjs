import { once } from 'node:events';
import { open, stat } from 'node:fs/promises';

/**
 * Mirrors `io.ts`: the frame that tells this read apart from anything else that
 * reaches our stdout (tsd-04), and the block size a real container is a whole
 * multiple of (tsd-07). Duplicated rather than imported because this file is
 * spawned by path, never loaded as a module.
 */
const FRAME_MAGIC = Buffer.from('%TSDOUT%');
const CONTAINER_BLOCK_BYTES = 4096;

const [path, offsetText, limitText] = process.argv.slice(2);
const offset = Number(offsetText);
const limit = Number(limitText);
try {
  if (
    !path ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit <= 0
  ) {
    throw new Error('invalid read window');
  }
  const info = await stat(path);
  if (!info.isFile()) throw new Error('read requires a regular file');
  const file = await open(path, 'r');
  try {
    const magic = Buffer.from('%TSD-Header-###%');
    const head = Buffer.alloc(magic.length);
    const first = await file.read(head, 0, head.length, null);
    if (
      first.bytesRead === head.length &&
      head.equals(magic) &&
      info.size >= CONTAINER_BLOCK_BYTES &&
      info.size % CONTAINER_BLOCK_BYTES === 0
    )
      throw new Error('configured Node still reads TSD ciphertext');
    let skipped = 0;
    let written = 0;
    // Collected instead of streamed: the frame states the payload length up
    // front, and the caller's window already bounds what may be collected.
    const chunks = [];
    function consume(bytes) {
      const start = Math.min(bytes.length, Math.max(0, offset - skipped));
      skipped += start;
      const data = bytes.subarray(start, start + limit - written);
      if (data.length) {
        written += data.length;
        chunks.push(Buffer.from(data));
      }
    }
    consume(head.subarray(0, first.bytesRead));
    const buffer = Buffer.alloc(64 * 1024);
    while (written < limit) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      consume(buffer.subarray(0, bytesRead));
    }
    const header = Buffer.alloc(FRAME_MAGIC.length + 4);
    FRAME_MAGIC.copy(header, 0);
    header.writeUInt32BE(written, FRAME_MAGIC.length);
    for (const part of [header, ...chunks])
      if (!process.stdout.write(part)) await once(process.stdout, 'drain');
  } finally {
    await file.close();
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
