import { beforeEach, describe, expect, it, vi } from 'vitest';

const disposeAll = vi.fn(async () => undefined);
const forceKillAllNow = vi.fn();
const disposeUtilities = vi.fn(async () => undefined);
const forceKillUtilities = vi.fn();

vi.mock('../../services/agent-host/PiUtilityService', () => ({
  piUtilityService: { disposeAll: disposeUtilities, forceKillAllNow: forceKillUtilities },
}));

vi.mock('../../services/agent-host/WorkerManager', () => ({
  workerManager: { disposeAll, forceKillAllNow },
}));

const wipeScratchWorkspaces = vi.fn(async () => undefined);

vi.mock('../../services/agent-host/ScratchWorkspaceService', () => ({
  scratchWorkspaceService: { wipeAll: wipeScratchWorkspaces },
}));

describe('WorkerManager cleanup ownership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('awaits parallel pool disposal during normal app cleanup', async () => {
    const { cleanupWorkerManager } = await import('../workerManager');
    await cleanupWorkerManager();
    expect(disposeAll).toHaveBeenCalledWith('app-shutdown');
    expect(disposeUtilities).toHaveBeenCalledTimes(1);
  });

  // U05-a — the app-exit half of the scratch-directory lifetime. Its sibling
  // (the startup sweep that covers a crash) is the same call, made from
  // `registerIpcHandlers`.
  it('wipes the unbound-chat directories, but only after the workers are gone', async () => {
    // Order is the point: a worker still running has its scratch directory as
    // its cwd, and removing it underneath one is EBUSY on Windows and a
    // baffling tool failure everywhere else.
    const order: string[] = [];
    disposeAll.mockImplementationOnce(async () => {
      order.push('workers');
    });
    wipeScratchWorkspaces.mockImplementationOnce(async () => {
      order.push('scratch');
    });

    const { cleanupWorkerManager } = await import('../workerManager');
    await cleanupWorkerManager();

    expect(order).toEqual(['workers', 'scratch']);
  });

  it('runs the same wipe at startup, to clean up after a crash', async () => {
    const { sweepScratchWorkspacesOnStartup } = await import('../workerManager');
    sweepScratchWorkspacesOnStartup();
    expect(wipeScratchWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('force-kills every Pi worker synchronously on signal/deadline cleanup', async () => {
    const { cleanupWorkerManagerSync } = await import('../workerManager');
    cleanupWorkerManagerSync();
    expect(forceKillAllNow).toHaveBeenCalledTimes(1);
    expect(forceKillUtilities).toHaveBeenCalledTimes(1);
  });
});
