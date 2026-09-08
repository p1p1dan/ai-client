import { once } from 'node:events';
import { open, stat } from 'node:fs/promises';

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
  if (!(await stat(path)).isFile()) throw new Error('read requires a regular file');
  const file = await open(path, 'r');
  try {
    const magic = Buffer.from('%TSD-Header-###%');
    const head = Buffer.alloc(magic.length);
    const first = await file.read(head, 0, head.length, null);
    if (first.bytesRead === head.length && head.equals(magic))
      throw new Error('configured Node still reads TSD ciphertext');
    let skipped = 0;
    let written = 0;
    async function consume(bytes) {
      const start = Math.min(bytes.length, Math.max(0, offset - skipped));
      skipped += start;
      const data = bytes.subarray(start, start + limit - written);
      if (data.length) {
        written += data.length;
        if (!process.stdout.write(data)) await once(process.stdout, 'drain');
      }
    }
    await consume(head.subarray(0, first.bytesRead));
    const buffer = Buffer.alloc(64 * 1024);
    while (written < limit) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      await consume(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
