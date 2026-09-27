import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * dsh-rebase P1-9b — the seed converter stays a pure library.
 *
 * The DSH host bundles it into `seedSession` (P1-9c), where the only npm
 * import allowed is `@deepseek-ai/dsh-llm`; the root Vitest runs it without
 * DSH. It reads pi files the migration must never write. So, through every
 * value import however deep: no runtime, host, worker, Main or renderer code,
 * no cordis / pi / DSH package, no npm package at all (the pi projection
 * modules that reach zod stay out), no Node API but hashing and path algebra;
 * and in its own files no write API, clock, randomness or process access.
 */

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.resolve(LIBRARY, '../..');
const REPO = path.resolve(SHARED, '../..');
const NODE_BUILTINS = new Set(['node:crypto', 'node:path']);
const FORBIDDEN =
  /(^|[\\/])(runtime|dsh-host|agent-host|main|renderer)([\\/]|$)|^cordis$|^@earendil-works\/|^@deepseek-ai\/|^(node:)?(fs|fs\/promises|child_process|worker_threads|net|http|https|os)$/;
const IMPURE =
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|renameSync|unlinkSync|rmSync|mkdirSync|copyFileSync|openSync|readFile|readFileSync|Date\.now|Math\.random|process\.|setTimeout|setInterval|fetch)\s*[(.]/;
/** The pi projections: they reach zod through `sessionFileChange.ts`. */
const PROJECTIONS = /legacyPiSession[\\/](timeline|tree)\.ts$/;

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

describe('the pi → DSH seed converter', () => {
  it('is found where the guard looks for it', () => {
    expect(libraryFiles.map((file) => path.basename(file)).sort()).toEqual([
      'assistant.ts',
      'fromImport.ts',
      'fromPi.ts',
      'images.ts',
      'index.ts',
      'invariants.ts',
      'llmText.ts',
      'seed.ts',
      'types.ts',
    ]);
  });

  it('loads only src/shared and hashing / path builtins through its value imports, however deep', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    const queue = [...libraryFiles];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      if (PROJECTIONS.test(file)) offenders.push(`${rel(file)} (a pi projection)`);
      for (const { specifier, typeOnly } of importsOf(file)) {
        if (FORBIDDEN.test(specifier)) {
          offenders.push(`${rel(file)} -> ${specifier} (forbidden)`);
          continue;
        }
        if (typeOnly) continue;
        if (!specifier.startsWith('.')) {
          if (!NODE_BUILTINS.has(specifier)) offenders.push(`${rel(file)} -> ${specifier}`);
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
    // The walk really reached the decode chain it builds on.
    expect([...seen].map(rel)).toEqual(
      expect.arrayContaining([
        'src/shared/legacyPiSession/codec.ts',
        'src/shared/legacyPiSession/legacy.ts',
        'src/shared/permissions/grants.ts',
      ])
    );
  });

  it('spells out `.ts` on every relative import, as the source-run host needs', () => {
    const offenders = libraryFiles.flatMap((file) =>
      importsOf(file)
        .filter(({ specifier }) => specifier.startsWith('.') && !specifier.endsWith('.ts'))
        .map(({ specifier }) => `${rel(file)} -> ${specifier}`)
    );
    expect(offenders).toEqual([]);
  });

  it('names no write API, file read, clock, randomness or process access', () => {
    const offenders = libraryFiles.flatMap((file) =>
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .flatMap((line, index) => (IMPURE.test(line) ? [`${rel(file)}:${index + 1}`] : []))
    );
    expect(offenders).toEqual([]);
  });

  it('says where each module came from', () => {
    const unlabelled = libraryFiles.filter(
      (file) =>
        !/^\/\/ (New in dsh-rebase P1-9b|Vendored from @earendil-works\/pi-agent-core \S+ .*\(dsh-rebase P1-9b\))\n/.test(
          readFileSync(file, 'utf8')
        )
    );
    expect(unlabelled.map(rel)).toEqual([]);
  });

  it('keeps the upstream copyright and MIT notice on the vendored code', () => {
    const vendored = readFileSync(path.join(LIBRARY, 'llmText.ts'), 'utf8');
    expect(vendored).toContain('Copyright (c) 2025 Mario Zechner');
    expect(vendored).toContain('Permission is hereby granted, free of charge');
    expect(vendored).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(readFileSync(path.join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8')).toContain(
      'src/shared/legacyPiSession/convert/llmText.ts'
    );
  });
});
