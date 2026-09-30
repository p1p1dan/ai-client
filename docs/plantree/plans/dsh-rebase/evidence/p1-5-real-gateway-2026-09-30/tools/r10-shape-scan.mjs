#!/usr/bin/env node
/**
 * r10-shape-scan.mjs — R10 stand-in: a shape-based credential leak scan.
 *
 * There is no Main-side `key-canary-scan` in this build (the design's R10
 * reads the real key inside Main and compares; nothing here ever reads a
 * real key). This scan looks for strings SHAPED like credentials and prints
 * only, per file, how many matches each shape had. It never prints a match,
 * a prefix of one or its length. It is an approximation: it can miss a key
 * with an unusual shape and can count a harmless string that looks like one.
 *
 *   node r10-shape-scan.mjs <tag> <root> [...roots]
 *
 * `.zstd` files (DSH session logs) are scanned after decompression as well.
 * A value captured by the "secret-named field" shape is classified without
 * being shown: `reference` (a key reference name such as AICLIENT_KEY_…),
 * `placeholder` (starts with "placeholder", or contains "fake"/"dummy"), or
 * `value` (anything else).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 64 * 1024 * 1024;

const SHAPES = {
  'sk-key': /\bsk-[A-Za-z0-9_-]{16,}/g,
  bearer: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  jwt: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
};
const SECRET_FIELD =
  /(?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|authorization|x-api-key)["']?\s*[:=]\s*["']?(?:Bearer\s+)?([A-Za-z0-9._~+/=-]{20,})/gi;

function classify(value) {
  if (/^AICLIENT_KEY_/.test(value)) return 'reference';
  if (/^placeholder/i.test(value) || /fake|dummy/i.test(value)) return 'placeholder';
  return 'value';
}

function scanText(text) {
  const counts = {};
  for (const [name, re] of Object.entries(SHAPES)) {
    const n = (text.match(re) ?? []).length;
    if (n) counts[name] = n;
  }
  for (const m of text.matchAll(SECRET_FIELD)) {
    const key = `secret-field:${classify(m[1])}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function* walk(root) {
  let st;
  try {
    st = fs.lstatSync(root);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isFile()) {
    yield root;
    return;
  }
  if (!st.isDirectory()) return;
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) yield* walk(path.join(root, name));
}

const [tag, ...roots] = process.argv.slice(2);
if (!tag || roots.length === 0) {
  console.error('usage: r10-shape-scan.mjs <tag> <root> [...roots]');
  process.exit(2);
}

const hits = [];
let files = 0;
let bytes = 0;
let skipped = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    let buf;
    try {
      const size = fs.statSync(file).size;
      if (size > MAX_BYTES) {
        skipped += 1;
        continue;
      }
      buf = fs.readFileSync(file);
    } catch {
      skipped += 1;
      continue;
    }
    files += 1;
    bytes += buf.length;
    const counts = scanText(buf.toString('latin1'));
    if (Object.keys(counts).length) hits.push({ file, counts });
    if (file.endsWith('.zstd')) {
      try {
        const plain = execFileSync('zstd', ['-dcq', file], { maxBuffer: MAX_BYTES });
        const c2 = scanText(plain.toString('utf8'));
        if (Object.keys(c2).length) hits.push({ file: `${file} (decompressed)`, counts: c2 });
      } catch {
        skipped += 1;
      }
    }
  }
}

const out = {
  tag,
  at: new Date().toISOString(),
  method: 'shape scan (approximate); matches are counted, never printed',
  roots,
  files,
  bytes,
  skipped,
  hitFiles: hits.length,
  hits,
};
const resultsDir = path.resolve(here, '../results');
fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, `${tag}.json`), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
