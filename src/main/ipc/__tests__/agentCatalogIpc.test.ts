import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const readPiModelCatalog = vi.fn(() => ({
  models: [{ id: 'glm/glm-5', label: 'GLM 5' }],
  source: 'local',
  stale: false,
  fetchedAt: 1,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
}));
vi.mock('../../services/piModelConfig', () => ({ readPiModelCatalog }));

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  vi.clearAllMocks();
  const { registerAgentCatalogHandlers } = await import('../agentCatalog');
  registerAgentCatalogHandlers();
});

function invoke(payload?: unknown): Promise<unknown> {
  const handler = handlers.get(IPC_CHANNELS.CHAT_LIST_PI_MODELS);
  if (!handler) throw new Error('chat:listPiModels was never registered');
  return Promise.resolve(handler({}, payload));
}

describe('chat:listPiModels', () => {
  it('returns the Pi managed/local catalog without an agent request axis', async () => {
    await expect(invoke({ force: true })).resolves.toEqual({
      models: [{ id: 'glm/glm-5', label: 'GLM 5' }],
      source: 'local',
      stale: false,
      fetchedAt: 1,
    });
    expect(readPiModelCatalog).toHaveBeenCalledTimes(1);
  });
});
