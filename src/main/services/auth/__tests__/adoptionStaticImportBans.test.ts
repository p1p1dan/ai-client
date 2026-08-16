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

  it('never imports node:fs or fs write APIs', () => {
    expect(source).not.toMatch(/from\s+['"](node:)?fs['"]/);
    expect(source).not.toMatch(/require\(\s*['"](node:)?fs['"]\s*\)/);
    for (const token of ['writeFileSync', 'appendFileSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'mkdirSync']) {
      expect(source).not.toContain(token);
    }
  });
});
