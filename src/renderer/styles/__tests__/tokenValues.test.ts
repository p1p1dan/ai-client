/**
 * F456 D2-b (token layer) minor-tier value lock -- spec §2.1 / §8.2 [D2-1].
 *
 * There is no color-math test here on purpose. The sRGB / WCAG contrast
 * argument for these exact values (light 7.20:1, dark 6.70:1, tool-arg
 * derivative 5.09/5.02) lives in
 * docs/plans/2026-08-18-f456-readability-composer-spec.md §2 and is not
 * re-implemented here -- that would smuggle a color-science implementation
 * into a test and require its own proof. This file only locks that
 * `globals.css` still contains the literal values that argument was made
 * against, plus the structural properties (still a derivation, declared
 * once) that the argument depends on. Before this file, zero tests in this
 * repo touched color values at all (spec §2.4-c).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, '..', 'globals.css'), 'utf8');

/**
 * Returns the body text of the first top-level `${selector} {...}` rule,
 * found via brace-depth counting rather than a fixed-width regex slice, so
 * the extraction survives reformatting of the rule's own contents. Used to
 * scope assertions to the light (`:root`) vs dark (`.dark`) theme block
 * instead of matching either value anywhere in the file.
 */
function extractBlock(selector: string): string {
  const marker = `${selector} {`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `globals.css: selector "${selector}" not found -- test setup assumption broken`
    );
  }
  let depth = 0;
  let bodyStart = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      if (depth === 1) bodyStart = i + 1;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(bodyStart, i);
    }
  }
  throw new Error(`globals.css: unterminated block for selector "${selector}"`);
}

const rootBlock = extractBlock(':root');
const darkBlock = extractBlock('.dark');

describe('[D2-1] globals.css minor-tier token value lock (F456 D2-b)', () => {
  it('① light --muted-foreground is the Flexoki base-700 target (5.62:1 -> 7.20:1)', () => {
    expect(rootBlock).toContain('--muted-foreground: oklch(0.4531 0.005 91.5);');
  });

  it('① dark --muted-foreground is the Flexoki base-400 target (4.48:1 -> 6.70:1)', () => {
    expect(darkBlock).toContain('--muted-foreground: oklch(0.6956 0.0103 93.62);');
  });

  it('② --tool-arg mix ratio is 85%, not the old 78% (§2.3 kept-derivation ruling)', () => {
    const percentMatch = source.match(/--tool-arg:[^;]*var\(--muted-foreground\)\s*(\d+)%/);
    expect(percentMatch).not.toBeNull();
    expect(Number(percentMatch?.[1])).toBe(85);
  });

  it('③ --tool-arg stays derived from var(--muted-foreground), not an independent literal', () => {
    const declMatch = source.match(/--tool-arg:\s*([^;]+);/);
    expect(declMatch).not.toBeNull();
    expect(declMatch?.[1]).toContain('var(--muted-foreground)');
  });

  it('④ .dark carries no second --tool-arg declaration (declared once, globals.css:190-194)', () => {
    expect(darkBlock).not.toContain('--tool-arg');
  });
});
