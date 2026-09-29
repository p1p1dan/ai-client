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
const REPO = path.resolve(SRC, '..');
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
    // P1-3a: a chat session is a channel on the app's one shared DSH host.
    expect(source).toContain("from './DshHostSupervisor'");
    expect(source).toContain('dshHostSupervisor.openChannel(');
    for (const banned of [
      'forkPiWorkerProcess',
      'PiWorkerProcess',
      'forkDshHost',
      'DshHostProcess',
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
   * host per request instead (P1-5, decision 034). Since P1-15 (decision 125)
   * one-shot completions run on the same host and carry none either; the
   * native utility service that still assembles one is unreferenced until
   * P1-12 deletes it (`oneShotCompletionsStatic.test.ts`).
   * Comments are stripped: both files explain the ban by naming the field.
   */
  it('chat bootstraps and one-shot completions carry no model catalog', () => {
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
    const completions = code('DshCompletionService.ts');
    for (const banned of ['modelCatalog', 'resolveNativeModelCatalog', 'WorkerModelCatalog']) {
      expect(completions, banned).not.toContain(banned);
    }
  });

  it('WorkerManager spawns through exactly four paths and never binds a session to pi', () => {
    const source = read(path.join(AGENT_HOST, 'WorkerManager.ts'));
    // create, cold resume, fork target, crash restart.
    expect(source.match(/this\.spawnForEntry\(/g)).toHaveLength(4);
    expect(source).not.toContain('PI_AGENT');
    expect(source.match(/agent: DSH_AGENT/g)?.length).toBeGreaterThanOrEqual(7);
  });

  /**
   * P1-3a (decision 019): one shared host with one bridge. The per-session host
   * launch, its environment-borne generation and bridge switch, and the P0-6
   * prototype bridge are gone from the tree and from the scripts that drive
   * the host.
   */
  it('leaves no trace of the per-session host or the prototype bridge', () => {
    const banned = [
      'forkDshHost',
      'bridgeGeneration',
      'AICLIENT_DSH_BRIDGE',
      'AICLIENT_DSH_SHARED_BRIDGE',
      'aiclient-shared-bridge',
      'shared-bridge',
      'sharedPlugin',
    ];
    const files = [
      ...codeFiles(SRC),
      ...codeFiles(path.join(REPO, 'scripts')),
      path.join(REPO, '.github', 'workflows', 'build.yml'),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = read(file);
      for (const name of banned) {
        if (text.includes(name)) offenders.push(`${path.relative(REPO, file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
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
