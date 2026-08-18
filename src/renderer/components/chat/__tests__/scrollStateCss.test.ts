import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * F10 class-of-bug invariant: scroll-position-derived state may never change
 * layout height.
 *
 * The defect this pins against: a `@container scroll-state(stuck: top)` rule
 * applied `-webkit-line-clamp` to the pinned user bubble. Collapsing the
 * band shrank `scrollHeight`, the browser re-clamped `scrollTop` below the
 * sticky threshold, the band un-stuck and re-expanded — a per-frame
 * oscillation. The rule (and its whole carrier file, `scroll-state.css`) was
 * removed in favour of an unconditional clamp; this test scans the styles
 * directory so any FUTURE scroll-state rule is born under the prohibition
 * instead of rediscovering it in a GUI session.
 *
 * Paint-only properties are allowed — they cannot feed back into the scroll
 * geometry that triggered them. Everything that can change a used height is
 * forbidden, by prefix, so new spellings fail closed.
 */

const STYLES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'styles'
);

const PAINT_ONLY_PREFIXES = [
  'color',
  'background',
  'border-color',
  'outline-color',
  'box-shadow',
  'opacity',
  'mask',
  'text-decoration',
  'filter',
  'transition',
];

function scrollStateBlocks(css: string): string[] {
  const blocks: string[] = [];
  const opener = /@container\s+scroll-state\([^)]*\)\s*\{/g;
  let match = opener.exec(css);
  while (match) {
    let depth = 1;
    let i = opener.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push(css.slice(opener.lastIndex, i));
    match = opener.exec(css);
  }
  return blocks;
}

function declaredProperties(block: string): string[] {
  // Strip comments, then take `property:` heads inside the innermost braces.
  const noComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  const props: string[] = [];
  for (const decl of noComments.matchAll(/(?:^|[{;])\s*(-?[a-zA-Z-]+)\s*:/g)) {
    props.push(decl[1].toLowerCase().replace(/^-webkit-|^-moz-/, ''));
  }
  return props;
}

describe('scroll-state container queries are paint-only (F10)', () => {
  const cssFiles = readdirSync(STYLES_DIR).filter((name) => name.endsWith('.css'));

  it('scans a real styles directory', () => {
    expect(cssFiles.length).toBeGreaterThan(0);
  });

  for (const name of cssFiles) {
    it(`${name}: any scroll-state block declares only paint-only properties`, () => {
      const css = readFileSync(path.join(STYLES_DIR, name), 'utf8');
      for (const block of scrollStateBlocks(css)) {
        for (const prop of declaredProperties(block)) {
          const allowed = PAINT_ONLY_PREFIXES.some(
            (prefix) => prop === prefix || prop.startsWith(`${prefix}-`)
          );
          expect(
            allowed,
            `\`${prop}\` inside a scroll-state block in ${name} can change layout height — ` +
              'scroll-derived state must never feed back into scroll geometry (F10)'
          ).toBe(true);
        }
      }
    });
  }
});
