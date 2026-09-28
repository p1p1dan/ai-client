import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * dsh-rebase P1-16 prep — the skills library stays host-neutral.
 *
 * The 1.0.x runtime runs it today; the DSH host's skill compatibility report
 * (P1-16a) and prompt-template expansion (P1-16c) run it after P1-12 deletes
 * `src/runtime`. So it may not reach into either host, the worker package,
 * Main, the renderer, Electron, cordis or any pi / DSH package — and it does
 * no IO of its own: every read goes through a port the host supplies (ARD D11
 * point 4). Node is allowed for path and os algebra only.
 *
 * Checked on VALUE imports transitively, because that is what a host loads or
 * bundles; type-only imports are erased.
 */

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.dirname(LIBRARY);
const SRC = path.dirname(SHARED);
const REPO = path.dirname(SRC);
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

const libraryFiles = readdirSync(LIBRARY)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => path.join(LIBRARY, name));

const rel = (file: string) => path.relative(REPO, file).replaceAll('\\', '/');
const read = (repoPath: string) => readFileSync(path.join(REPO, repoPath), 'utf8');

describe('the shared skills library', () => {
  it('is found where the guard looks for it', () => {
    // A walker that silently found nothing would pass every check below.
    expect(libraryFiles.map((file) => path.basename(file)).sort()).toEqual([
      'catalog.ts',
      'expand.ts',
      'frontmatter.ts',
      'loader.ts',
      'templates.ts',
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
    const unlabelled = [
      ...libraryFiles,
      path.join(SHARED, 'settingSources.ts'),
      path.join(SHARED, 'errorCode.ts'),
    ].filter((file) => !labelled.test(readFileSync(file, 'utf8')));
    expect(unlabelled.map(rel)).toEqual([]);
  });
});

describe('the old skills locations are thin', () => {
  // One copy of the loader, not two: a fix merged from main into the old file
  // must conflict loudly rather than land in a copy nothing calls any more.
  const thin: [string, RegExp][] = [
    [
      'src/runtime/plugins/skills/loader.ts',
      /function (parseFrontmatter|readSkillFile|walkRoot|resolveEntryKind|loadSkills|isValidName)\b/,
    ],
    [
      'src/runtime/plugins/skills/templates.ts',
      /function (loadPromptTemplates|templateBody|firstLine)\b/,
    ],
    [
      'src/runtime/plugins/skills/expand.ts',
      /function (parseCommandArgs|substituteArgs|parseSlashInvocation|expandPrompt)\b/,
    ],
    [
      'src/runtime/plugins/skills/index.ts',
      /function (skillSource|projectSkillDirectories|skillRoots|templateRoots|loadSkillCatalog)\b/,
    ],
    ['src/runtime/settingSources.ts', /function resolveSettingSources\b/],
  ];

  it.each(thin)('%s delegates to src/shared', (file, moved) => {
    const source = read(file);
    expect(source).toMatch(/shared\/(skills\/|settingSources\.ts)/);
    expect(stripComments(source)).not.toMatch(moved);
  });
});
