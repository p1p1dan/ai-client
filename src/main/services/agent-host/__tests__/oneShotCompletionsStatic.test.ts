import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../../renderer/components/chat/__tests__/stripComments';

/**
 * dsh-rebase P1-15 (decisions 039 and 125) — the commit message, the branch
 * name and the code review run on the shared DSH host, and nothing in Main
 * reaches the native utility worker any more.
 *
 * `PiUtilityService.ts` was deleted in P1-12 step 1 (decision 147); these
 * guards keep it from coming back under any name they know. The
 * behaviour tests (`src/main/services/ai/__tests__`, `DshCompletionService`,
 * the shared-host integration test) prove the new path works; this pins that
 * the old one cannot creep back as an import.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(HERE, '../../..');
const AGENT_HOST = path.resolve(HERE, '..');
const AI = path.join(MAIN, 'services', 'ai');

function code(file: string): string {
  return stripComments(readFileSync(file, 'utf8'), file);
}

/** Shipped Main code: everything under src/main but tests. */
function mainFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) mainFiles(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const ENTRIES = ['commit-message.ts', 'branch-name.ts', 'code-review.ts'];

describe('one-shot completions run on the DSH host (P1-15)', () => {
  it.each(ENTRIES)('%s completes through DshCompletionService, not PiUtilityService', (name) => {
    const raw = readFileSync(path.join(AI, name), 'utf8');
    // Not even in a comment: the old service is not a reference for these files.
    for (const banned of ['PiUtilityService', 'piUtilityService', 'utility.start']) {
      expect(raw, banned).not.toContain(banned);
    }
    const source = code(path.join(AI, name));
    // Whitespace-tolerant: the formatter wraps this import.
    expect(source).toMatch(
      /import \{\s*type DshCompletionService,\s*dshCompletionService,?\s*\} from '\.\.\/agent-host\/DshCompletionService';/
    );
    expect(source).toMatch(
      /service: Pick<DshCompletionService, '(complete|cancel)'> = dshCompletionService/
    );
  });

  it('each entry names its own purpose', () => {
    expect(code(path.join(AI, 'commit-message.ts'))).toContain("purpose: 'commit-message',");
    expect(code(path.join(AI, 'branch-name.ts'))).toContain("purpose: 'branch-name',");
    expect(code(path.join(AI, 'code-review.ts'))).toContain("purpose: 'code-review',");
  });

  it('no shipped Main code reaches PiUtilityService, which P1-12 deleted', () => {
    expect(existsSync(path.join(AGENT_HOST, 'PiUtilityService.ts'))).toBe(false);
    const offenders = mainFiles(MAIN)
      .filter((file) => /PiUtilityService|piUtilityService/.test(code(file)))
      .map((file) => path.relative(MAIN, file));
    expect(offenders).toEqual([]);
  });

  it('the completion service starts no process and hands over no catalog or key', () => {
    const service = code(path.join(AGENT_HOST, 'DshCompletionService.ts'));
    expect(service).toContain("from './DshHostSupervisor'");
    expect(service).toContain('this.host.startCompletion(');
    for (const banned of [
      'forkPiWorkerProcess',
      'PiWorkerProcess',
      'WorkerSlot',
      'resolveNativeModelCatalog',
      'modelCatalog',
      'utility.start',
      'child_process',
      'utilityProcess',
      'spawn(',
      'fork(',
    ]) {
      expect(service, banned).not.toContain(banned);
    }
  });

  it('logout and quit settle the completions through the same service', () => {
    const cleanup = code(path.join(MAIN, 'ipc', 'workerManager.ts'));
    expect(cleanup).toContain('dshCompletionService.disposeAll()');
    expect(cleanup).toContain('dshCompletionService.forceKillAllNow();');
    const logout = code(path.join(MAIN, 'ipc', 'onboarding.ts'));
    expect(logout).toContain('await dshCompletionService.invalidateAll();');
  });

  it('the supervisor opens no channel for a completion: it is a host control', () => {
    const supervisor = code(path.join(AGENT_HOST, 'DshHostSupervisor.ts'));
    const start = supervisor.indexOf('  startCompletion(');
    const end = supervisor.indexOf('\n  restart(', start);
    expect(start).toBeGreaterThan(0);
    const body = supervisor.slice(start, end);
    expect(body).toContain("host: 'complete',");
    expect(body).toContain("host: 'complete-cancel'");
    expect(body).not.toContain('openChannel');
    expect(body).not.toContain('DshChannelTransport');
  });
});
