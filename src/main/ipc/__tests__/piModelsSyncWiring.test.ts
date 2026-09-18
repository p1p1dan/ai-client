import type { PiModelSyncFailure } from '@shared/piModelConfig';
import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two halves of "a user can see the model sync failed, and can do
 * something about it", on the channel the renderer actually calls.
 *
 * No new channel was added for either: `piModels:getStatus` already answered
 * the settings page, and `piModels:sync` was already the manual sync. What is
 * pinned here is that the status reply now carries the recorded failure (the
 * card above the composer reads it from there), and that the retry really does
 * force — without `force` the ten-minute freshness window can answer "fine"
 * without going near the network, which is a Retry button that lies.
 */

type Handler = (event: unknown, payload?: unknown) => unknown;
const handlers = new Map<string, Handler>();

const lastFailure: { value: PiModelSyncFailure | null } = { value: null };
const managed = { value: true };
const syncResult = { ok: true };

const syncManagedPiModels = vi.fn(async () => ({
  ok: syncResult.ok,
  source: 'remote' as const,
  endpointUrl: 'https://onboarding.example.com/api/v1/models-config',
  agentDir: '/tmp/agent',
  modelCount: 3,
  providerCount: 1,
  lastAttemptAt: 1,
  syncedAt: 1,
}));
const invalidateAll = vi.fn(async () => undefined);

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) },
  shell: { openExternal: vi.fn(async () => undefined) },
}));

vi.mock('../../services/agent-host/WorkerManager', () => ({
  workerManager: { invalidateAll },
}));

vi.mock('../../services/auth/credentialMode', () => ({
  resolveManagedCredentialsEnabled: () => managed.value,
}));

vi.mock('../../services/piModelConfig', () => ({
  getManagedPiSyncFailure: () => lastFailure.value,
  getPiModelManagementUrl: () => 'https://onboarding.example.com/api/v1/models-config',
  getPiModelSyncState: () => ({
    source: 'unavailable' as const,
    endpointUrl: 'https://onboarding.example.com/api/v1/models-config',
    agentDir: '/tmp/agent',
    modelCount: 0,
    providerCount: 0,
    lastAttemptAt: 1,
    syncedAt: null,
  }),
  setPiModelManagementUrl: (url: string) => url,
  syncManagedPiModels,
}));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  handlers.clear();
  lastFailure.value = null;
  managed.value = true;
  syncResult.ok = true;
  const { registerPiModelHandlers } = await import('../piModels');
  registerPiModelHandlers();
});

function handler(channel: string): Handler {
  const registered = handlers.get(channel);
  if (!registered) throw new Error(`Missing handler: ${channel}`);
  return registered;
}

describe('Pi model status and manual sync IPC', () => {
  it('hands the renderer the failure the login-time sync recorded', async () => {
    lastFailure.value = {
      kind: 'credentials-missing',
      error: 'Managed credentials are unavailable',
      at: 1_700_000_000_000,
    };

    const status = await handler(IPC_CHANNELS.PI_MODELS_GET_STATUS)({});

    expect(status).toMatchObject({ managed: true, lastFailure: lastFailure.value });
  });

  it('reports no failure once the sync has worked', async () => {
    const status = (await handler(IPC_CHANNELS.PI_MODELS_GET_STATUS)({})) as {
      lastFailure: unknown;
    };
    expect(status.lastFailure).toBeNull();
  });

  it('forces the sync the Retry button triggers, with no endpoint of its own', async () => {
    // The card sends no payload at all — it is retrying the endpoint already in
    // use, not editing it, so nothing here may rewrite the stored URL.
    await handler(IPC_CHANNELS.PI_MODELS_SYNC)({}, undefined);

    expect(syncManagedPiModels).toHaveBeenCalledWith(
      'https://onboarding.example.com/api/v1/models-config',
      { force: true }
    );
    // A catalog that changed under a running worker is the reason this exists.
    expect(invalidateAll).toHaveBeenCalledTimes(1);
  });

  it('leaves the workers alone when the retry failed', async () => {
    syncResult.ok = false;
    await handler(IPC_CHANNELS.PI_MODELS_SYNC)({}, undefined);
    expect(syncManagedPiModels).toHaveBeenCalledWith(expect.any(String), { force: true });
    expect(invalidateAll).not.toHaveBeenCalled();
  });
});
