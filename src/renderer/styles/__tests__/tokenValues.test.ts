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
  // Design system v2 (2026-10-21) replaced Flexoki with the reference's
  // neutral grays; the secondary ink is #525252 / #a3a3a3 (7.6:1 / 7.4:1 on
  // the canvas).
  it('① light --muted-foreground is the v2 secondary ink', () => {
    expect(rootBlock).toContain('--muted-foreground: #525252;');
  });

  it('① dark --muted-foreground is the v2 secondary ink', () => {
    expect(darkBlock).toContain('--muted-foreground: #a3a3a3;');
  });

  /**
   * ⚠️ 78% → 85% (F456 D2-b) → 62% (decision 034, 2026-09-22).
   *
   * The last move was not a readability tune: the process tier is meant to be
   * skimmed PAST, and at 85% it still competed with the prose it interrupts.
   * Lowering the mix is what widened the gap without touching a size or a
   * weight. The lock is kept at the new literal for the reason the file header
   * gives — this asserts the value the argument was made against, and does not
   * re-derive the contrast math.
   */
  it('② --tool-arg mix ratio is 62%, the decision 034 value (§2.3 kept-derivation ruling)', () => {
    const percentMatch = source.match(/--tool-arg:[^;]*var\(--muted-foreground\)\s*(\d+)%/);
    expect(percentMatch).not.toBeNull();
    expect(Number(percentMatch?.[1])).toBe(62);
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

/**
 * Decision 170 (GitHub issue #6): the two tokens the 「聊天」 sidebar's new
 * hierarchy needs. `--foreground-soft` is the chat title's ink (user ruling:
 * the oklab midpoint of the body colour and the muted one, written as a
 * derivation so it follows light, dark and sync-terminal); `--text-section` is
 * the 16px tier of region / panel / session-bar titles. Each must also be
 * reachable as a utility — Tailwind v4 only emits `text-foreground-soft` when
 * `@theme` bridges it, and `text-section` comes from the `--text-*` namespace.
 */
describe('decision 170: --foreground-soft and --text-section', () => {
  const themeBlock = extractBlock('@theme');

  it('--foreground-soft is the oklab midpoint of --foreground and --muted-foreground', () => {
    expect(rootBlock).toContain(
      '--foreground-soft: color-mix(in oklab, var(--foreground) 50%, var(--muted-foreground));'
    );
  });

  it('--foreground-soft is declared once, in :root only, and carries no alpha of its own', () => {
    expect(source.split('--foreground-soft:').length - 1).toBe(1);
    expect(darkBlock).not.toContain('--foreground-soft');
    const declaration = /--foreground-soft:\s*([^;]+);/.exec(source)?.[1] ?? '';
    expect(declaration).not.toContain('transparent');
    expect(declaration).not.toMatch(/\/\s*[\d.]+\s*\)/);
  });

  it('@theme bridges it, so Tailwind emits text-foreground-soft', () => {
    expect(themeBlock).toContain('--color-foreground-soft: var(--foreground-soft);');
  });

  // Design system v2: --text-section is a migration alias of the 15px heading tier.
  it('--text-section is the 15px / 20px heading tier', () => {
    expect(themeBlock).toContain('--text-section: 0.9375rem;');
    expect(themeBlock).toContain('--text-section--line-height: 1.25rem;');
    expect(themeBlock.split('--text-section:').length - 1).toBe(1);
  });
});

/**
 * Decision 183: the sidebar's "not started" ring, one step quieter than the
 * `--muted-foreground` ring of a chat attached in the background. A
 * derivation, like `--foreground-soft`: `--muted-foreground` mixed 45% toward
 * the sidebar's actual surface (`--surface-0` since design system v2, which is
 * what LeftDock paints), so it follows light, dark and sync-terminal.
 */
describe('decision 183: --muted-foreground-faint', () => {
  const themeBlock = extractBlock('@theme');
  const declaration = (/--muted-foreground-faint:\s*([^;]+);/.exec(source)?.[1] ?? '').replace(
    /\s+/g,
    ' '
  );

  it('is --muted-foreground mixed 45% toward the sidebar surface, in oklab', () => {
    expect(declaration).toBe('color-mix(in oklab, var(--muted-foreground) 45%, var(--surface-0))');
  });

  it('is declared once, in :root only, and carries no alpha of its own', () => {
    expect(source.split('--muted-foreground-faint:').length - 1).toBe(1);
    expect(rootBlock).toContain('--muted-foreground-faint:');
    expect(darkBlock).not.toContain('--muted-foreground-faint');
    expect(declaration).not.toContain('transparent');
    expect(declaration).not.toMatch(/\/\s*[\d.]+\s*\)/);
  });

  it('@theme bridges it, so Tailwind emits border-muted-foreground-faint', () => {
    expect(themeBlock).toContain('--color-muted-foreground-faint: var(--muted-foreground-faint);');
  });
});

