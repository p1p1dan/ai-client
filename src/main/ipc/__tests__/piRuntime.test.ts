import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const detect = vi.fn();

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
}));
vi.mock('../../services/cli/PiRuntimeChecker', () => ({ piRuntimeChecker: { detect } }));

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  vi.clearAllMocks();
  const { registerPiRuntimeHandlers } = await import('../piRuntime');
  registerPiRuntimeHandlers();
});

describe('pi:runtime:check', () => {
  it('returns the Pi worker status', async () => {
    detect.mockResolvedValue({ kind: 'ready', workerVersion: 'pi-worker' });
    const handler = handlers.get(IPC_CHANNELS.PI_RUNTIME_CHECK);
    await expect(handler?.({}, true)).resolves.toEqual({
      kind: 'ready',
      workerVersion: 'pi-worker',
    });
    expect(detect).toHaveBeenCalledWith(true);
  });

  it('turns detection failures into an explicit status', async () => {
    detect.mockRejectedValue(new Error('missing resource'));
    const handler = handlers.get(IPC_CHANNELS.PI_RUNTIME_CHECK);
    await expect(handler?.({}, false)).resolves.toEqual({
      kind: 'detection-failed',
      error: 'missing resource',
    });
  });
});
