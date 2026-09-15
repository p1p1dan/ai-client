/**
 * The environment knobs the runtime still has, and the one it no longer has.
 *
 * P6-5 deleted `AICLIENT_RUNTIME_BACKEND` along with the engine it selected.
 * `bootstrap.test.ts` proves that setting it changes nothing in a constructed
 * runtime; the second case here is the other half — that no file left in the
 * repository still reads or writes it. Both were needed, because the leftovers
 * audit core-host-15/16 found were not in the runtime at all: a JSDoc block in
 * `flags.ts` documenting a deleted export, and two GUI probe scripts that still
 * rewrote `dev.env` to set the variable, each with a comment admitting the
 * branch did nothing.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PI_AGENT_DIR_ENV,
  RUNTIME_AGENT_DIR_ENV,
  RUNTIME_TRACE_DIR_ENV,
  readRuntimeFlags,
} from '../flags.ts';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const RETIRED_SWITCH = 'AICLIENT_RUNTIME_BACKEND';

/**
 * The only files allowed to name the retired variable in live code.
 *
 * The first two plant it on purpose to prove it is inert — one through a real
 * worker process, one through `createRuntime`. A guard that banned the name
 * outright would delete the evidence that it is dead. The third is this file,
 * which has to spell the name in order to search for it.
 */
const PLANTS_IT_DELIBERATELY = [
  'src/agent-host/__tests__/workerEntryWiring.test.ts',
  'src/runtime/__tests__/bootstrap.test.ts',
  'src/runtime/__tests__/flags.test.ts',
];

const SEARCH_ROOTS = ['src', 'scripts'];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const entry = path.join(dir, name);
    if (statSync(entry).isDirectory()) sourceFiles(entry, found);
    else if (/\.(ts|tsx|mts|mjs|cjs|js)$/.test(name)) found.push(entry);
  }
  return found;
}

/** Comments may still explain the variable's history; code may not read it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('runtime flags', () => {
  it('prefers the dedicated catalog directory and treats blank as absent', () => {
    expect(
      readRuntimeFlags({
        [RUNTIME_AGENT_DIR_ENV]: '/tmp/fixture-agent',
        [PI_AGENT_DIR_ENV]: '/home/user/.pi',
      }).agentDir
    ).toBe('/tmp/fixture-agent');
    // The override exists so a smoke run can point at a fixture without
    // disturbing the variable a real worker inherits; when it is not set, the
    // managed directory Main exports is the answer.
    expect(readRuntimeFlags({ [PI_AGENT_DIR_ENV]: '/home/user/.pi' }).agentDir).toBe(
      '/home/user/.pi'
    );
    expect(
      readRuntimeFlags({ [RUNTIME_AGENT_DIR_ENV]: '   ', [PI_AGENT_DIR_ENV]: '/home/user/.pi' })
        .agentDir
    ).toBe('/home/user/.pi');
    expect(readRuntimeFlags({}).agentDir).toBeNull();
    expect(readRuntimeFlags({ [RUNTIME_TRACE_DIR_ENV]: '/tmp/traces' }).traceDir).toBe(
      '/tmp/traces'
    );
    // Not a knob any more: one engine, stamped into every trace as a constant.
    expect(readRuntimeFlags({ [RETIRED_SWITCH]: 'legacy' }).backend).toBe('native');
  });

  it('is read by nothing in src/ or scripts/ — the switch is gone, not hidden', () => {
    const offenders: string[] = [];
    for (const root of SEARCH_ROOTS) {
      for (const file of sourceFiles(path.join(repoRoot, root))) {
        const rel = path.relative(repoRoot, file).split(path.sep).join('/');
        if (PLANTS_IT_DELIBERATELY.includes(rel)) continue;
        if (stripComments(readFileSync(file, 'utf8')).includes(RETIRED_SWITCH)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
    // Guards the walk itself: an empty result means nothing only if the walk
    // saw the tree and the allow-listed files really do still name it.
    expect(sourceFiles(path.join(repoRoot, 'src')).length).toBeGreaterThan(200);
    for (const rel of PLANTS_IT_DELIBERATELY) {
      expect(stripComments(readFileSync(path.join(repoRoot, rel), 'utf8'))).toContain(
        RETIRED_SWITCH
      );
    }
  });
});
