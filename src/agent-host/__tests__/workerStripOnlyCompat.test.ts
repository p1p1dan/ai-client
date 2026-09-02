import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Pi worker runs as BUNDLED JavaScript when packaged, but as raw TypeScript
 * in dev — `PiWorkerProcess.resolvePiWorkerEntryPath` returns
 * `src/agent-host/worker.ts` and forks it with `--experimental-strip-types`.
 * Node's strip-only mode erases types and does nothing else, so two ordinary
 * TypeScript habits break it:
 *
 *  - constructor parameter properties (`constructor(private readonly x)`),
 *    which need emit rather than erasure;
 *  - relative VALUE imports without a file extension, which Node's ESM resolver
 *    will not search for.
 *
 * Both landed unnoticed because every probe and test exercised the bundle: from
 * T34 until T37-c, `pnpm dev` could not start a single Pi session, and the only
 * symptom was `Worker exited (code=1)` with the reason discarded. This test
 * walks the worker's real import graph and fails on either mistake, so the dev
 * path cannot rot again while the packaged path stays green.
 */

const repoRoot = path.resolve(__dirname, '../../..');
const workerEntry = path.join(repoRoot, 'src/agent-host/worker.ts');

/** Resolve a relative specifier the way the walker needs it, or null. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface GraphProblem {
  file: string;
  detail: string;
}

function walkWorkerGraph(): { files: string[]; extensionless: GraphProblem[] } {
  const seen = new Set<string>();
  const extensionless: GraphProblem[] = [];
  // `import`/`export ... from '...'`; the clause is captured so type-only
  // statements (erased before Node resolves anything) can be skipped.
  const statement = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)from\s+'([^']+)'/g;

  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    statement.lastIndex = 0;
    let match = statement.exec(source);
    while (match) {
      const [, clause, specifier] = match;
      if (specifier.startsWith('.')) {
        const typeOnly = /^\s*type[\s{]/.test(clause);
        const suffixed = specifier.endsWith('.ts') || specifier.endsWith('.js');
        if (!typeOnly && !suffixed) {
          extensionless.push({
            file: path.relative(repoRoot, file),
            detail: `value import '${specifier}' has no file extension`,
          });
        }
        const target = resolveRelative(file, specifier);
        if (target) visit(target);
      }
      match = statement.exec(source);
    }
  };

  visit(workerEntry);
  return { files: [...seen], extensionless };
}

describe('Pi worker source is loadable under Node strip-only type removal', () => {
  const { files, extensionless } = walkWorkerGraph();

  it('reaches the worker entry and its dependencies', () => {
    expect(files).toContain(workerEntry);
    expect(files.length).toBeGreaterThan(1);
  });

  it('uses no TypeScript syntax that strip-only mode rejects', () => {
    const failures: GraphProblem[] = [];
    for (const file of files) {
      try {
        stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' });
      } catch (error) {
        failures.push({
          file: path.relative(repoRoot, file),
          detail: String((error as Error).message).split('\n')[0],
        });
      }
    }
    expect(failures).toEqual([]);
  });

  it('spells out the extension on every relative value import', () => {
    expect(extensionless).toEqual([]);
  });
});
