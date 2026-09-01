import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsSync = vi.fn();
vi.mock('node:fs', () => ({ existsSync }));
vi.mock('../../agent-host/PiWorkerProcess', () => ({
  resolveCurrentPiWorkerEntryPath: () => '/resources/agent-host/worker.js',
}));

beforeEach(() => {
  existsSync.mockReset();
});

describe('PiRuntimeChecker', () => {
  it('reports only the bundled Pi worker entry', async () => {
    existsSync.mockReturnValueOnce(true);
    const { PiRuntimeChecker } = await import('../PiRuntimeChecker');
    const checker = new PiRuntimeChecker();
    await expect(checker.detect()).resolves.toEqual({ kind: 'ready', workerVersion: 'pi-worker' });
    expect(existsSync).toHaveBeenCalledWith('/resources/agent-host/worker.js');
  });

  it('reports unavailable and supports cache invalidation', async () => {
    existsSync.mockReturnValue(false);
    const { PiRuntimeChecker } = await import('../PiRuntimeChecker');
    const checker = new PiRuntimeChecker();
    await expect(checker.detect()).resolves.toEqual({ kind: 'unavailable' });
    checker.invalidate();
    await checker.detect();
    expect(existsSync).toHaveBeenCalledTimes(2);
  });
});
