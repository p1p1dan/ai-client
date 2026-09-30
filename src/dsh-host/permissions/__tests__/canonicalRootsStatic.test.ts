import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * dsh-rebase decision 134 — one resolver family for everything the gate
 * compares. The permission row resolves targets with `fs/promises` realpath
 * (libuv's); a root (the gate's cwd, the spill parent, the attachment store)
 * resolved with the JavaScript `fs.realpathSync` keeps Windows 8.3 short
 * names and never contains those targets. Only `realpathSync.native`, the
 * synchronous twin, may appear in the host's permission and bridge code.
 */

const HOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIRS = ['permissions', 'bridge'];

/** Block comments and whole-line `//` comments, so prose cannot look like a call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const files = DIRS.flatMap((dir) =>
  readdirSync(path.join(HOST, dir))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(HOST, dir, name))
);

describe('the host resolves permission roots with the native realpath only (decision 134)', () => {
  it('scans the permission row and the bridge', () => {
    expect(files.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining(['permissionHost.ts', 'dshSessionRuntime.ts'])
    );
  });

  it('calls no JavaScript realpathSync', () => {
    const offenders = files.flatMap((file) =>
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .map((line, index) => ({ line, index }))
        // A bare `realpathSync(` call; `realpathSync.native(` and `deps.realpathSync` are fine.
        .filter(({ line }) => /(^|[^.\w])realpathSync\s*\(/.test(line))
        .map(({ index }) => `${path.relative(HOST, file)}:${index + 1}`)
    );
    expect(offenders).toEqual([]);
  });

  it('builds the gate from the shared workspace spellings, on the native resolver', () => {
    const runtime = readFileSync(path.join(HOST, 'bridge', 'dshSessionRuntime.ts'), 'utf8');
    expect(runtime).toContain('workspaceSpellings(');
    expect(runtime).toContain('realpathSync.native(path)');
    const row = readFileSync(path.join(HOST, 'permissions', 'permissionHost.ts'), 'utf8');
    expect(row).toContain('realpathSync.native(path)');
    expect(row).toMatch(/realpath: \(path\) => realpath\(path\)/);
  });
});
