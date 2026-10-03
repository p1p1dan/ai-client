import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * dsh-rebase P1-16 prep — the MCP library stays host-neutral.
 *
 * The 1.0.x runtime runs it today; the DSH host's `aiclient-mcp` row (P1-16b)
 * runs it after P1-12 deletes `src/runtime`, inside a bare Node host bundled
 * by esbuild. So it may not reach into either host, the worker package, Main,
 * the renderer, Electron, cordis or any pi / DSH package. Above all it never
 * starts a process or opens a file itself: the server process comes out of the
 * host's exec exit and the config out of the host's file port (ARD D11 point
 * 4), which is why `node:child_process` and `node:fs` are named here outright.
 *
 * Checked on VALUE imports transitively, because that is what a host loads or
 * bundles; type-only imports are erased.
 */

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.dirname(LIBRARY);
const SRC = path.dirname(SHARED);
const REPO = path.dirname(SRC);
/** `os` for the memory tiers of the server budget, `path` for the config file names. */
const NODE_BUILTINS = new Set(['node:os', 'node:path']);
const FORBIDDEN =
  /(^|[\\/])(runtime|dsh-host|agent-host|main|renderer|preload)([\\/]|$)|^electron$|^cordis$|^@earendil-works\/|^@deepseek-ai\/|^@modelcontextprotocol\/|^(node:)?(fs|fs\/promises|child_process|worker_threads|net|http|https)$/;

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

const inShared = (file: string) => file.startsWith(`${SHARED}${path.sep}`);

const libraryFiles = readdirSync(LIBRARY)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => path.join(LIBRARY, name));

const rel = (file: string) => path.relative(REPO, file).replaceAll('\\', '/');

describe('the shared MCP library', () => {
  it('is found where the guard looks for it', () => {
    // A walker that silently found nothing would pass every check below.
    expect(libraryFiles.map((file) => path.basename(file)).sort()).toEqual([
      'client.ts',
      'config.ts',
      'connect.ts',
      'errors.ts',
      'naming.ts',
      'results.ts',
    ]);
  });

  it('imports only path and os from Node, and only src/shared from the repo', () => {
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
        if (!target || !inShared(target)) offenders.push(`${rel(file)} -> ${specifier}`);
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
      for (const { specifier, typeOnly } of importsOf(file)) {
        if (typeOnly) continue;
        if (FORBIDDEN.test(specifier)) {
          offenders.push(`${rel(file)} -> ${specifier} (forbidden)`);
          continue;
        }
        if (!specifier.startsWith('.')) {
          if (!NODE_BUILTINS.has(specifier)) offenders.push(`${rel(file)} -> ${specifier}`);
          continue;
        }
        const target = resolveRelative(file, specifier);
        if (!target || !inShared(target)) {
          offenders.push(`${rel(file)} -> ${specifier}`);
          continue;
        }
        queue.push(target);
      }
    }
    expect(offenders).toEqual([]);
    // The walk really left the library: the setting-source gate and the error
    // helper it depends on count.
    expect([...seen].map(rel)).toEqual(
      expect.arrayContaining(['src/shared/settingSources.ts', 'src/shared/errorCode.ts'])
    );
  });

  it('says where each module came from, for merging runtime fixes from main', () => {
    const labelled =
      /^\/\/ (Moved from src\/runtime\/\S+\.ts.*\(dsh-rebase P1-16 prep\)|New in dsh-rebase P1-16 prep)/;
    const unlabelled = libraryFiles.filter((file) => !labelled.test(readFileSync(file, 'utf8')));
    expect(unlabelled.map(rel)).toEqual([]);
  });
});

/**
 * dsh-rebase P1-12 step 3 (decision 147) deleted the old locations under
 * `src/runtime`, so the "old MCP locations are thin" section went with them: a
 * fix merged from main into one of those files now conflicts as modify/delete
 * (risk R4), and the banners above say where it belongs. The library itself
 * stays (decision 090).
 */
