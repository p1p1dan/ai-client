import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_STATE_DIR,
  buildWorktreePath,
  expandHomePath,
  getDefaultCloneBaseDir,
  getDefaultTemporaryBasePath,
  getDefaultWorktreeBasePath,
  LEGACY_APP_STATE_DIR,
} from '../defaultPaths';

describe('defaultPaths', () => {
  it('uses JYWAI directories for default base paths', () => {
    expect(getDefaultTemporaryBasePath('/Users/pi', '/')).toBe('/Users/pi/JYWAI/temporary');
    expect(getDefaultWorktreeBasePath('/Users/pi', '/')).toBe('/Users/pi/JYWAI/workspaces');
    expect(getDefaultCloneBaseDir('/Users/pi', '/')).toBe('/Users/pi/JYWAI/repos');
  });

  it('expands tilde-prefixed paths against the current home directory', () => {
    expect(expandHomePath('~/JYWAI/repos', '/Users/pi', '/')).toBe('/Users/pi/JYWAI/repos');
    expect(expandHomePath('~\\JYWAI\\workspaces', 'C:\\Users\\pi', '\\')).toBe(
      'C:\\Users\\pi\\JYWAI\\workspaces'
    );
  });

  it('builds worktree paths from configured home-relative base paths', () => {
    expect(
      buildWorktreePath({
        branchName: 'feature-login',
        configuredBasePath: '~/JYWAI/workspaces',
        homeDir: '/Users/pi',
        pathSep: '/',
        projectName: '/repos/jyw-ai-client',
      })
    ).toBe('/Users/pi/JYWAI/workspaces/jyw-ai-client/feature-login');
  });
});

/**
 * APP_STATE_DIR — the app's own `$HOME` state directory. Consolidated
 * 2026-08-26 (plan `unified-credentials` S1), renamed `.aiclient` -> `.pilab`
 * in S2.
 *
 * The scan below is the point of the whole exercise: asserting the VALUE
 * would pass just as happily with four of five call sites still carrying
 * their own copy, so the assertion is "the literal exists exactly once".
 *
 * ## Why the scan now strips comments instead of demanding a leading quote
 *
 * S1's version matched `'<name>` — the name behind an opening single quote.
 * That was chosen to stop the `.aiclient-generated` sidecar FILENAME reading
 * as a hit on the directory name, and it worked for that. It also silently
 * missed every use inside a template literal, and there was one:
 * `RemoteConnectionManager`'s `` `${runtime.homeDir}/.aiclient` `` survived
 * S1's "converted all five sites" pass and was only found by hand during S2.
 *
 * So the rule is now the honest one — the name may appear in COMMENTS
 * (history, cross-references, release notes all need to say it) but never in
 * code — and the sidecar filename is excluded by requiring the match not to
 * be followed by `-` or a word character.
 */
describe('APP_STATE_DIR is the single source of truth for the app state dir', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

  /**
   * Removes `//` and block comments while respecting string and template
   * literals, so a URL inside a string is not mistaken for a comment start.
   * Deliberately hand-rolled: a real parser here would be a dependency added
   * to make one assertion slightly prettier.
   */
  function stripComments(text: string): string {
    let out = '';
    let i = 0;
    let quote: string | null = null;
    while (i < text.length) {
      const c = text[i];
      const next = text[i + 1];
      if (quote) {
        if (c === '\\') {
          out += c + (next ?? '');
          i += 2;
          continue;
        }
        if (c === quote) quote = null;
        out += c;
        i += 1;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        quote = c;
        out += c;
        i += 1;
        continue;
      }
      if (c === '/' && next === '/') {
        while (i < text.length && text[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && next === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
        i += 2;
        continue;
      }
      out += c;
      i += 1;
    }
    return out;
  }

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  /**
   * The directory name as a WHOLE segment.
   *
   * The trailing guard excludes the `.aiclient-generated` sidecar FILENAME.
   * The leading guard excludes `com.aiclient.app` — the bundle id, which is a
   * separate brand string that S2 deliberately does not touch (open-q #4).
   */
  function dirNameRegex(name: string): RegExp {
    return new RegExp(`(?<![\\w])\\${name}(?![-\\w])`);
  }

  function scanFor(name: string, allowed: string[]): string[] {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(repoRoot, 'src'))) {
      const rel = path.relative(repoRoot, file);
      if (allowed.includes(rel)) continue;
      if (rel.includes(`${path.sep}__tests__${path.sep}`)) continue;
      if (dirNameRegex(name).test(stripComments(readFileSync(file, 'utf8')))) offenders.push(rel);
    }
    return offenders;
  }

  const DEFINITION = path.join('src', 'shared', 'defaultPaths.ts');

  /**
   * Display text, not a path. These are the placeholder EXAMPLES shown under
   * the remote helper / runtime install-directory fields, and their English
   * string doubles as the i18n lookup key — so the literal is the key, and
   * building it from the constant would be building a key at runtime.
   *
   * Listed rather than silently skipped: a future rename has to come here and
   * decide about them, exactly as S2 had to (S1 left them for S2 by name).
   */
  const DISPLAY_TEXT = [
    path.join('src', 'shared', 'i18n.ts'),
    path.join('src', 'renderer', 'components', 'settings', 'RemoteSettings.tsx'),
  ];

  it('appears in no source file but its own definition', () => {
    expect(scanFor(APP_STATE_DIR, [DEFINITION, ...DISPLAY_TEXT])).toEqual([]);
  });

  /**
   * The old name is allowed in exactly two places: the constant that names it
   * for the migration, and the migration's own module header. Anywhere else
   * it is a call site that never got renamed — the failure mode S2 is meant
   * to make impossible, and the one that already happened once in S1.
   */
  it('leaves the pre-rename name only where the migration needs it', () => {
    expect(
      scanFor(LEGACY_APP_STATE_DIR, [
        DEFINITION,
        path.join('src', 'main', 'services', 'appStateMigration.ts'),
      ])
    ).toEqual([]);
  });

  it('names both the current directory and the one being migrated away from', () => {
    // Changing either value without `appStateMigration.ts` agreeing is how an
    // existing install silently becomes a fresh one — the migration keys off
    // exactly these two names.
    expect(APP_STATE_DIR).toBe('.pilab');
    expect(LEGACY_APP_STATE_DIR).toBe('.aiclient');
  });
});
