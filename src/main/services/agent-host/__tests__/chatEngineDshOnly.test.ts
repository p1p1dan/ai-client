import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../../renderer/components/chat/__tests__/stripComments';

/**
 * dsh-rebase P1-1 (decisions 004 and 009) — chat sessions run on DSH only.
 *
 * Behaviour tests prove the default path spawns the DSH host; these pin the
 * shape that keeps it that way. A second engine creeps back as an import, an
 * `isPackaged` gate or a fifth spawn site long before any behaviour test sees
 * it, and the P0-3 dev switch must not survive anywhere in the tree.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../../..');
const AGENT_HOST = path.resolve(HERE, '..');

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Shipped code and config; tests may name the retired switch to prove it is ignored. */
function codeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) codeFiles(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs|yml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('chat engine is DSH only (P1-1)', () => {
  it('createPiWorkerSlot has no native fork, no dev switch and no packaging gate', () => {
    const source = read(path.join(AGENT_HOST, 'createPiWorkerSlot.ts'));
    expect(source).toContain("from './DshHostProcess'");
    expect(source).toContain('forkDshHost(');
    for (const banned of [
      'forkPiWorkerProcess',
      'PiWorkerProcess',
      'AICLIENT_DEV_ENGINE',
      'isPackaged',
    ]) {
      expect(source, banned).not.toContain(banned);
    }
  });

  /**
   * The chat bootstrap carries no model catalog: its `auth` half is plaintext
   * provider keys, the DSH host never reads it, and the host's RPC server keeps
   * the whole bootstrap payload for the life of the session. Keys reach the
   * host per request instead (P1-5, decision 034). One-shot completions still
   * hand a catalog to the native utility worker, which is untouched here.
   * Comments are stripped: both files explain the ban by naming the field.
   */
  it('chat bootstraps carry no model catalog; the one-shot utility path keeps its own', () => {
    const code = (name: string) => {
      const file = path.join(AGENT_HOST, name);
      return stripComments(read(file), file);
    };
    const manager = code('WorkerManager.ts');
    for (const banned of [
      'modelCatalog',
      'readModelCatalog',
      'resolveNativeModelCatalog',
      'WorkerModelCatalog',
    ]) {
      expect(manager, banned).not.toContain(banned);
    }
    const slot = code('createPiWorkerSlot.ts');
    expect(slot).toContain("Omit<WorkerBootstrapPayload, 'modelCatalog'>");
    expect(slot).not.toContain('options.modelCatalog');
    expect(slot).not.toMatch(/\bmodelCatalog\s*:/);
    const utility = code('PiUtilityService.ts');
    expect(utility).toContain('readModelCatalog: () => resolveNativeModelCatalog()');
  });

  it('WorkerManager spawns through exactly four paths and never binds a session to pi', () => {
    const source = read(path.join(AGENT_HOST, 'WorkerManager.ts'));
    // create, cold resume, fork target, crash restart.
    expect(source.match(/this\.spawnForEntry\(/g)).toHaveLength(4);
    expect(source).not.toContain('PI_AGENT');
    expect(source.match(/agent: DSH_AGENT/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it('leaves no trace of the P0-3 dev engine switch in the source tree', () => {
    const banned = [
      'devDshEngine',
      'isDevDshEngineSelected',
      'forkDevDshHost',
      'buildDevDshHostLaunch',
      'AICLIENT_DEV_ENGINE',
      'dsh-home-dev',
    ];
    const offenders: string[] = [];
    for (const file of codeFiles(SRC)) {
      const text = read(file);
      for (const name of banned) {
        if (text.includes(name)) offenders.push(`${path.relative(SRC, file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
