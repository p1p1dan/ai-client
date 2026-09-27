import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
