import { IPC_CHANNELS } from '@shared/types';
import type { UserProviderView } from '@shared/userProviders';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
}));

const upsert = vi.fn(
  async (_draft: unknown): Promise<UserProviderView> => ({
    id: 'p1',
    name: 'My',
    baseUrl: 'https://api.example.com/v1',
    api: 'openai-completions',
    hasApiKey: true,
    models: [],
    enabled: true,
    createdAt: '',
  })
);

vi.mock('../../services/userProviders', () => ({
  getUserProviderService: () => ({ upsert }),
}));

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  vi.clearAllMocks();
  const { registerUserProviderHandlers } = await import('../userProviders');
  registerUserProviderHandlers();
});

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`${channel} was never registered`);
  // `ipcMain.handle` turns a synchronous throw into a rejected promise;
  // mirror that so `rejects` assertions hold.
  return new Promise((resolve, reject) => {
    try {
      resolve(handler({}, payload));
    } catch (error) {
      reject(error);
    }
  });
}

const validPayload = {
  name: 'My',
  baseUrl: 'https://api.example.com/v1',
  api: 'openai-completions',
  apiKey: 'k',
  models: ['m1'],
};

describe('userProviders:upsert — modelMeta IPC boundary (P1)', () => {
  it('passes per-model metadata through the IPC boundary', async () => {
    await invoke(IPC_CHANNELS.USER_PROVIDERS_UPSERT, {
      ...validPayload,
      modelMeta: {
        m1: { contextWindow: 200000, maxTokens: 8192, reasoning: true, input: ['text', 'image'] },
      },
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        modelMeta: {
          m1: { contextWindow: 200000, maxTokens: 8192, reasoning: true, input: ['text', 'image'] },
        },
      })
    );
  });

  it.each<[unknown, string]>([
    [{ m1: { contextWindow: 'big' } }, 'contextWindow'],
    [{ m1: { contextWindow: -1 } }, 'contextWindow'],
    [{ m1: { contextWindow: 1.5 } }, 'contextWindow'],
    [{ m1: { maxTokens: 1.5 } }, 'maxTokens'],
    [{ m1: { reasoning: 'yes' } }, 'reasoning'],
    [{ m1: { input: ['pdf'] } }, 'input'],
    [{ m1: 'nope' }, 'modelMeta[m1]'],
  ])('rejects malformed modelMeta: %o', async (modelMeta, field) => {
    await expect(
      invoke(IPC_CHANNELS.USER_PROVIDERS_UPSERT, { ...validPayload, modelMeta })
    ).rejects.toThrow(
      `modelMeta${field.startsWith('modelMeta') ? field.slice('modelMeta'.length) : `[m1].${field}`}`
    );
  });
});
