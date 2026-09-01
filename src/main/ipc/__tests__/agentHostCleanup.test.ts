import { beforeEach, describe, expect, it, vi } from 'vitest';

const disposeAll = vi.fn(async () => undefined);
const forceKillAllNow = vi.fn();

vi.mock('../../services/agent-host/WorkerManager', () => ({
  workerManager: { disposeAll, forceKillAllNow },
}));

describe('WorkerManager cleanup ownership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('awaits parallel pool disposal during normal app cleanup', async () => {
    const { cleanupWorkerManager } = await import('../workerManager');
    await cleanupWorkerManager();
    expect(disposeAll).toHaveBeenCalledWith('app-shutdown');
  });

  it('force-kills every Pi worker synchronously on signal/deadline cleanup', async () => {
    const { cleanupWorkerManagerSync } = await import('../workerManager');
    cleanupWorkerManagerSync();
    expect(forceKillAllNow).toHaveBeenCalledTimes(1);
  });
});
