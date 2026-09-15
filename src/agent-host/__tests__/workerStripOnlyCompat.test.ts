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

function walkGraphFrom(entry: string): { files: string[]; extensionless: GraphProblem[] } {
  const seen = new Set<string>();
  const extensionless: GraphProblem[] = [];
  // `import`/`export ... from '...'`; the clause is captured so type-only
  // statements (erased before Node resolves anything) can be skipped.
  const statement = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)from\s+'([^']+)'/g;
  /**
   * `import('...')` with a literal specifier — the form `worker.ts` uses to
   * reach the runtime (cutover, T028).
   *
   * Without this the walk stopped at the 16 files the entry imports statically
   * and never entered `src/runtime/`, so the whole self-owned runtime — every
   * file the dev path really does load under strip-only — was outside a guard
   * whose entire purpose is the dev path. A dynamic import is never type-only,
   * hence the empty clause.
   */
  const dynamic = /\bimport\s*\(\s*'([^']+)'\s*\)/g;

  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    const edges: { clause: string; specifier: string }[] = [];
    statement.lastIndex = 0;
    let statementMatch = statement.exec(source);
    while (statementMatch) {
      edges.push({
        clause: statementMatch[1] as string,
        specifier: statementMatch[2] as string,
      });
      statementMatch = statement.exec(source);
    }
    dynamic.lastIndex = 0;
    let dynamicMatch = dynamic.exec(source);
    while (dynamicMatch) {
      edges.push({ clause: '', specifier: dynamicMatch[1] as string });
      dynamicMatch = dynamic.exec(source);
    }
    for (const { clause, specifier } of edges) {
      if (specifier.startsWith('.')) {
        const typeOnly = /^\s*type[\s{]/.test(clause);
        // A real ESM extension. The rule exists for the CONVERSE (a bare
        // '`./dog`' that Node would have to search for), not to outlaw
        // `.mjs`/`.cjs`, which Node's ESM resolver resolves as-is. Loosening
        // this to `.mjs` is what let R03's `bundledPlugins.mjs` live alongside
        // the `.ts` files it imports.
        const suffixed = /\.(ts|js|mjs|cjs)$/.test(specifier);
        if (!typeOnly && !suffixed) {
          extensionless.push({
            file: path.relative(repoRoot, file),
            detail: `value import '${specifier}' has no file extension`,
          });
        }
        const target = resolveRelative(file, specifier);
        if (target) visit(target);
      }
    }
  };

  visit(entry);
  return { files: [...seen], extensionless };
}

describe('Pi worker source is loadable under Node strip-only type removal', () => {
  const { files, extensionless } = walkGraphFrom(workerEntry);

  it('reaches the worker entry and its dependencies', () => {
    expect(files).toContain(workerEntry);
    expect(files.length).toBeGreaterThan(1);
  });

  it('follows the dynamic import into the self-owned runtime', () => {
    // The coverage this guard silently lacked until T028. `worker.ts` reaches
    // the runtime only through `import('../runtime/...')`, so a walker that
    // reads static statements alone sees 16 files — all of `src/agent-host/` —
    // and calls the dev path checked. These numbers are the difference: 99
    // files today, 71 of them the runtime the dev path actually loads.
    const runtimeFiles = files.filter((file) =>
      path.relative(repoRoot, file).startsWith(`src${path.sep}runtime${path.sep}`)
    );
    expect(runtimeFiles.length).toBeGreaterThan(50);
    expect(files).toContain(path.join(repoRoot, 'src/runtime/worker/nativeWorkerRuntime.ts'));
    expect(files).toContain(path.join(repoRoot, 'src/runtime/bootstrap.ts'));
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

  it('resolves a real ESM extension — `.mjs` is not a missing extension', () => {
    // A naive value-import check that only accepts `.ts`/`.js` flags a `.mjs`
    // specifier, yet Node — including `--experimental-strip-types` in dev —
    // resolves it without any search. This case pins the distinction: the rule
    // bans bare names, not ESM file types.
    //
    // Walked from a second root as well. The main graph now does reach the
    // `.mjs` importer (T028 taught the walker to follow dynamic imports), but
    // starting from the policy loader keeps the distinction pinned at its
    // source: it is the file dev really does load under strip-only and really
    // does import a `.mjs`. T025 moved this root here from
    // `bundledFeaturePlugins.ts`, which was deleted because nothing called it.
    const policyLoader = path.join(repoRoot, 'src/runtime/plugins/permissions/policy.ts');
    expect(fs.existsSync(policyLoader)).toBe(true);
    expect(fs.readFileSync(policyLoader, 'utf8')).toContain("permissionPolicy.mjs'");
    const { extensionless: policyProblems } = walkGraphFrom(policyLoader);
    expect(policyProblems.some((p) => p.detail.includes('.mjs'))).toBe(false);
    expect(extensionless.some((p) => p.detail.includes('.mjs'))).toBe(false);
  });
});
