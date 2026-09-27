import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const cleanupSource = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
const slotSource = fs.readFileSync(
  new URL('../../services/agent-host/WorkerSlot.ts', import.meta.url),
  'utf8'
);
const supervisorSource = fs.readFileSync(
  new URL('../../services/agent-host/DshHostSupervisor.ts', import.meta.url),
  'utf8'
);

function number(source: string, name: string): number {
  const match = source.match(new RegExp(`const ${name} = ([0-9_]+)`));
  if (!match) throw new Error(`missing ${name}`);
  return Number(match[1].replaceAll('_', ''));
}

describe('Pi worker app-cleanup budget', () => {
  it('starts worker cleanup inside the bounded parallel cleanup set', () => {
    const allSettled = cleanupSource.indexOf('Promise.allSettled([');
    const workerCleanup = cleanupSource.indexOf(
      "safeRun(() => cleanupWorkerManager(), 'workerManager')"
    );
    expect(allSettled).toBeGreaterThan(-1);
    expect(workerCleanup).toBeGreaterThan(allSettled);
  });

  it('allows the complete dispose-ACK + exit-confirmation budget before force exit', () => {
    const cleanupBudget = number(cleanupSource, 'TOTAL_ASYNC_TIMEOUT');
    const forceExitBudget = number(mainSource, 'FORCE_EXIT_TIMEOUT_MS');
    const disposeBudget = number(slotSource, 'DEFAULT_DISPOSE_TIMEOUT_MS');
    const exitBudget = number(slotSource, 'DEFAULT_EXIT_TIMEOUT_MS');
    expect(cleanupBudget).toBeGreaterThan(disposeBudget + exitBudget);
    expect(cleanupBudget).toBeLessThan(forceExitBudget);
    expect(cleanupSource).toContain('cleanupWorkerManagerSync();');
  });

  // dsh-rebase decision 025: at quit the shared DSH host is asked to stop once
  // and SIGKILLed after its graceful budget; the deadline backstops the rest.
  it('lets the shared DSH host stop gracefully before the deadline kills it', () => {
    const cleanupBudget = number(cleanupSource, 'TOTAL_ASYNC_TIMEOUT');
    const graceful = supervisorSource.match(/gracefulStopMs: ([0-9_]+)/)?.[1];
    expect(graceful).toBeDefined();
    expect(cleanupBudget).toBeGreaterThan(Number(graceful?.replaceAll('_', '')));
  });
});
