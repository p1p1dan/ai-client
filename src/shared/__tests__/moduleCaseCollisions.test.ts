import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * A module pair whose names differ only by case is a build-breaking, silently
 * shipping defect, and neither typecheck-as-noise nor the test suite catches it.
 *
 * On a case-INSENSITIVE filesystem (Windows, macOS by default) `import { Foo }
 * from './Foo'` resolves against `foo.ts` when both exist, because Vite's
 * default `resolve.extensions` puts `.ts` before `.tsx` and neither
 * `vitest.config.ts` nor `electron.vite.config.ts` overrides it. The component
 * binding is then `undefined` and that part of the UI renders as nothing. On
 * Linux the same source resolves correctly, so CI is green while every developer
 * and every shipped Windows/macOS build is broken.
 *
 * It reached `main` twice before this test existed:
 *  - `QuestionCard.tsx` / `questionCard.ts` (T-05), which had been failing
 *    `pnpm build` outright — Rollup stops at the FIRST such collision, so it
 *    also masked the second one;
 *  - `ChatMarkdown.tsx` / `chatMarkdown.ts` (T-29).
 *
 * Both were resolved by renaming the PURE module, never the component: design
 * documents cite components as `Foo.tsx:line`, and those citations break if the
 * component moves. The repo's suffixes for the pure half are `*Policy.ts` for a
 * security/decision layer and `*Model.ts` for a view model.
 *
 * `git ls-files` rather than a directory walk, so untracked scratch files and
 * build output cannot fail the suite.
 */

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

function trackedSourceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && SOURCE_EXTENSIONS.test(line))
    .filter((line) => !line.includes('/node_modules/'));
}

describe('no two modules in src differ only by case', () => {
  const files = trackedSourceFiles();

  it('the file list is non-trivial, or every assertion below is vacuous', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('src/renderer/components/chat/ChatMarkdown.tsx');
  });

  /**
   * Extension-blind on purpose: `Foo.tsx` vs `foo.ts` is the case that bites,
   * and it only bites because the two are reachable through the SAME
   * extensionless specifier. Comparing full lower-cased paths would miss it.
   */
  it('no directory holds two modules whose names collide case-insensitively', () => {
    const byKey = new Map<string, string[]>();
    for (const file of files) {
      const slash = file.lastIndexOf('/');
      const dir = file.slice(0, slash);
      const base = file.slice(slash + 1).replace(SOURCE_EXTENSIONS, '');
      const key = `${dir}/${base.toLowerCase()}`;
      byKey.set(key, [...(byKey.get(key) ?? []), file]);
    }

    const collisions = [...byKey.values()]
      .filter((group) => group.length > 1)
      .map((group) => group.sort().join('  <->  '));

    expect(
      collisions,
      [
        'These modules resolve to each other on Windows/macOS, so one of them is',
        'imported as `undefined` and `pnpm build` fails on the first pair.',
        'Fix by renaming the PURE module (`*Policy.ts` / `*Model.ts`), not the',
        'component — see this file’s module note.',
        '',
        ...collisions,
      ].join('\n')
    ).toEqual([]);
  });

  /**
   * The narrower, stricter form: a `.tsx` and a `.ts` that share a name modulo
   * case. This is the exact shape both historical bugs had, and it is called out
   * separately so the failure message can be unambiguous about the fix.
   */
  it('no component/module pair differs only by the case of its first letter', () => {
    const tsxNames = new Map<string, string>();
    const tsNames = new Map<string, string>();
    for (const file of files) {
      const slash = file.lastIndexOf('/');
      const dir = file.slice(0, slash);
      const base = file.slice(slash + 1);
      if (base.endsWith('.tsx')) {
        tsxNames.set(`${dir}/${base.slice(0, -4).toLowerCase()}`, file);
      } else if (base.endsWith('.ts')) {
        tsNames.set(`${dir}/${base.slice(0, -3).toLowerCase()}`, file);
      }
    }
    const pairs = [...tsxNames.entries()]
      .filter(([key]) => tsNames.has(key))
      .map(([key, tsx]) => `${tsx} shadowed by ${tsNames.get(key)}`);
    expect(pairs).toEqual([]);
  });
});
