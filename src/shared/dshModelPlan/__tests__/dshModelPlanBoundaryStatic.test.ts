import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDshModelPlan } from '../index.ts';

/**
 * dsh-rebase P1-5a (decision 033) — the model plan stays a pure library and
 * never carries a key.
 *
 * Main loads it where DSH is not installed, and the bridge will load it inside
 * the DSH host from source under Node type stripping. So it may not reach
 * into the runtime, either host, main, the renderer, cordis or any DSH / pi
 * package; its only package is `node:crypto` (the revision hash); relative
 * imports stay in `src/shared` and spell out `.ts`; and it names no IO, clock
 * or randomness, so the same catalog always gives the same revision.
 */

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.dirname(LIBRARY);
const REPO = path.dirname(path.dirname(SHARED));
const FORBIDDEN =
  /(^|[\\/])(runtime|dsh-host|agent-host|main|renderer)([\\/]|$)|^cordis$|^@earendil-works\/|^@deepseek-ai\/|^(node:)?fs(\/|$)/;
const ALLOWED_PACKAGES = new Set(['node:crypto']);
const NODE_OR_IO =
  /\b(require\s*\(|process\.|fs\.|readFile|writeFile|existsSync|spawn|execFile|fetch\s*\(|setTimeout|setInterval|Date\.now\s*\(|new Date\s*\(|Math\.random\s*\(|console\.)/;

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

describe('the shared DSH model plan library', () => {
  it('is found where the guard looks for it', () => {
    expect(libraryFiles.map((file) => path.basename(file)).sort()).toEqual([
      'build.ts',
      'index.ts',
      'menu.ts',
      'route.ts',
      'settings.ts',
      'tables.ts',
      'types.ts',
    ]);
  });

  it('loads only src/shared and node:crypto, however deep, and never fs', () => {
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
          if (!ALLOWED_PACKAGES.has(specifier)) offenders.push(`${rel(file)} -> ${specifier}`);
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

  it('spells out `.ts` on every relative import, as Node type stripping needs in the host', () => {
    const offenders = libraryFiles.flatMap((file) =>
      importsOf(file)
        .filter(({ specifier }) => specifier.startsWith('.') && !specifier.endsWith('.ts'))
        .map(({ specifier }) => `${rel(file)} -> ${specifier}`)
    );
    expect(offenders).toEqual([]);
  });

  it('names no IO, environment, clock, randomness or logging', () => {
    const offenders = libraryFiles.flatMap((file) =>
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .flatMap((line, index) => (NODE_OR_IO.test(line) ? [`${rel(file)}:${index + 1}`] : []))
    );
    expect(offenders).toEqual([]);
  });

  it('says where each module came from', () => {
    const unlabelled = libraryFiles.filter(
      (file) => !readFileSync(file, 'utf8').startsWith('// New in dsh-rebase P1-5a\n')
    );
    expect(unlabelled.map(rel)).toEqual([]);
  });
});

describe('a plan carries references, never keys', () => {
  const KEY_FIELDS = /^(apikey|api_key|key|token|secret|password|authorization|credentials?)$/i;

  function keyFields(value: unknown, at = '$'): string[] {
    if (Array.isArray(value)) return value.flatMap((item, i) => keyFields(item, `${at}[${i}]`));
    if (value === null || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([name, child]) => [
      ...(KEY_FIELDS.test(name) ? [`${at}.${name}`] : []),
      ...keyFields(child, `${at}.${name}`),
    ]);
  }

  it('has no key-shaped field anywhere, and every route names its key by reference', () => {
    const plan = buildDshModelPlan({
      models: {
        providers: {
          a: {
            api: 'anthropic-messages',
            baseUrl: 'https://gw.example.test',
            apiKey: 'sk-canary-static',
            credentials: { apiKey: 'managed' },
            models: [{ id: 'm', key: 'sk-canary-static', token: 'sk-canary-static' }],
          },
        },
      },
      keyed: { a: true },
    });
    expect(keyFields(plan)).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain('sk-canary-static');
    for (const route of Object.values(plan.routes)) {
      expect(route.apiKeyEnv).toMatch(/^AICLIENT_KEY_[A-Z0-9_]+_[0-9A-F]{4}$/);
      expect(plan.refs[route.apiKeyEnv]).toBe('a');
    }
  });
});
