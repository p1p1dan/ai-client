import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * dsh-rebase P1-16 prep — `subagentCatalogRoots.ts` stays host-neutral.
 *
 * The 1.0.x runtime runs it today; the DSH host's `aiclient-delegates` row
 * (P1-16d) runs it after P1-12 deletes `src/runtime`. So it may not reach into
 * either host, the worker package, Main, the renderer, Electron, cordis or any
 * pi / DSH package — and it does no IO of its own: every read goes through a
 * port the caller supplies (ARD D11 point 4). Node is allowed for path and os
 * algebra only.
 *
 * Unlike the skills/MCP libraries (`fe089adf`), this is one flat file, not a
 * directory: `subagentDefinition.ts` and `subagentBuiltins.ts`, which it
 * imports, already lived in `src/shared` before dsh-rebase P1-16 and are not
 * themselves being moved here — they are covered by the transitive walk below
 * (same as the skills library's walk crossing into `settingSources.ts`), just
 * without a "says where it came from" banner requirement of their own, since
 * they were never inside `src/runtime`.
 *
 * Checked on VALUE imports transitively, because that is what a host loads or
 * bundles; type-only imports are erased.
 */

const SHARED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.dirname(SHARED);
const REPO = path.dirname(SRC);
const ENTRY = path.join(SHARED, 'subagentCatalogRoots.ts');
const NODE_BUILTINS = new Set(['node:os', 'node:path']);
const FORBIDDEN =
  /(^|[\\/])(runtime|dsh-host|agent-host|main|renderer|preload)([\\/]|$)|^electron$|^cordis$|^@earendil-works\/|^@deepseek-ai\/|^(node:)?(fs|fs\/promises|child_process|worker_threads|net|http|https)$/;

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

const rel = (file: string) => path.relative(REPO, file).replaceAll('\\', '/');
const read = (repoPath: string) => readFileSync(path.join(REPO, repoPath), 'utf8');

describe('the shared subagent catalog module', () => {
  it('is found where the guard looks for it', () => {
    // A walker pointed at the wrong file would pass every check below for free.
    expect(existsSync(ENTRY)).toBe(true);
  });

  it('imports only path and os from Node, and only src/shared from the repo', () => {
    const offenders: string[] = [];
    for (const { specifier } of importsOf(ENTRY)) {
      if (FORBIDDEN.test(specifier)) {
        offenders.push(`${rel(ENTRY)} -> ${specifier} (forbidden)`);
        continue;
      }
      if (!specifier.startsWith('.')) {
        if (!NODE_BUILTINS.has(specifier)) offenders.push(`${rel(ENTRY)} -> ${specifier}`);
        continue;
      }
      const target = resolveRelative(ENTRY, specifier);
      if (!target || !inShared(target)) offenders.push(`${rel(ENTRY)} -> ${specifier}`);
    }
    expect(offenders).toEqual([]);
  });

  it('loads nothing outside that boundary through its value imports, however deep', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    const queue = [ENTRY];
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
    // The walk really left the entry file: it pulls in the builtins and the
    // parser/writer library, both of which predate this move.
    expect([...seen].map(rel)).toEqual(
      expect.arrayContaining(['src/shared/subagentBuiltins.ts', 'src/shared/subagentDefinition.ts'])
    );
  });

  it('says where it came from, for merging runtime fixes from main', () => {
    const labelled = /^\/\/ Moved from src\/runtime\/\S+\.ts.*\(dsh-rebase P1-16 prep\)/;
    expect(labelled.test(readFileSync(ENTRY, 'utf8'))).toBe(true);
  });
});

describe('the old subagent catalog location is thin', () => {
  // One copy of the roots/merge/pin logic, not two: a fix merged from main
  // into the old file must conflict loudly rather than land in a copy nothing
  // calls any more.
  const moved =
    /function (subagentRoots|builtinDefinitions|loadRoot|loadSubagentCatalog|applySubagentActivation|resolveSubagentPin|subagentPinDiagnostics)\b/;

  it('src/runtime/plugins/subagent/catalog.ts delegates to src/shared/subagentCatalogRoots.ts', () => {
    const source = read('src/runtime/plugins/subagent/catalog.ts');
    expect(source).toMatch(/shared\/subagentCatalogRoots\.ts/);
    expect(stripComments(source)).not.toMatch(moved);
  });
});
