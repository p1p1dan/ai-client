/**
 * P6-2 — what a worker LOADS, not what it calls.
 *
 * The worker entry static-imports the RPC server, so anything that module graph
 * pulls in is loaded by every session — which is how a native worker ended up
 * loading the whole pi-coding-agent package for a one-shot completion feature
 * most sessions never use. P6-5 then retired the legacy engine outright, so the
 * rule is now simply: nothing pi-shaped may be reachable from the entry without
 * a dynamic import.
 *
 * This walks the graph rather than grepping the entry file, because the import
 * that breaks it will be three modules deep. The walk asserts its own reach
 * first: a scanner that silently visits nothing would otherwise "prove" the
 * boundary holds.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const workerEntry = path.join(repoRoot, 'src/agent-host/worker.ts');

/** Comments hide import-looking text; strip them before matching. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Static specifiers only.
 *
 * `import type` is erased before the module ever runs, and `await import(...)`
 * is the deliberate escape hatch this boundary is built on — counting either
 * would make the rule impossible to satisfy rather than strict.
 */
function staticSpecifiers(source: string): string[] {
  const text = withoutComments(source);
  const found: string[] = [];
  const fromClause = /(?:^|[\s;}])(?:import|export)\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (let m = fromClause.exec(text); m; m = fromClause.exec(text)) {
    const clause = (m[1] ?? '').trim();
    if (clause === 'type' || clause.startsWith('type ')) continue;
    found.push(m[2] as string);
  }
  const sideEffect = /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;
  for (let m = sideEffect.exec(text); m; m = sideEffect.exec(text)) found.push(m[1] as string);
  return found;
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  if (existsSync(base) && !base.endsWith('/')) return base;
  for (const candidate of ['.ts', '.mjs', '.js', '/index.ts']) {
    if (existsSync(`${base}${candidate}`)) return `${base}${candidate}`;
  }
  return base;
}

function walkStaticGraph(entry: string): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (files.has(file) || !existsSync(file)) continue;
    files.add(file);
    for (const specifier of staticSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) queue.push(resolveRelative(file, specifier));
      else if (!specifier.startsWith('node:') && !packages.has(specifier))
        packages.set(specifier, file);
    }
  }
  return { files, packages };
}

describe('P6-2 native worker dependency boundary', () => {
  const graph = walkStaticGraph(workerEntry);
  const relative = (file: string) => path.relative(repoRoot, file);

  it('reaches the modules it is supposed to be checking', () => {
    // A scanner that silently visits nothing would "prove" the rule below.
    // P6-5 deleted the three legacy modules this used to name; the dispatcher
    // and its error type are what the worker entry statically pulls in now.
    const reached = [...graph.files].map(relative);
    expect(reached).toContain('src/agent-host/piWorkerRpcServer.ts');
    expect(reached).toContain('src/agent-host/piWorkerErrors.ts');
    // 10 files today; it was 32 before P6-5 deleted the legacy engine. The
    // floor is here to catch a walker that stopped walking, not to pin a count.
    expect(graph.files.size).toBeGreaterThan(5);
  });

  it('loads no pi package at all', () => {
    const offenders = [...graph.packages.entries()]
      .filter(([specifier]) => specifier.startsWith('@earendil-works/'))
      .map(([specifier, importer]) => `${specifier} <- ${relative(importer)}`);
    expect(offenders).toEqual([]);
  });
});
