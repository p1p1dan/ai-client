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
 * APP_STATE_DIR — the app's own `$HOME` state directory, consolidated
 * 2026-08-26 (plan `unified-credentials` S1).
 *
 * The scan below is the point of the whole exercise. Five modules used to
 * spell `'.aiclient'` themselves; a rename would have been five independent
 * edits with nothing to catch a missed one. Asserting the VALUE here would be
 * worthless — it would pass just as happily with four of the five sites still
 * carrying their own copy. So the assertion is "the literal exists exactly
 * once in the repo", which is the property that actually makes a rename safe.
 */
describe('APP_STATE_DIR is the single source of truth for the app state dir', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

  /**
   * Display text, not a path: these are i18n placeholder EXAMPLES whose
   * English string doubles as the translation key, so rewriting them changes
   * a lookup key rather than a directory. Left alone deliberately in S1
   * ("zero behaviour change"), and listed here rather than silently skipped
   * so the rename batch (S2) cannot forget them.
   */
  const RENAME_TODO_DISPLAY_TEXT = [
    path.join('src', 'shared', 'i18n.ts'),
    path.join('src', 'renderer', 'components', 'settings', 'RemoteSettings.tsx'),
  ];

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

  it('appears nowhere else in src/ than its own definition', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(repoRoot, 'src'))) {
      const rel = path.relative(repoRoot, file);
      if (rel === path.join('src', 'shared', 'defaultPaths.ts')) continue;
      if (rel.includes(`${path.sep}__tests__${path.sep}`)) continue;
      if (RENAME_TODO_DISPLAY_TEXT.includes(rel)) continue;
      // A trailing `'` or `/` only — otherwise the `.aiclient-generated`
      // sidecar FILENAME (claudeHome.ts) reads as a hit on the DIRECTORY name.
      const text = readFileSync(file, 'utf8');
      if (new RegExp(`'\\${APP_STATE_DIR}['/]`).test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('still resolves to the directory already on users’ disks', () => {
    // A rename is planned (D59). Until the migration lands with it, changing
    // this value alone would silently orphan every existing install.
    expect(APP_STATE_DIR).toBe('.aiclient');
  });
});