/**
 * Decision 174 (issue #6, second wave): the home title's tier, a `--text-*`
 * theme key so `text-display` exists as a utility, declared once. Design
 * system v2 (§3.1, §3.4): the reference's 38px serif greeting, line height 1.2.
 */
describe('decision 174: --text-display', () => {
  const themeBlock = extractBlock('@theme');

  it('is 38px with a 1.2 line height, declared once in @theme', () => {
    expect(themeBlock).toContain('--text-display: 2.375rem;');
    expect(themeBlock).toContain('--text-display--line-height: 1.2;');
    expect(source.split('--text-display:').length - 1).toBe(1);
  });
});

/**
 * FB9's font token, and the red line it has to stay on the right side of.
 *
 * `globals.css` states it directly: "this repo has no @font-face and no font
 * assets; naming a non-system family here is a blank cheque". `--font-math` is
 * the third font token, and it is allowed for the same reason the other two
 * are — every name in it is a face the OS already ships. KaTeX's own faces are
 * the thing the rule forbids, and `rehype-katex` is configured with
 * `output: 'mathml'` precisely so they are never needed.
 */
describe('--font-math (FB9): a system fallback chain, never a bundled face', () => {
  const declaration = /--font-math:\s*([^;]+);/.exec(source)?.[1] ?? '';

  it('exists and terminates on the `math` generic', () => {
    expect(declaration, '--font-math not found in globals.css').not.toBe('');
    expect(declaration.trim().split(',').at(-1)?.trim()).toBe('math');
  });

  /**
   * The list is why MathML renders at all on Linux: Chromium draws fraction
   * bars and stretchy brackets from a font's OpenType `MATH` table, and the
   * `math` generic resolves through fontconfig, which usually has no alias for
   * it. Measured on this machine — with the generic alone a fraction bar was
   * near-invisible and the numerator overlapped the denominator.
   */
  it('names one face per platform, so the generic is a fallback and not the plan', () => {
    for (const face of ['STIX Two Math', 'Cambria Math', 'Noto Sans Math']) {
      expect(declaration, `${face} covers one of the three platforms`).toContain(face);
    }
  });

  it('brings no webfont with it — the whole stylesheet still declares no face', () => {
    // Comments stripped: the red line's own wording names `@font-face`, and a
    // rule that fails because it explains itself is a rule nobody keeps.
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css, 'a bundled face is the red line, math or not').not.toContain('@font-face');
    expect(css).not.toMatch(/url\(["']?[^)]*\.(?:woff2?|ttf|otf|eot)/);
  });

  it('is applied to MathML and to nothing else', () => {
    expect(source).toMatch(/\bmath\s*\{\s*font-family:\s*var\(--font-math\);\s*\}/);
    // One consumer: a second one would mean some non-MathML element quietly
    // reading a face chosen for symbols.
    expect(source.split('var(--font-math)').length - 1).toBe(1);
  });
});
