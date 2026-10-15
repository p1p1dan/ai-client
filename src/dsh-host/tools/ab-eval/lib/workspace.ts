/**
 * A clean repository copy per run, and what the agent changed in it.
 *
 * A fixture is copied (without `.git` and `node_modules`) and committed once
 * (fixed author and dates, so the base commit is the same on every machine); a
 * git source is cloned once into a cache, then cloned locally and checked out
 * at the case's commit. Either way the agent works on branch `main` of a
 * repository with no remote, and every change is measured against the base
 * commit (after the case's setup), committed or not.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { git } from './proc.ts';
import type { ChangedFile, LoadedCase } from './types.ts';

/** Paths never counted as the agent's work. */
export const DEFAULT_IGNORE = [
  'node_modules/**',
  '**/node_modules/**',
  '**/__pycache__/**',
  '**/*.pyc',
  '**/.DS_Store',
];

const FIXED_DATE = '2026-01-01T00:00:00Z';

/** Directories a fixture copy leaves behind: history and installed dependencies. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

function configureRepo(ws: string, env: Record<string, string>): void {
  git(ws, ['config', 'user.name', 'ab-eval'], env);
  git(ws, ['config', 'user.email', 'ab-eval@example.invalid'], env);
  git(ws, ['config', 'core.autocrlf', 'false'], env);
  git(ws, ['config', 'core.safecrlf', 'false'], env);
  // A field repository's deep paths, under a temp directory, pass 260 characters.
  if (process.platform === 'win32') git(ws, ['config', 'core.longpaths', 'true'], env);
}

/** sha256 over a directory's files (`.git` and `node_modules` left out): sorted relative paths and their bytes. */
export function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        if (!SKIPPED_DIRS.has(name)) walk(path);
      } else {
        hash.update(relative(dir, path).split(sep).join('/'));
        hash.update('\0');
        hash.update(readFileSync(path));
        hash.update('\0');
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

/** Copies or clones the case's repository into `ws` (which must be empty); returns the base commit. */
export function prepareWorkspace(
  c: LoadedCase,
  ws: string,
  gitCache: string,
  env: Record<string, string>
): string {
  if ('fixture' in c.repo) {
    cpSync(c.repo.fixture, ws, {
      recursive: true,
      filter: (source) => !SKIPPED_DIRS.has(basename(source)),
    });
    git(ws, ['init', '-q', '-b', 'main'], env);
    configureRepo(ws, env);
    git(ws, ['add', '-A'], env);
    git(ws, ['commit', '-q', '--no-verify', '-m', `fixture: ${c.id}`], {
      ...env,
      GIT_AUTHOR_DATE: FIXED_DATE,
      GIT_COMMITTER_DATE: FIXED_DATE,
    });
  } else {
    const { git: url, commit } = c.repo;
    const cache = join(gitCache, createHash('sha256').update(url).digest('hex').slice(0, 16));
    if (!existsSync(cache)) git(gitCache, ['clone', '--quiet', '--mirror', url, cache], env);
    try {
      git(cache, ['cat-file', '-e', `${commit}^{commit}`], env);
    } catch {
      git(cache, ['fetch', '--quiet', 'origin', commit], env);
    }
    git(gitCache, ['clone', '--quiet', '--no-checkout', cache, ws], env);
    git(ws, ['checkout', '-q', '-B', 'main', commit], env);
    git(ws, ['remote', 'remove', 'origin'], env);
    configureRepo(ws, env);
  }
  return git(ws, ['rev-parse', 'HEAD'], env).trim();
}

/**
 * Commits what the case's setup commands changed (ignored files stay out, as
 * they would in any commit), so the agent's diff starts after them. Returns
 * the new base commit, or `base` when setup changed nothing tracked.
 */
export function commitSetup(ws: string, base: string, env: Record<string, string>): string {
  git(ws, ['add', '-A'], env);
  if (git(ws, ['status', '--porcelain'], env).trim() === '') return base;
  git(ws, ['commit', '-q', '--no-verify', '-m', 'ab-eval: setup'], {
    ...env,
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_DATE: FIXED_DATE,
  });
  return git(ws, ['rev-parse', 'HEAD'], env).trim();
}

/** `ignore` globs as git pathspecs that exclude them. */
function excludes(ignore: readonly string[]): string[] {
  return ['.', ...ignore.map((glob) => `:(exclude,glob)${glob}`)];
}

/** Everything the agent changed since `base`, untracked files included, and the patch. */
export function collectChanges(
  ws: string,
  base: string,
  ignore: readonly string[],
  env: Record<string, string>
): { files: ChangedFile[]; patch: string } {
  const specs = excludes(ignore);
  git(ws, ['add', '-A', '--', ...specs], env);
  const numstat = git(
    ws,
    ['diff', '--cached', '--no-renames', '--numstat', '-z', base, '--', ...specs],
    env
  );
  const status = git(
    ws,
    ['diff', '--cached', '--no-renames', '--name-status', '-z', base, '--', ...specs],
    env
  );
  const patch = git(ws, ['diff', '--cached', '--no-renames', base, '--', ...specs], env);
  const statusOf = new Map<string, string>();
  const parts = status.split('\0').filter(Boolean);
  for (let i = 0; i + 1 < parts.length; i += 2) statusOf.set(parts[i + 1], parts[i]);
  const files: ChangedFile[] = [];
  for (const entry of numstat.split('\0').filter(Boolean)) {
    const [added, deleted, ...rest] = entry.split('\t');
    const path = rest.join('\t');
    const binary = added === '-' || deleted === '-';
    files.push({
      path,
      status: statusOf.get(path) ?? '?',
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    });
  }
  return { files, patch };
}

/** The hidden check files, copied over the workspace once the agent is done. */
export function applyOverlay(overlayDir: string, ws: string): void {
  cpSync(overlayDir, ws, { recursive: true, force: true });
}
