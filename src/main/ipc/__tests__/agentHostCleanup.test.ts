import { beforeEach, describe, expect, it, vi } from 'vitest';

const shutdown = vi.fn(async () => undefined);
const disposeAll = vi.fn(async () => undefined);
const forceKillAllNow = vi.fn();

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../services/agent-host/AgentHostManager', () => ({
  agentHostManager: { shutdown, getStatus: vi.fn() },
  getBundledNodeRuntimePath: vi.fn(),
}));
vi.mock('../../services/agent-host/PiSingleSlotRuntime', () => ({
  piSingleSlotRuntime: { disposeAll, forceKillAllNow },
}));
vi.mock('../../services/agent-host/NodeRuntimeResolver', () => ({
  resolveNode24Runtime: vi.fn(),
}));

describe('agent-host cleanup ownership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('awaits Pi WorkerSlot disposal during normal app cleanup', async () => {
    const { cleanupAgentHost } = await import('../agentHost');
    await cleanupAgentHost();
    expect(disposeAll).toHaveBeenCalledWith('app-shutdown');
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('force-kills Pi workers synchronously on signal/deadline cleanup', async () => {
    const { cleanupAgentHostSync } = await import('../agentHost');
    cleanupAgentHostSync();
    expect(forceKillAllNow).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
