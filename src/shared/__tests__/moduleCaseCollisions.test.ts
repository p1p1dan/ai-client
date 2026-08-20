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
 * build output cannot fail the suite. `node_modules`, `out`, `dist` and `.git`
 * need no explicit exclusion for the same reason: the first three are
 * `.gitignore`d and the fourth is never tracked, so `git ls-files` cannot
 * surface any of them.
 *
 * ## Scan scope
 *
 * `src/` is Vite's bundled tree — the case where a wrong resolution silently
 * ships. `scripts/` is added alongside it: those files are real `.ts`/`.mjs`
 * source run directly by Node/`tsx` (`generate-themes.ts` via `npx tsx`,
 * `dev.js`, the packaging helpers), so a same-directory case collision there
 * resolves wrong on the same case-insensitive filesystems, just via Node's
 * resolver instead of Vite's. Checked and deliberately left out: `packages/`
 * is Go, not JS/TS; `build/` holds only binary icons and an entitlements
 * plist; `.codex/`, `.github/` and `resources/` carry no tracked
 * `.ts/.tsx/.js/.jsx/.mjs/.cjs` files as of this writing. There is no
 * `spikes/` directory in this repo.
 */

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Directories that hold source resolved by Vite (`src`) or invoked directly by
 * Node/`tsx` (`scripts`) — see the module note above for what was checked and
 * excluded.
 */
const SCAN_ROOTS = ['src', 'scripts'];

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', ...SCAN_ROOTS], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.includes('/node_modules/'));
}

function trackedSourceFiles(): string[] {
  return trackedFiles().filter((line) => SOURCE_EXTENSIONS.test(line));
}

describe('no two modules under src/ or scripts/ differ only by case', () => {
  const files = trackedSourceFiles();

  it('the file list is non-trivial, or every assertion below is vacuous', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain('src/renderer/components/chat/ChatMarkdown.tsx');
    // Proof the scan actually reaches the added root, not just `src/`.
    expect(files).toContain('scripts/generate-themes.ts');
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

/**
 * A second, orthogonal failure mode: two SIBLING DIRECTORIES whose names
 * collide case-insensitively (`Components/` next to `components/`). Module
 * resolution walks a specifier one path segment at a time, so a directory
 * collision resolves wrong on a case-insensitive filesystem for exactly the
 * same reason a file collision does — an import spelled through one casing
 * can silently land inside the other directory's tree instead.
 *
 * Extension-blind by construction: the directory itself is what collides,
 * regardless of what it holds, so this walks every tracked path under the
 * scan roots rather than filtering to `SOURCE_EXTENSIONS` first.
 */
describe('no two sibling directories under src/ or scripts/ differ only by case', () => {
  /** Every directory that appears along any tracked file's path, deduped. */
  function trackedDirectories(): string[] {
    const dirs = new Set<string>();
    for (const file of trackedFiles()) {
      const segments = file.split('/');
      segments.pop(); // drop the filename, keep only directory segments
      let current = '';
      for (const segment of segments) {
        current = current ? `${current}/${segment}` : segment;
        dirs.add(current);
      }
    }
    return [...dirs];
  }

  const dirs = trackedDirectories();

  it('the directory list is non-trivial, or the assertion below is vacuous', () => {
    expect(dirs.length).toBeGreaterThan(20);
    expect(dirs).toContain('src/renderer/components/chat');
  });

  it('no two directories sharing a parent collide case-insensitively', () => {
    const byKey = new Map<string, string[]>();
    for (const dir of dirs) {
      const slash = dir.lastIndexOf('/');
      const parent = slash === -1 ? '' : dir.slice(0, slash);
      const name = slash === -1 ? dir : dir.slice(slash + 1);
      const key = `${parent}/${name.toLowerCase()}`;
      byKey.set(key, [...(byKey.get(key) ?? []), dir]);
    }

    const collisions = [...byKey.values()]
      .filter((group) => group.length > 1)
      .map((group) => group.sort().join('  <->  '));

    expect(
      collisions,
      [
        'These directories resolve to each other on Windows/macOS, so an import',
        "through one spelling can silently land inside the other one's tree.",
        '',
        ...collisions,
      ].join('\n')
    ).toEqual([]);
  });
});
