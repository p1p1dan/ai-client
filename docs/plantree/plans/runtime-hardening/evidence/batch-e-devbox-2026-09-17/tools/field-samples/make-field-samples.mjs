#!/usr/bin/env node

// T033 field-day sample generator (ENC-12 encoding + real binary samples).
//
// Produces, under <script dir>/enc12 by default:
//   enc12-gbk.txt            GBK (CP936) encoded Chinese text, LF line endings
//   enc12-gbk.v2.txt         same file with one line changed  -> copy over v1 to make a diff
//   enc12-utf16le-bom.txt    UTF-16 LE with BOM (FF FE), CRLF line endings
//   enc12-utf16le-bom.v2.txt
//   enc12-utf8-bom.txt       UTF-8 with BOM (EF BB BF), LF line endings
//   enc12-utf8-bom.v2.txt
//   enc12-tiny.png           a real, structurally valid 1x1 PNG
//   enc12-random-1kib.bin    exactly 1024 deterministic pseudo-random bytes
//   manifest.json            byte length, first 16 bytes (hex) and sha256 of each file
//
// Runs on plain Node 24 on Windows, macOS and Linux. No dependencies, no shell
// syntax, no network. Re-running is idempotent: the output directory is wiped
// and rebuilt, and every byte is deterministic, so a regenerated file has the
// same sha256 as the one recorded in README.md.
//
// Usage:
//   node make-field-samples.mjs
//   node make-field-samples.mjs --out C:\t033\samples
//   node make-field-samples.mjs --verify        # rebuild, then print the manifest only
//
// The output directory is NOT called `out`: the repo's .gitignore excludes `out/`,
// which would silently drop these samples from version control.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { outDir: join(SCRIPT_DIR, 'enc12'), verifyOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out.outDir = resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--verify') {
      out.verifyOnly = true;
    }
  }
  return out;
}

// ------------------------------------------------------------------ GBK ----

/**
 * Build a char -> GBK bytes table by inverting Node's own GBK decoder.
 *
 * Node 24 official builds ship full ICU, so `new TextDecoder('gbk')` exists,
 * but there is no GBK *encoder* anywhere in the standard library. Walking the
 * whole double-byte space once (lead 0x81..0xFE, trail 0x40..0xFE minus 0x7F)
 * and decoding each pair gives an exact inverse of the decoder that the app
 * under test will later use, which is the property we actually want: whatever
 * the app decodes these bytes back to is by construction what we wrote.
 */
function buildGbkEncoder() {
  let decoder;
  try {
    decoder = new TextDecoder('gbk', { fatal: true });
  } catch {
    throw new Error(
      'this Node build has no GBK decoder (small-icu). Use an official Node 24 build, ' +
        'or set NODE_ICU_DATA to a full-icu data file.'
    );
  }
  const table = new Map();
  const pair = Buffer.alloc(2);
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      pair[0] = lead;
      pair[1] = trail;
      let text;
      try {
        text = decoder.decode(pair);
      } catch {
        continue;
      }
      if (text.length !== 1) continue;
      if (!table.has(text)) table.set(text, [lead, trail]);
    }
  }
  return (input) => {
    const bytes = [];
    for (const char of input) {
      const code = char.codePointAt(0);
      if (code < 0x80) {
        bytes.push(code);
        continue;
      }
      const mapped = table.get(char);
      if (!mapped) throw new Error(`character not representable in GBK: ${JSON.stringify(char)}`);
      bytes.push(mapped[0], mapped[1]);
    }
    return Buffer.from(bytes);
  };
}

// ------------------------------------------------------------------ PNG ----

function pngChunk(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length, 0);
  header.write(type, 4, 'ascii');
  const crcInput = Buffer.concat([header.subarray(4), payload]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([header, payload, tail]);
}

/**
 * A real 1x1 8-bit RGB PNG, built here rather than pasted as base64 so the
 * CRCs are computed instead of trusted. Deterministic: zlib level is pinned.
 */
