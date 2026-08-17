import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * D47 S6 §5 mutation ⑥b pin — `adoption.ts` promises (module header) that it
 * never imports filesystem write APIs: the vault `save()` port is its ONLY
 * write channel. A bypass write (grabbing `writeFileSync`/`fs` directly)
 * would silently break the "same schema, same path, single writer" contract
 * that §3-m3 depends on. This scan makes that promise executable.
 */
describe('adoption.ts static import bans (S6 §5 ⑥b)', () => {
  const source = readFileSync(join(__dirname, '..', 'adoption.ts'), 'utf-8');

  it('scan target is non-empty (no vacuous green)', () => {
    expect(source.length).toBeGreaterThan(1000);
  });

  it('never imports fs write APIs (read-only existsSync/readFileSync are the documented exception)', () => {
    // D48-era errata: the original blanket ban on any `fs` import contradicted
    // the module header's own contract ("only the read-only existsSync/
    // readFileSync"), which adoption.ts has relied on since 8cfef4d. Named
    // read-only imports are allowed; everything else stays banned.
    const namedImports = [
      ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s+['"](?:node:)?fs['"]/g),
    ];
    for (const match of namedImports) {
      const names = match[1]
        .split(',')
        .map((entry) => entry.trim().split(/\s+as\s+/)[0])
        .filter(Boolean);
      for (const name of names) {
        expect(['existsSync', 'readFileSync']).toContain(name);
      }
    }
    // Default/namespace fs imports and require() stay fully banned.
    expect(source).not.toMatch(/import\s+(?!\{)[^;]*from\s+['"](node:)?fs['"]/);
    expect(source).not.toMatch(/require\(\s*['"](node:)?fs['"]\s*\)/);
    for (const token of [
      'writeFileSync',
      'appendFileSync',
      'rmSync',
      'unlinkSync',
      'renameSync',
      'copyFileSync',
      'mkdirSync',
    ]) {
      expect(source).not.toContain(token);
    }
  });
});
