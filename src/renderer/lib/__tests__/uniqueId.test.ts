import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { uniqueId } from '../uniqueId';

/**
 * The defect this replaced: `session-${Date.now()}` gave two chats created in
 * the same millisecond the SAME id, which is reachable by double-clicking New.
 * Colliding session ids do not fail loudly — they share a row in every
 * `Record<sessionId, …>` the app keeps, so one chat starts answering for the
 * other.
 */
describe('uniqueId', () => {
  it('does not collide within a single millisecond', () => {
    // The clock frozen: without the random suffix every one of these is the
    // same string, which is exactly the bug.
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const ids = new Set(Array.from({ length: 5000 }, () => uniqueId('session')));
      expect(ids.size).toBe(5000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps the prefix and the timestamp readable', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      expect(uniqueId('session')).toMatch(/^session-1700000000000-[0-9a-z]{7}$/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  /**
   * `Math.random()` can return a value whose base-36 form is short (0.5 →
   * "0.i"), and an unpadded slice would then yield a suffix of one or two
   * characters — still unique-ish, but a variable-length id is a format nobody
   * can write a pattern for.
   */
  it('pads a short random draw to a fixed width', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      expect(uniqueId('x')).toBe('x-1700000000000-i000000');
    } finally {
      vi.restoreAllMocks();
    }
  });

  /**
   * The point of extracting this at all. Two call sites had already reached for
   * the same fix independently and spelled it two different ways; a third
   * spelling is how a rule stops being a rule.
   */
  it('is the only id generator of this shape in the renderer', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        if (full.endsWith('/lib/uniqueId.ts')) continue;
        const source = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        // A template id built out of the clock — with or without a random tail.
        if (/`[a-z-]+-\$\{Date\.now\(\)\}/.test(source)) offenders.push(full.slice(root.length));
      }
    };
    walk(root);
    // `mockRuntime.ts` is the dev-only fake transcript generator: its ids are
    // never persisted and never keyed on, and it mints several per call by
    // design. Everything else goes through `uniqueId`.
    expect(offenders.filter((file) => !file.includes('mockRuntime'))).toEqual([]);
  });
});