function makeTinyPng() {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // One scanline: filter byte 0, then R G B.
  const raw = Buffer.from([0x00, 0xd0, 0x30, 0x30]);
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------- binary ----

/** xorshift32 with a fixed seed: same 1024 bytes on every machine, every run. */
function makeDeterministicBytes(length, seed) {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

// ----------------------------------------------------------------- text ----

// Deliberately mixes CJK, an ASCII identifier and a full-width punctuation mark:
// a diff viewer that mis-decodes any one of the three shows it immediately.
const LINES_V1 = [
  '第一行：加密盘编码样本，用于 ENC-12。',
  'second line stays ASCII so a broken decode is obvious by contrast',
  '第三行：全角标点——括号（圆括号）、引号「直角引号」、省略号……',
  '第四行：待改动的哨兵串 SENTINEL-V1',
];
const LINES_V2 = [
  '第一行：加密盘编码样本，用于 ENC-12。',
  'second line stays ASCII so a broken decode is obvious by contrast',
  '第三行：全角标点——括号（圆括号）、引号「直角引号」、省略号……',
  '第四行：待改动的哨兵串 SENTINEL-V2（这一行是唯一的改动）',
];

function joinLines(lines, eol) {
  return `${lines.join(eol)}${eol}`;
}

// ------------------------------------------------------------------ main ----

async function main() {
  const { outDir, verifyOnly } = parseArgs(process.argv.slice(2));
  const encodeGbk = buildGbkEncoder();

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const files = [];
  const emit = async (name, bytes, note) => {
    await writeFile(join(outDir, name), bytes);
    files.push({ name, note });
  };

  // GBK, LF. GBK has no byte-order mark at all: the first bytes are content.
  await emit('enc12-gbk.txt', encodeGbk(joinLines(LINES_V1, '\n')), 'GBK / CP936, LF, no BOM');
  await emit('enc12-gbk.v2.txt', encodeGbk(joinLines(LINES_V2, '\n')), 'GBK v2 (one line changed)');

  // UTF-16 LE with BOM, CRLF. CRLF here is on purpose: Windows editors write it,
  // and in UTF-16 it is four bytes (0D 00 0A 00), which is where naive readers break.
  const utf16 = (lines) => Buffer.from(`\uFEFF${joinLines(lines, '\r\n')}`, 'utf16le');
  await emit('enc12-utf16le-bom.txt', utf16(LINES_V1), 'UTF-16 LE + BOM, CRLF');
  await emit('enc12-utf16le-bom.v2.txt', utf16(LINES_V2), 'UTF-16 LE + BOM v2');

  // UTF-8 with BOM, LF.
  const utf8Bom = (lines) =>
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(joinLines(lines, '\n'), 'utf8')]);
  await emit('enc12-utf8-bom.txt', utf8Bom(LINES_V1), 'UTF-8 + BOM, LF');
  await emit('enc12-utf8-bom.v2.txt', utf8Bom(LINES_V2), 'UTF-8 + BOM v2');

  // Real binaries.
  await emit('enc12-tiny.png', makeTinyPng(), 'valid 1x1 truecolour PNG');
  await emit(
    'enc12-random-1kib.bin',
    makeDeterministicBytes(1024, 0x5eed1234),
    'exactly 1024 deterministic bytes, contains NUL'
  );

  const manifest = [];
  for (const file of files) {
    const bytes = await readFile(join(outDir, file.name));
    manifest.push({
      name: file.name,
      note: file.note,
      bytes: bytes.length,
      head16: bytes.subarray(0, 16).toString('hex').replace(/(..)/g, '$1 ').trim(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (!verifyOnly) console.log(`wrote ${manifest.length} sample files to ${outDir}`);
  for (const entry of manifest) {
    console.log(
      `${entry.name.padEnd(26)} ${String(entry.bytes).padStart(6)} B  ${entry.head16.slice(0, 23)}  ${entry.sha256.slice(0, 16)}`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
