import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../components/chat/__tests__/stripComments';

/**
 * Plan ui-cohesion stage 6: the anti-regression gate for design system v2
 * (docs/design-system.md §2–§4, §7.7). Every renderer file outside
 * `components/ui/` (the primitives own the tiers) is scanned, comments blanked,
 * class strings split into utilities with variant prefixes dropped:
 *
 * - no Tailwind palette colour and no arbitrary colour value: colours come from
 *   the semantic tokens only;
 * - no bare `text-xs`…`text-3xl` and no arbitrary `text-[Npx]`: sizes come from
 *   the §3.1 tiers;
 * - no arbitrary radius, except the inner-edge `calc(var(--radius-*)-1px)` that
 *   follows a tier;
 * - no migration-era name (retired type tiers, Flexoki colours, the old
 *   composer shadow);
 * - no hand-drawn error / warning box (a tone border plus a tone fill on one
 *   element): notices are `Alert`.
 */

const RENDERER_ROOT = join(process.cwd(), 'src/renderer');

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string) => file.slice(RENDERER_ROOT.length + 1).replace(/\\/g, '/');

const FILES = collectFiles(RENDERER_ROOT)
  .filter((file) => !rel(file).startsWith('components/ui/'))
  .map((file) => ({ rel: rel(file), code: stripComments(readFileSync(file, 'utf8'), file) }));

const STRING_LITERAL_RE = /(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;

/** Every string literal in `code`, as written. */
function literals(code: string): string[] {
  return [...code.matchAll(STRING_LITERAL_RE)].map((match) => match[2] ?? '');
}

/** A utility without its variant prefixes (`dark:hover:bg-x` → `bg-x`). */
function base(token: string): string {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    else if (ch === ':' && depth === 0) cut = i + 1;
  }
  return token.slice(cut).replace(/^!/, '');
}

/** `file: utility` for every utility in a class-ish string that `bad` flags. */
function offenders(bad: (utility: string) => boolean, allow: readonly string[] = []): string[] {
  const hits: string[] = [];
  for (const { rel: file, code } of FILES) {
    if (allow.includes(file)) continue;
    for (const literal of literals(code)) {
      for (const token of literal.split(/\s+/)) {
        if (token && bad(base(token))) hits.push(`${file}: ${token}`);
      }
    }
  }
  return hits;
}

const COLOUR_UTILITY =
  '(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|fill|stroke|outline|decoration|from|via|to|divide|caret|shadow|accent|placeholder)';
const PALETTE =
  '(?:(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\\d{2,3}|black|white)';
const PALETTE_RE = new RegExp(`^${COLOUR_UTILITY}-${PALETTE}(?:/\\d+)?$`);
const ARBITRARY_COLOUR_RE = new RegExp(`^${COLOUR_UTILITY}-\\[(?:#|rgb|hsl|oklch|oklab|color:)`);

describe('design system v2 guard: colours', () => {
  it('no Tailwind palette colour outside the file-type icon map', () => {
    // The file-type icons keep their language colours (§ components: "TS blue, JS yellow").
    const allow = ['components/files/fileIcons.tsx', 'components/search/SearchResultList.tsx'];
    expect(offenders((u) => PALETTE_RE.test(u), allow)).toEqual([]);
  });

  it('no arbitrary colour value', () => {
    expect(offenders((u) => ARBITRARY_COLOUR_RE.test(u))).toEqual([]);
  });
});

describe('design system v2 guard: sizes and radii', () => {
  it('no bare t-shirt font size and no arbitrary font size', () => {
    expect(
      offenders((u) => /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/.test(u) || /^text-\[\d/.test(u))
    ).toEqual([]);
  });

  it('no arbitrary radius except a tier’s inner edge', () => {
    expect(
      offenders(
        (u) =>
          /^rounded(?:-[a-z]+)?-\[/.test(u) &&
          !/^rounded(?:-[a-z]+)?-\[calc\(var\(--radius-[a-z]+\)-1px\)\]$/.test(u)
      )
    ).toEqual([]);
  });
});

describe('design system v2 guard: migration-era names', () => {
  const RETIRED = new Set([
    'text-meta',
    'text-section',
    'text-markdown',
    'text-group-label',
    'text-tool-arg',
    'elev-composer',
    'rounded-composer',
  ]);
  const RETIRED_COLOUR_RE = new RegExp(
    `^${COLOUR_UTILITY}-(?:accent-primary|selection|hover|status-running|tool-arg)(?:/\\d+)?$`
  );

  it('no retired type tier, Flexoki colour or composer shadow', () => {
    expect(offenders((u) => RETIRED.has(u) || RETIRED_COLOUR_RE.test(u))).toEqual([]);
  });
});

describe('design system v2 guard: notices', () => {
  it('no hand-drawn error or warning box: a tone border and a tone fill together is an Alert', () => {
    const hits: string[] = [];
    for (const { rel: file, code } of FILES) {
      for (const literal of literals(code)) {
        const utilities = literal.split(/\s+/).map(base);
        const toneBorder = utilities.some((u) =>
          /^border-(?:destructive|warning)(?:\/\d+)?$/.test(u)
        );
        const toneFill = utilities.some((u) => /^bg-(?:destructive|warning)\/\d+$/.test(u));
        if (toneBorder && toneFill) hits.push(`${file}: ${literal.trim().slice(0, 80)}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
