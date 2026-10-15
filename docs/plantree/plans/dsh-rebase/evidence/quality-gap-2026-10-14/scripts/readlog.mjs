// Decode a DSH v4 session log (concatenated zstd frames) into event objects.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
export function readLog(file) {
  const buf = readFileSync(file);
  const starts = [];
  for (let i = 0; i < buf.length - 3; i++)
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd)
      starts.push(i);
  starts.push(buf.length);
  const parts = [];
  let i = 0;
  while (i < starts.length - 1) {
    let ok = false;
    for (let j = i + 1; j < starts.length; j++) {
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(starts[i], starts[j])));
        i = j;
        ok = true;
        break;
      } catch {
        /* magic inside data: extend */
      }
    }
    if (!ok) break;
  }
  const text = Buffer.concat(parts).toString('utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
if (import.meta.main && process.argv[2]) {
  const ev = readLog(process.argv[2]);
  const types = {};
  for (const e of ev) types[e.type] = (types[e.type] ?? 0) + 1;
  console.log(ev.length, JSON.stringify(types));
}
