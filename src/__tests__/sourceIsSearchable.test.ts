import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No source file may contain a raw C0 control byte.
 *
 * ## Why this is worth a test
 *
 * It is not a style rule. A file with a literal NUL in it is classified `data`
 * by `file(1)`, and **grep and ripgrep skip binary files by default, silently**
 * — no warning, no non-zero exit, the file simply is not in the results.
 *
 * That is how `useFolderDiffStats.ts` cost a point-check session on
 * 2026-09-11: searching for the symbols it imports returned nothing, so the
 * hook read as dead code and F/13 was written up as "never wired". It was
 * wired the whole time (`LeftNav.tsx` calls it). Reading the file by hand did
 * not help either — a NUL renders as nothing, so `join('\0')` looks exactly
 * like `join('')` in a terminal.
 *
 * The bytes were all deliberate: NUL is the one character a filesystem path
 * cannot contain, which makes it the right separator for a composite key or a
 * hash domain. Nothing about that changes here — they just have to be spelled
 * `'\0'` instead of typed as the byte, which is identical at runtime and keeps
 * the file searchable.
 *
 * Tab, newline and carriage return are allowed; they are what text is made of.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (EXTENSIONS.has(path.extname(name))) out.push(full);
  }
  return out;
}

/** `\t` (9), `\n` (10), `\r` (13) are text; every other byte below 0x20 is not. */
function isForbidden(byte: number): boolean {
  return byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13;
}

describe('source stays searchable', () => {
  const files = sourceFiles(SRC);

  it('no source file contains a raw control byte', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const bytes = readFileSync(file);
      const hits = new Set<string>();
      for (const byte of bytes) {
        if (isForbidden(byte)) hits.add(`0x${byte.toString(16).padStart(2, '0')}`);
      }
      if (hits.size > 0) {
        offenders.push(`${path.relative(SRC, file)}: ${[...hits].sort().join(', ')}`);
      }
    }
    // The fix is always the same: write the escape (`'\0'`, `'\x01'`) instead
    // of typing the byte. Runtime behaviour is unchanged.
    expect(offenders.sort()).toEqual([]);
  });

  it('the scan actually walked the tree', () => {
    // A walker that silently stopped matching would make the assertion above
    // pass on nothing — the failure mode every source scan has.
    expect(files.length).toBeGreaterThan(500);
  });
});
