import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const cleanupSource = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
const slotSource = fs.readFileSync(
  new URL('../../services/agent-host/WorkerSlot.ts', import.meta.url),
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
    const workerCleanup = cleanupSource.indexOf("safeRun(() => cleanupAgentHost(), 'agentHost')");
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
    expect(cleanupSource).toContain('cleanupAgentHostSync();');
  });
});
