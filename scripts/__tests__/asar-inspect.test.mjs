import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asarEntry, findAsarPackages, readAsarFile, readAsarHeader } from '../asar-inspect.mjs';

/**
 * dsh-rebase P1-12 step 3 (decision 147): verify-packaged-app reads app.asar
 * itself to prove the retired runtime's packages and code did not ship. The
 * parser is exercised against archives written here in the same format, so
 * the reverse checks are shown to fire without packaging the app.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A minimal archive in asar's format: size pickle, header pickle, file data. */
function writeAsar(asarPath, entries, unpacked = []) {
  const root = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [relativePath, text] of Object.entries(entries)) {
    const parts = relativePath.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} };
      node = node.files[part];
    }
    const data = Buffer.from(text, 'utf8');
    if (unpacked.includes(relativePath)) {
      node.files[parts.at(-1)] = { size: data.length, unpacked: true };
      const target = path.join(`${asarPath}.unpacked`, ...parts);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, data);
      continue;
    }
    node.files[parts.at(-1)] = { size: data.length, offset: String(offset) };
    chunks.push(data);
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(root), 'utf8');
  const padded = Math.ceil(json.length / 4) * 4;
  const headerPickle = Buffer.alloc(8 + padded);
  headerPickle.writeUInt32LE(4 + padded, 0);
  headerPickle.writeInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  writeFileSync(asarPath, Buffer.concat([sizePickle, headerPickle, ...chunks]));
}

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'asar-inspect-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('asar-inspect', () => {
  it('reads the header tree and a file at its offset', () => {
    const asar = path.join(dir, 'app.asar');
    writeAsar(asar, { 'package.json': '{"name":"x"}', 'out/main/index.js': 'console.log(1)' });
    const { header } = readAsarHeader(asar);
    expect(asarEntry(header, 'out/main/index.js')).toMatchObject({ size: 14 });
    expect(asarEntry(header, 'out/main/missing.js')).toBeUndefined();
    expect(readAsarFile(asar, 'out/main/index.js')?.toString('utf8')).toBe('console.log(1)');
    expect(readAsarFile(asar, 'package.json')?.toString('utf8')).toBe('{"name":"x"}');
    // A directory is not a file.
    expect(readAsarFile(asar, 'out/main')).toBeUndefined();
  });

  it('reads an unpacked file from beside the archive', () => {
    const asar = path.join(dir, 'app.asar');
    writeAsar(asar, { 'a.txt': 'packed', 'native/b.node': 'unpacked bytes' }, ['native/b.node']);
    expect(readAsarFile(asar, 'native/b.node')?.toString('utf8')).toBe('unpacked bytes');
    expect(readAsarFile(asar, 'a.txt')?.toString('utf8')).toBe('packed');
  });

  it('finds a retired package at any depth, scoped or not', () => {
    const asar = path.join(dir, 'app.asar');
    writeAsar(asar, {
      'node_modules/@earendil-works/pi-coding-agent/package.json': '{}',
      'node_modules/@earendil-works/pi-ai/package.json': '{}',
      'node_modules/zod/node_modules/cordis/package.json': '{}',
      'node_modules/@deepseek-ai/cordis/package.json': '{}',
      'node_modules/react/package.json': '{}',
    });
    const { header } = readAsarHeader(asar);
    expect(
      findAsarPackages(header, [
        '@earendil-works/pi-coding-agent',
        '@earendil-works/pi-agent-core',
        'cordis',
      ])
    ).toEqual([
      'node_modules/@earendil-works/pi-coding-agent',
      'node_modules/zod/node_modules/cordis',
    ]);
  });
});

describe('verify-packaged-app reads app.asar (P1-12 step 3)', () => {
  function verify(entries) {
    const appDir = path.join(dir, 'app');
    mkdirSync(path.join(appDir, 'resources'), { recursive: true });
    writeAsar(path.join(appDir, 'resources', 'app.asar'), entries);
    // The fake package has no notices, node or DSH host: those checks fail
    // too, and only the app.asar lines are asserted on.
    const result = spawnSync(
      process.execPath,
      ['scripts/verify-packaged-app.mjs', '--app-dir', appDir, '--skip-dsh-smoke'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 }
    );
    expect(result.status).toBe(1);
    return result.stderr
      .split('\n---\n')
      .filter((line) => /app\.asar|out\/main\/index\.js/.test(line));
  }

  it('fails a package that still carries a retired package or runtime code', () => {
    const lines = verify({
      'node_modules/@earendil-works/pi-coding-agent/package.json': '{}',
      'node_modules/@gotgenes/pi-permission-system/package.json': '{}',
      'out/main/index.js': 'class NativeWorkerRuntime {}',
    });
    expect(lines.join('\n')).toContain(
      'retired package still packaged in app.asar: node_modules/@earendil-works/pi-coding-agent'
    );
    expect(lines.join('\n')).toContain(
      'retired package still packaged in app.asar: node_modules/@gotgenes/pi-permission-system'
    );
    expect(lines.join('\n')).toContain(
      'out/main/index.js still carries runtime code: NativeWorkerRuntime'
    );
  });

  it('passes the app.asar checks for a clean package', () => {
    const lines = verify({
      'node_modules/@deepseek-ai/cordis/package.json': '{}',
      'out/main/index.js': 'console.log("dsh")',
    });
    expect(lines.filter((line) => /retired|runtime code|cannot read/.test(line))).toEqual([]);
  });
});
