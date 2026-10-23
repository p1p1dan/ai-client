import { describe, expect, it } from 'vitest';
import { readZip, safeEntryPath } from '../zipReader';
import { writeZip } from '../zipWriter';

const file = (path: string, text: string) => ({ path, data: Buffer.from(text) });

/** Rewrite the first entry's name in both headers (same length), to forge a bad archive. */
function renameFirst(zip: Buffer, from: string, to: string): Buffer {
  const copy = Buffer.from(zip);
  const fromBytes = Buffer.from(from);
  const toBytes = Buffer.from(to);
  let index = copy.indexOf(fromBytes);
  while (index !== -1) {
    toBytes.copy(copy, index);
    index = copy.indexOf(fromBytes, index + 1);
  }
  return copy;
}

describe('plugin package zip', () => {
  it('[PLG-ZIP] round-trips files through the writer and reader', () => {
    const zip = writeZip([
      file('manifest.json', '{"a":1}'),
      file('dist/main.js', 'x'.repeat(5000)),
    ]);
    expect(readZip(zip).map((entry) => [entry.path, entry.data.toString()])).toEqual([
      ['manifest.json', '{"a":1}'],
      ['dist/main.js', 'x'.repeat(5000)],
    ]);
  });

  it.each([
    ['../evil', undefined],
    ['/abs', undefined],
    ['C:/x', undefined],
    ['a\\b', undefined],
    ['a/../b', undefined],
    ['./a//b', 'a/b'],
    ['dir/file.js', 'dir/file.js'],
  ])('[PLG-ZIP] entry name %s → %s', (name, expected) => {
    expect(safeEntryPath(name)).toBe(expected);
  });

  it('[PLG-ZIP] refuses an entry that climbs out of the package', () => {
    const zip = renameFirst(writeZip([file('aa/evil.js', 'x')]), 'aa/evil.js', '../evil.js');
    expect(() => readZip(zip)).toThrow(/unsafe entry name/);
  });

  it('[PLG-ZIP] refuses archives over the entry or size caps', () => {
    const zip = writeZip([file('a', 'x'.repeat(100)), file('b', 'y')]);
    expect(() => readZip(zip, { maxEntries: 1, maxTotalBytes: 1000 })).toThrow(/entries/);
    expect(() => readZip(zip, { maxEntries: 10, maxTotalBytes: 50 })).toThrow(/more than 50 bytes/);
  });

  it('[PLG-ZIP] refuses something that is not a zip, and a corrupted entry', () => {
    expect(() => readZip(Buffer.from('definitely not a zip archive'))).toThrow(/not a zip/);
    const zip = writeZip([file('a.txt', 'hello hello hello')]);
    const crcAt = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16;
    const broken = Buffer.from(zip);
    broken.writeUInt32LE((broken.readUInt32LE(crcAt) + 1) >>> 0, crcAt);
    expect(() => readZip(broken)).toThrow(/checksum mismatch/);
  });
});
