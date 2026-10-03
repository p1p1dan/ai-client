/**
 * Read-only inspection of a packaged `app.asar`, for verify-packaged-app's
 * reverse checks (dsh-rebase P1-12 step 3, decision 147).
 *
 * Parses the archive header itself instead of depending on `@electron/asar`,
 * which this repo only has as a transitive dependency of electron-builder. The
 * format is two Chromium pickles followed by the file data:
 *
 *   [u32 4][u32 headerSize]                  8-byte size pickle
 *   [u32 payload][i32 jsonLength][json…pad]  header pickle, headerSize bytes
 *   file data                                offsets in the JSON are relative
 *                                            to 8 + headerSize
 *
 * The JSON is a tree of `{ files: { name: entry } }`; a file entry carries
 * `size` and `offset` (a decimal string), or `unpacked: true` when its bytes
 * live beside the archive in `app.asar.unpacked/`.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The archive's header tree and where its file data starts. */
export function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizePickle = Buffer.alloc(8);
    if (fs.readSync(fd, sizePickle, 0, 8, 0) !== 8) throw new Error(`${asarPath}: truncated`);
    const headerSize = sizePickle.readUInt32LE(4);
    const headerPickle = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerPickle, 0, headerSize, 8) !== headerSize) {
      throw new Error(`${asarPath}: truncated header`);
    }
    const jsonLength = headerPickle.readInt32LE(4);
    if (jsonLength < 0 || 8 + jsonLength > headerSize) {
      throw new Error(`${asarPath}: malformed header (json length ${jsonLength})`);
    }
    const header = JSON.parse(headerPickle.subarray(8, 8 + jsonLength).toString('utf8'));
    return { header, dataOffset: 8 + headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

/** The entry at a `/`-separated path inside the archive, or `undefined`. */
export function asarEntry(header, relativePath) {
  let node = header;
  for (const part of relativePath.split('/').filter(Boolean)) {
    node = node?.files?.[part];
    if (!node) return undefined;
  }
  return node;
}

/**
 * Every `node_modules/<name>` directory in the archive whose package name is
 * in `names`, at any depth (a nested copy ships just the same). Names may be
 * scoped (`@scope/pkg`).
 */
export function findAsarPackages(header, names) {
  const wanted = new Set(names);
  const found = [];
  const visit = (node, at) => {
    const files = node?.files;
    if (!files) return;
    for (const [name, child] of Object.entries(files)) {
      const here = at ? `${at}/${name}` : name;
      if (name === 'node_modules' && child?.files) {
        for (const [pkg, pkgNode] of Object.entries(child.files)) {
          const candidates = pkg.startsWith('@')
            ? Object.keys(pkgNode?.files ?? {}).map((inner) => `${pkg}/${inner}`)
            : [pkg];
          for (const candidate of candidates) {
            if (wanted.has(candidate)) found.push(`${here}/${candidate}`);
          }
        }
      }
      visit(child, here);
    }
  };
  visit(header, '');
  return found.sort();
}

/** One file's bytes, from the archive or from `app.asar.unpacked/`. */
export function readAsarFile(asarPath, relativePath) {
  const { header, dataOffset } = readAsarHeader(asarPath);
  const entry = asarEntry(header, relativePath);
  if (!entry || entry.files || typeof entry.size !== 'number') return undefined;
  if (entry.unpacked) {
    return fs.readFileSync(path.join(`${asarPath}.unpacked`, ...relativePath.split('/')));
  }
  const buffer = Buffer.alloc(entry.size);
  const fd = fs.openSync(asarPath, 'r');
  try {
    fs.readSync(fd, buffer, 0, entry.size, dataOffset + Number(entry.offset));
  } finally {
    fs.closeSync(fd);
  }
  return buffer;
}
