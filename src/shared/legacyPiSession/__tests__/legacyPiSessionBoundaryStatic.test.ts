import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * dsh-rebase P1-9a / decision 030 rule 4 — the pi session decoder stays a pure,
 * host-neutral library.
 *
 * It outlives the runtime that wrote these files: the migration (P1-9b/c) runs
 * it in the DSH host, Main's read-only replay runs it in Electron, and P1-12
 * deletes `src/runtime`. So it may not reach into the runtime, either host, the
 * worker package, cordis or any pi / DSH package — and it does no IO at all:
 * callers read the bytes (read-only) and hand the text in. The source files a
 * migration reads must never be written, so no write API may even appear here.
 *
 * Checked on VALUE imports transitively, because that is what a host loads or
 * bundles; type-only imports are erased.
 */

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.dirname(LIBRARY);
const SRC = path.dirname(SHARED);
const REPO = path.dirname(SRC);
/** Path algebra and hashing; nothing that touches a file, a process or a thread. */
const NODE_BUILTINS = new Set(['node:crypto', 'node:path']);
/** `sessionFileChange.ts` (history review blocks) validates with zod. */
const PACKAGES = new Set(['zod']);
const FORBIDDEN =
  /(^|[\\/])(runtime|dsh-host|agent-host)([\\/]|$)|^cordis$|^@earendil-works\/|^@deepseek-ai\/|^(node:)?(fs|fs\/promises|child_process|worker_threads|net|http|https)$/;
const WRITE_APIS =
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|unlink|unlinkSync|rmSync|rmdir|rmdirSync|mkdir|mkdirSync|copyFile|copyFileSync|cp|cpSync|truncate|truncateSync|ftruncate|chmod|chown|utimes|symlink|openSync)\s*\(/;

interface ImportRef {
  specifier: string;
  typeOnly: boolean;
}

/** Block comments and whole-line `//` comments, so prose cannot look like code. */
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

describe('the shared legacy pi session library', () => {
  it('is found where the guard looks for it', () => {
    // A walker that silently found nothing would pass every check below.
    expect(libraryFiles.map((file) => path.basename(file)).sort()).toEqual([
      'codec.ts',
      'context.ts',
      'errors.ts',
      'legacy.ts',
      'timeline.ts',
      'tree.ts',
      'types.ts',
    ]);
  });

  it('imports only path and crypto from Node, and only src/shared from the repo', () => {
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
          if (!NODE_BUILTINS.has(specifier) && !PACKAGES.has(specifier))
            offenders.push(`${rel(file)} -> ${specifier}`);
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
    // The walk really left the library: the shared helpers it depends on count.
    expect([...seen].some((file) => !file.startsWith(LIBRARY))).toBe(true);
  });

  it('never names a write API, so it cannot write the files it reads', () => {
    const offenders = libraryFiles.flatMap((file) =>
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .flatMap((line, index) => (WRITE_APIS.test(line) ? [`${rel(file)}:${index + 1}`] : []))
    );
    expect(offenders).toEqual([]);
  });

  it('says where each module came from, for merging fixes from main', () => {
    const unlabelled = libraryFiles.filter(
      (file) =>
        !/^\/\/ (Moved from src\/(runtime|agent-host)\/\S+\.ts \(dsh-rebase P1-9a\)|New in dsh-rebase P1-9a|Vendored from @earendil-works\/pi-agent-core \S+ .*\(dsh-rebase P1-9a\))/.test(
          readFileSync(file, 'utf8')
        )
    );
    expect(unlabelled.map(rel)).toEqual([]);
  });

  it('keeps the upstream copyright and MIT notice on the vendored code', () => {
    const vendored = readFileSync(path.join(LIBRARY, 'context.ts'), 'utf8');
    expect(vendored).toContain('Copyright (c) 2025 Mario Zechner');
    expect(vendored).toContain('Permission is hereby granted, free of charge');
    expect(vendored).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(read('THIRD_PARTY_NOTICES.md')).toContain('src/shared/legacyPiSession/context.ts');
  });
});

/**
 * dsh-rebase P1-12 step 3 (decision 147) deleted the old locations, the
 * runtime's session plugin and the agent-host wrappers, so the "old locations
 * are thin" section went with them: a fix merged from main into one of those
 * files now conflicts as modify/delete (risk R4), and the banners above say
 * where it belongs.
 */
describe("Main's read-only replay", () => {
  it("Main's read-only replay no longer loads the runtime to decode a file", () => {
    const reader = stripComments(read('src/main/services/chat/SessionReplayReader.ts'));
    expect(reader).toMatch(/from '\.\.\/\.\.\/\.\.\/shared\/legacyPiSession\/codec'/);
    expect(reader).not.toMatch(/from '[^']*\/runtime\//);
    expect(reader).not.toMatch(/from '[^']*\/agent-host\//);
  });
});
