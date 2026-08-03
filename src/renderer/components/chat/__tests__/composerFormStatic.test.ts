import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-30b2 F-A20 (absorbs the earlier F-A8): static evidence that the merged
 * model control actually replaced the two `Select`-based ones, rather than
 * being added beside them.
 *
 * This is a filesystem scan rather than a class assertion because what it
 * guards is a DELETION. A future edit can reintroduce `SelectTrigger` into
 * this directory without touching any pure function, and no other assertion in
 * this suite would notice.
 */

const CHAT_DIR = join(process.cwd(), 'src/renderer/components/chat');

/**
 * Scans below read CODE, not prose. Both banned names are quoted at length in
 * the doc comments that record WHY they were removed — a scanner that cannot
 * tell the two apart would force the codebase to choose between keeping the
 * scan and keeping the explanation, and the explanation is the only thing
 * stopping the next person from reintroducing them.
 *
 * The `[^:]` guard on line comments keeps `https://` from swallowing the rest
 * of its line.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('F-A20: composer form static scan', () => {
  it('the two superseded selector components are gone', () => {
    const names = readdirSync(CHAT_DIR);
    expect(names).not.toContain('ModelSelect.tsx');
    expect(names).not.toContain('EffortSelect.tsx');
  });

  // `SelectTrigger` is an INPUT-CONTROL primitive: it brings a border, a
  // shadow, an inner highlight and a width floor, and its radius token clamps
  // to a full pill at this control height. That package is right for a form
  // page and wrong for a toolbar dropdown — the whole "too round / too AI"
  // reading traced back to two of them sitting in the composer bar. Toolbar
  // dropdowns here use the ghost-chip form instead.
  it('no SelectTrigger survives anywhere under components/chat', () => {
    const offenders = collectFiles(CHAT_DIR).filter(
      (file) =>
        !file.includes('__tests__') &&
        /\bSelectTrigger\b/.test(stripComments(readFileSync(file, 'utf8')))
    );
    expect(offenders).toEqual([]);
  });

  // The two deleted components carried `min-w-22` (88px) and `min-w-26`
  // (104px) floors sized to their own longest labels. Combined with
  // `justify-between`, a short label sat in the left part of an over-wide pill
  // with dead space before the chevron — which was reported as "the text is
  // not centred". The real defect was a width floor wider than the content, so
  // the fix is content-fit width, and a floor coming back would revive the
  // same misread.
  it('no fixed width floor comes back to the composer controls', () => {
    const offenders = collectFiles(CHAT_DIR).filter((file) => {
      if (file.includes('__tests__')) return false;
      return /\bmin-w-2[26]\b/.test(stripComments(readFileSync(file, 'utf8')));
    });
    expect(offenders).toEqual([]);
  });
});
