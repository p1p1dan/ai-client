// Build build/icon.ico and build/icon.icns from PNGs in build/icons/
// Pure Node, no dependencies. PNG bytes embedded directly in ICO/ICNS containers.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const iconsDir = path.join(root, 'build', 'icons');
const buildDir = path.join(root, 'build');

function readPng(size) {
  const p = path.join(iconsDir, `${size}x${size}.png`);
  if (!fs.existsSync(p)) throw new Error(`Missing: ${p}`);
  return fs.readFileSync(p);
}

// ---------- ICO (Windows) ----------
function buildIco(sizes) {
  const pngs = sizes.map((s) => ({ size: s, data: readPng(s) }));
  const headerSize = 6;
  const entrySize = 16;
  const dirSize = headerSize + entrySize * pngs.length;

  let totalImageBytes = 0;
  for (const p of pngs) totalImageBytes += p.data.length;

  const buffer = Buffer.alloc(dirSize + totalImageBytes);
  // ICONDIR
  buffer.writeUInt16LE(0, 0); // reserved
  buffer.writeUInt16LE(1, 2); // type: 1 = icon
  buffer.writeUInt16LE(pngs.length, 4);

  let entryOffset = headerSize;
  let dataOffset = dirSize;

  for (const p of pngs) {
    const w = p.size >= 256 ? 0 : p.size;
    const h = p.size >= 256 ? 0 : p.size;
    buffer.writeUInt8(w, entryOffset + 0);
    buffer.writeUInt8(h, entryOffset + 1);
    buffer.writeUInt8(0, entryOffset + 2); // color count
    buffer.writeUInt8(0, entryOffset + 3); // reserved
    buffer.writeUInt16LE(1, entryOffset + 4); // planes
    buffer.writeUInt16LE(32, entryOffset + 6); // bit count
    buffer.writeUInt32LE(p.data.length, entryOffset + 8);
    buffer.writeUInt32LE(dataOffset, entryOffset + 12);
    p.data.copy(buffer, dataOffset);
    entryOffset += entrySize;
    dataOffset += p.data.length;
  }

  fs.writeFileSync(path.join(buildDir, 'icon.ico'), buffer);
  console.log(`  -> ${path.join(buildDir, 'icon.ico')} (${pngs.length} sizes)`);
}

// ---------- ICNS (macOS) ----------
// Apple Icon Image format: magic "icns" + total size (BE u32)
// Each entry: 4-byte OSType + 4-byte size (BE, includes 8-byte header) + data
// Use PNG-embedded types. See https://en.wikipedia.org/wiki/Apple_Icon_Image_format
const ICNS_TYPES = {
  16: 'icp4',
  32: 'icp5',
  64: 'icp6',
  128: 'ic07',
  256: 'ic08',
  512: 'ic09',
  1024: 'ic10',
};

function buildIcns(sizes) {
  const entries = sizes.map((s) => {
    const type = ICNS_TYPES[s];
    if (!type) throw new Error(`No ICNS type for size ${s}`);
    const data = readPng(s);
    return { type, data };
  });

  let total = 8; // icns magic + size
  for (const e of entries) total += 8 + e.data.length;

  const buffer = Buffer.alloc(total);
  buffer.write('icns', 0, 'ascii');
  buffer.writeUInt32BE(total, 4);

  let offset = 8;
  for (const e of entries) {
    buffer.write(e.type, offset, 'ascii');
    buffer.writeUInt32BE(8 + e.data.length, offset + 4);
    e.data.copy(buffer, offset + 8);
    offset += 8 + e.data.length;
  }

  // include 1024 if available as ic10 (retina icon source)
  fs.writeFileSync(path.join(buildDir, 'icon.icns'), buffer);
  console.log(`  -> ${path.join(buildDir, 'icon.icns')} (${entries.length} sizes)`);
}

// --- main ---
const icoSizes = [16, 32, 48, 64, 128, 256];
const icnsSizes = [16, 32, 64, 128, 256, 512, 1024];

// ensure 1024 exists for icns (copy of source)
const src1024 = path.join(iconsDir, '1024x1024.png');
if (!fs.existsSync(src1024)) {
  throw new Error('build/icons/1024x1024.png missing');
}

buildIco(icoSizes);
buildIcns(icnsSizes);
console.log('ICO + ICNS complete.');
