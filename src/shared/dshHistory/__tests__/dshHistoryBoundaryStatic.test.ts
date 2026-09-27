import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * dsh-rebase P1-4a / decision 026 rule 3 — the DSH history projection stays a
 * pure library.
 *
 * The bridge bundles it into the DSH host (whose only npm import may be
 * `@deepseek-ai/dsh-llm`), the root Vitest and Electron Main load it where DSH
 * is not installed, and its callers hand it events they already read. So it
 * may not reach into the runtime, either host, the worker package, cordis or
 * any DSH / pi package, loads no npm package at all through its value imports
 * (not even zod, which `legacyPiSession` may use), and names no Node API, IO
 * least of all.
 */

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.dirname(LIBRARY);
const REPO = path.dirname(path.dirname(SHARED));
const FORBIDDEN =
  /(^|[\\/])(runtime|dsh-host|agent-host|main|renderer)([\\/]|$)|^cordis$|^@earendil-works\/|^@deepseek-ai\//;
const NODE_OR_IO =
  /\b(require\s*\(|process\.|fs\.|readFile|writeFile|appendFile|createReadStream|createWriteStream|spawn|execFile|fetch\s*\(|setTimeout|setInterval|Date\.now\s*\(|Math\.random\s*\()/;

interface ImportRef {
  specifier: string;
  typeOnly: boolean;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function importsOf(file: string): ImportRef[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  const refs: ImportRef[] = [];
  const statement = /(?:^|\n)\s*(import|export)\s+([^;]*?)\bfrom\s*(['"])([^'"]+)\3/g;
  for (const match of source.matchAll(statement))
    refs.push({ specifier: match[4] ?? '', typeOnly: /^type\s/.test(match[2] ?? '') });
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*(['"])([^'"]+)\1/g))
    refs.push({ specifier: match[2] ?? '', typeOnly: false });
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*(['"])([^'"]+)\1/g))
    refs.push({ specifier: match[2] ?? '', typeOnly: false });
  return refs;
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return undefined;
}

const libraryFiles = readdirSync(LIBRARY)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => path.join(LIBRARY, name));
const rel = (file: string) => path.relative(REPO, file).replaceAll('\\', '/');

describe('the shared DSH history library', () => {
  it('is found where the guard looks for it', () => {
    expect(libraryFiles.map((file) => path.basename(file)).sort()).toEqual([
      'page.ts',
      'projection.ts',
      'toolInput.ts',
      'tree.ts',
      'types.ts',
    ]);
  });

  it('loads only src/shared, and no package, through its value imports, however deep', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    const queue = [...libraryFiles];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const { specifier, typeOnly } of importsOf(file)) {
        if (FORBIDDEN.test(specifier)) {
          offenders.push(`${rel(file)} -> ${specifier} (forbidden)`);
          continue;
        }
        if (typeOnly && specifier.startsWith('.')) continue;
        if (!specifier.startsWith('.')) {
          offenders.push(`${rel(file)} -> ${specifier}`);
          continue;
        }
        const target = resolveRelative(file, specifier);
        if (!target || !target.startsWith(`${SHARED}${path.sep}`)) {
          offenders.push(`${rel(file)} -> ${specifier}`);
          continue;
        }
        queue.push(target);
      }
    }
    expect(offenders).toEqual([]);
    // The walk reached past the library: the shared types it depends on count.
    expect([...seen].some((file) => !file.startsWith(LIBRARY))).toBe(true);
  });

  it('spells out `.ts` on every relative import, as Node type stripping needs in the source-run host', () => {
    const offenders = libraryFiles.flatMap((file) =>
      importsOf(file)
        .filter(({ specifier }) => specifier.startsWith('.') && !specifier.endsWith('.ts'))
        .map(({ specifier }) => `${rel(file)} -> ${specifier}`)
    );
    expect(offenders).toEqual([]);
  });

  it('names no Node API, clock, randomness or IO', () => {
    const offenders = libraryFiles.flatMap((file) =>
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .flatMap((line, index) => (NODE_OR_IO.test(line) ? [`${rel(file)}:${index + 1}`] : []))
    );
    expect(offenders).toEqual([]);
  });

  it('says where each module came from', () => {
    const unlabelled = libraryFiles.filter(
      (file) => !readFileSync(file, 'utf8').startsWith('// New in dsh-rebase P1-4a\n')
    );
    expect(unlabelled.map(rel)).toEqual([]);
  });
});
