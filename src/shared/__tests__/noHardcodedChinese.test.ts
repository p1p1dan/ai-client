import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No UI code may carry Chinese text outside the dictionary.
 *
 * ## Why this is a test and not a style preference
 *
 * Batch 4 fixed the mirror image of this — English hardcoded into a Chinese
 * UI — and the scanner it added only looks for literal `t('…')` calls, so it
 * could not see the other direction at all. On 2026-09-11 a sweep found **82
 * Chinese literals across 15 files**, including the whole composer permission
 * control: `PERMISSION_GEAR_LABELS`, the mode descriptions, the full-auto
 * confirmation. Language is a user setting (Settings · General), so every one
 * of those stayed Chinese after someone picked English.
 *
 * The rule the repo settled on, both directions: **the English string IS the
 * key**, and `zhTranslations` maps it. That makes "is this translated" a
 * question about where the Chinese lives, which is exactly what this checks.
 *
 * ## What is deliberately allowed
 *
 * - **Comments.** They are for whoever reads the code, not the user.
 * - **`src/shared/i18n.ts`.** It is the dictionary; Chinese is its content.
 * - **Model prompts** (`stores/settings/defaults.ts`) and the code-review
 *   output-language value. Those are text sent TO a model, not shown to a
 *   user — translating them would change what the model is asked to do.
 * - **Test files.** Asserting on Chinese output is how the other guards prove
 *   the dictionary is actually reached.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = ['renderer', 'shared'];
const EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Files whose Chinese is not user-facing copy. Each needs a reason, because an
 * entry added without one is how a list like this stops meaning anything.
 */
const ALLOWED = new Map<string, string>([
  ['shared/i18n.ts', 'the dictionary itself'],
  ['renderer/stores/settings/defaults.ts', 'default prompts sent to the model, not UI copy'],
  ['renderer/hooks/useCodeReview.ts', 'the code-review output language, sent to the model'],
]);

const CJK = /[一-鿿]/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (EXTENSIONS.has(path.extname(name))) out.push(full);
  }
  return out;
}

/**
 * Drop comments so only code is left.
 *
 * Crude on purpose — a `//` inside a string literal would be mistaken for a
 * comment. That direction is safe: it can only make this scan miss something,
 * never invent an offender, and a URL in a string is not where Chinese hides.
 */
function withoutComments(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'));
}

describe('UI copy stays in the dictionary', () => {
  const files = ROOTS.flatMap((root) => sourceFiles(path.join(SRC, root)));

  it('no renderer or shared source hardcodes Chinese text', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(SRC, file).split(path.sep).join('/');
      if (ALLOWED.has(relative)) continue;
      withoutComments(readFileSync(file, 'utf8')).forEach((line, index) => {
        if (CJK.test(line)) offenders.push(`${relative}:${index + 1}  ${line.trim().slice(0, 80)}`);
      });
    }
    // The fix is always the same: put the English in the code as the key, and
    // the Chinese in `zhTranslations`.
    expect(offenders.sort()).toEqual([]);
  });

  it('the scan actually walked the tree', () => {
    // A walker that quietly stopped matching would make the assertion above
    // pass on nothing — the failure mode every source scan has.
    expect(files.length).toBeGreaterThan(300);
  });

  it('every allowance still points at a file that exists', () => {
    // An allowance for a deleted or renamed file is a hole nobody notices.
    const missing = [...ALLOWED.keys()].filter(
      (relative) =>
        !files.some((file) => path.relative(SRC, file).split(path.sep).join('/') === relative)
    );
    expect(missing).toEqual([]);
  });
});
