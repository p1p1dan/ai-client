import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * dsh-rebase P1-6a / decision 041 — the permission library stays host-neutral.
 *
 * Both the 1.0.x runtime and the DSH host run this code, so it may not reach
 * into either of them: no `src/runtime`, no `src/dsh-host`, no `cordis`, no
 * `web-tree-sitter` (the parser is injected), and no Node API beyond path and
 * os algebra — the filesystem, canonical resolution and the clock are injected
 * by the host. The one file outside `src/shared` it may load is the bundled
 * policy table, `src/agent-host/permissionPolicy.mjs`, which is plain data and
 * the single source both hosts must judge against.
 *
 * Checked on VALUE imports transitively, because that is what a host actually
 * loads or bundles; type-only imports are erased, so for those only the
 * library's own files are held to the same targets.
 */

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.dirname(LIBRARY);
const SRC = path.dirname(SHARED);
const REPO = path.dirname(SRC);
const BUNDLED_POLICY = path.join(SRC, 'agent-host', 'permissionPolicy.mjs');
const NODE_BUILTINS = new Set(['node:os', 'node:path']);
/** Named so a failure says what was reached, not only that something was. */
const FORBIDDEN = /(^|[\\/])(runtime|dsh-host)([\\/]|$)|^cordis$|tree-sitter|^@deepseek-ai\//;

interface ImportRef {
  specifier: string;
  typeOnly: boolean;
}

/** Block comments and whole-line `//` comments, so prose cannot look like an import. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function importsOf(file: string): ImportRef[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  const refs: ImportRef[] = [];
  // The clause cannot contain `;`, so an `export const` never runs on into a
  // later statement's `from '...'`.
  const statement = /(?:^|\n)\s*(import|export)\s+([^;]*?)\bfrom\s*(['"])([^'"]+)\3/g;
  for (const match of source.matchAll(statement))
    refs.push({ specifier: match[4], typeOnly: /^type\s/.test(match[2]) });
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*(['"])([^'"]+)\1/g))
    refs.push({ specifier: match[2], typeOnly: false });
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*(['"])([^'"]+)\1/g))
    refs.push({ specifier: match[2], typeOnly: false });
  return refs;
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return undefined;
}

function allowedTarget(file: string): boolean {
  return file === BUNDLED_POLICY || file.startsWith(`${SHARED}${path.sep}`);
}

const libraryFiles = readdirSync(LIBRARY)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => path.join(LIBRARY, name));

const rel = (file: string) => path.relative(REPO, file).replaceAll('\\', '/');

describe('the shared permission library', () => {
  it('is found where the guard looks for it', () => {
    // A walker that silently found nothing would pass every check below.
    expect(libraryFiles.length).toBeGreaterThanOrEqual(12);
    expect(libraryFiles.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining([
        'gate.ts',
        'grants.ts',
        'policy.ts',
        'shellPaths.ts',
        'bashWalker.ts',
      ])
    );
  });

  it('imports only Node path/os, src/shared and the bundled policy table', () => {
    const offenders: string[] = [];
    for (const file of libraryFiles) {
      for (const { specifier } of importsOf(file)) {
        if (FORBIDDEN.test(specifier)) {
          offenders.push(`${rel(file)} -> ${specifier} (forbidden)`);
          continue;
        }
        if (!specifier.startsWith('.')) {
          if (!NODE_BUILTINS.has(specifier)) offenders.push(`${rel(file)} -> ${specifier}`);
          continue;
        }
        const target = resolveRelative(file, specifier);
        if (!target || !allowedTarget(target)) offenders.push(`${rel(file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('loads nothing outside that boundary through its value imports, however deep', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    const queue = [...libraryFiles];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      if (file === BUNDLED_POLICY) {
        // Plain data: it must stay free of imports for the exception to hold.
        if (importsOf(file).length > 0) offenders.push(`${rel(file)} gained an import`);
        continue;
      }
      for (const { specifier, typeOnly } of importsOf(file)) {
        if (typeOnly) continue;
        if (!specifier.startsWith('.')) {
          if (!NODE_BUILTINS.has(specifier)) offenders.push(`${rel(file)} -> ${specifier}`);
          continue;
        }
        const target = resolveRelative(file, specifier);
        if (!target || !allowedTarget(target)) {
          offenders.push(`${rel(file)} -> ${specifier}`);
          continue;
        }
        queue.push(target);
      }
    }
    expect(offenders).toEqual([]);
    // The walk really left the library: the shared helpers it depends on count.
    expect([...seen].some((file) => !file.startsWith(LIBRARY))).toBe(true);
  });

  it('says where each module came from, for merging runtime fixes from main', () => {
    const unlabelled = libraryFiles.filter(
      (file) =>
        !/^\/\/ (Moved from src\/runtime\/\S+\.ts.*\(dsh-rebase P1-6a\)|New in dsh-rebase P1-6a)/.test(
          readFileSync(file, 'utf8')
        )
    );
    expect(unlabelled.map(rel)).toEqual([]);
  });
});
