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
 *
 * ## T023: why `runtime` and `agent-host` are now in scope
 *
 * They were not, and the reason they were not is that this guard was written
 * during a renderer sweep. The 2026-09-14 audit then found the same defect
 * class living unwatched on the other side of the worker boundary: four
 * finished Chinese sentences in `runtime/worker/permissionPrompt.ts` painting
 * the permission card, three more as `ui.select` options in
 * `runtime/plugins/permissions/bridge.ts`, and the imported-history banner in
 * `agent-host/piSessionTimeline.ts`.
 *
 * The excuse each of them carried was true and beside the point: a worker has
 * no renderer locale. That is an argument for sending an IDENTIFIER, which is
 * what they send now — never for picking a language on the user's behalf.
 *
 * `.mjs` and `.mts` joined `EXTENSIONS` for the same reason the roots did:
 * `agent-host/permissionPolicy.mjs`, `bundledPlugins.mjs` and the two
 * `runtime/host/*.mjs` helpers are shipped source that no scan looked at. They
 * hold Chinese only in comments, so nothing needed an allowance — but an
 * extension list that silently excludes real source files is a hole that only
 * looks closed.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = ['renderer', 'shared', 'runtime', 'agent-host'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.mts']);

/**
 * Per-root floors, because one number for the whole tree cannot tell "the
 * renderer grew" from "the runtime root stopped being walked". `src/runtime`
 * in particular carries its own `node_modules` (it is a separate npm
 * subpackage), so a walker bug there would drop 82 files and still clear a
 * global threshold on the renderer's 416 alone.
 */
const MIN_FILES_PER_ROOT: Record<string, number> = {
  renderer: 300,
  shared: 50,
  runtime: 60,
  // T036 deleted the retired dialog bridge module, the one walked file this
  // root lost (its test and the orphaned pi SDK stub live under `__tests__`,
  // which this walker skips), so the floor moves down by exactly one. These
  // are `toBeGreaterThan` tripwires for "did the walker stop walking", kept
  // one below the real count so the next deletion is a conscious edit.
  'agent-host': 14,
};

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
 *
 * T023: a block comment collapses to its own newlines rather than to nothing,
 * so the reported line number is the file's. It used to collapse to `''`,
 * which shifted every line after the first block comment — tolerable in the
 * renderer, useless in `src/runtime`, where files open with 40-line doc
 * comments and an offender would have been reported dozens of lines early.
 *
 * CRLF is normalised to LF before anything else, and that order matters. The
 * line-comment pattern below anchors on `$` without the `m` flag, so it only
 * ever matches the end of the WHOLE string — which is why the scan splits on
 * `\n` first and treats each element as a line. On a CRLF file the trailing
 * `\r` survives that split, so it sits between the `.*` and the `$` and the
 * pattern cannot match at all: no `//` comment is ever stripped, and Chinese
 * in a comment is reported as hardcoded UI copy. `.gitattributes` pins these
 * sources to `eol=lf`, but a checkout on a `core.autocrlf=true` machine can
 * still hold CRLF on disk while `git status` reads clean, so the guard has to
 * be indifferent to line endings rather than trusting the checkout. Collapsing
 * to LF cannot hide a real offender: the text of every line is unchanged.
 */
function withoutComments(source: string): string[] {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'));
}

describe('UI copy stays in the dictionary', () => {
  const files = ROOTS.flatMap((root) => sourceFiles(path.join(SRC, root)));

  it('no renderer, shared, runtime or agent-host source hardcodes Chinese text', () => {
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

  it('the scan actually walked every root', () => {
    // A walker that quietly stopped matching would make the assertion above
    // pass on nothing — the failure mode every source scan has.
    const counts = Object.fromEntries(
      ROOTS.map((root) => [root, sourceFiles(path.join(SRC, root)).length])
    );
    for (const [root, minimum] of Object.entries(MIN_FILES_PER_ROOT)) {
      expect(counts[root] ?? 0).toBeGreaterThan(minimum);
    }
    expect(files.length).toBe(Object.values(counts).reduce((sum, count) => sum + count, 0));
  });

  it('reaches the extensions the shipped roots are actually written in', () => {
    // T023: `.mjs` was outside the scan while `agent-host/permissionPolicy.mjs`
    // shipped in the artifact. Naming the files pins that the extension list
    // and the walker agree, rather than trusting the set literal alone.
    const scanned = new Set(files.map((file) => path.extname(file)));
    expect([...scanned].sort()).toEqual(['.mjs', '.mts', '.ts', '.tsx']);
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
