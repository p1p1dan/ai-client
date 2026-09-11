import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { zhTranslations } from '../i18n';

/**
 * The app ships with Simplified Chinese as its default language, so an English
 * string reaching the screen is a defect, not a fallback. They accumulated
 * anyway: the H/21 point-check found 「AI services」 sitting next to
 * 「历史对话」 in the same five-row list, and measuring the rest turned up 57
 * more across settings, Git, the diff viewer and the profile card.
 *
 * Fixing those was a one-off. This is the part that lasts: adding a `t('…')`
 * call with no catalog entry now fails here rather than in front of a user.
 *
 * ## What it checks, and what it cannot
 *
 * The claim is narrow on purpose: every SINGLE-QUOTED STRING LITERAL passed as
 * the first argument to `t(` somewhere under `src/renderer` has an entry in
 * `zhTranslations`. It says nothing about whether the translation is good, and
 * it cannot see a key built at runtime (`t(someVariable)`) — those exist and
 * are deliberately out of scope, since a scanner cannot know their values.
 */

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../renderer');

/** `t('…')`, first argument only, single quotes, escapes preserved. */
const T_CALL = /\bt\(\s*'((?:[^'\\]|\\.)*)'/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    // Test files are allowed to invent keys: they stub `t` or assert on the
    // English text directly.
    if (name === '__tests__') continue;
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Undo the escaping a TypeScript single-quoted literal applies, so the scanned
 * text is the runtime key. Only `\'` matters in practice; the catalog side is
 * read through a real import, so its keys are already runtime values — which
 * is what makes this comparison honest. (The first version of this scan parsed
 * the catalog as text too, and a key written `\u2019` in source read as eight
 * literal characters, hiding a real duplicate.)
 */
function runtimeKey(literal: string): string {
  return literal.replace(/\\(['"\\])/g, '$1');
}

function collectKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(RENDERER)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(T_CALL)) {
      const key = runtimeKey(match[1] ?? '');
      if (!key) continue;
      const where = path.relative(RENDERER, file);
      const seen = found.get(key);
      if (seen) seen.push(where);
      else found.set(key, [where]);
    }
  }
  return found;
}

describe('Chinese catalog coverage', () => {
  it('every t() key in the renderer has a translation', () => {
    const missing = [...collectKeys()]
      .filter(([key]) => !(key in zhTranslations))
      .map(([key, files]) => `${files[0]}: ${key}`)
      .sort();

    expect(missing).toEqual([]);
  });

  it('the scan actually found the calls it claims to check', () => {
    // A regex that silently stops matching would make the test above pass on
    // nothing at all — the failure mode every source scan has.
    expect(collectKeys().size).toBeGreaterThan(900);
  });
});
