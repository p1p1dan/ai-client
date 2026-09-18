import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANAGED_CREDENTIALS_DISABLED_ERROR,
  MANAGED_CREDENTIALS_UNAVAILABLE_ERROR,
} from '@shared/piModelConfig';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "The login-time model sync failed" has to survive long enough for the window
 * to ask about it.
 *
 * Both callers of `syncManagedPiModels` that matter here — `ipc/onboarding.ts`
 * on a successful login and `managedCredentialsStartup.regenerateFromVault` on
 * every launch — run with no renderer waiting on the result. Before this,
 * their only trace was a `console.warn`: a user signed in, landed on an empty
 * model menu, and was told nothing. These cases pin what is remembered, and
 * just as importantly what is NOT.
 */

const managedEnabled = { value: true };
const vaultPayload: { value: Record<string, unknown> | null } = { value: null };
const fetchMock = vi.fn();
let stateRoot = '';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/aiclient-test', getVersion: () => '9.9.9-test' },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) },
}));

vi.mock('../../SharedSessionState', () => ({
  readSharedSettings: () => ({}),
  writeSharedSettings: vi.fn(),
}));

vi.mock('../../auth/credentialMode', () => ({
  resolveManagedCredentialsEnabled: () => managedEnabled.value,
}));

vi.mock('../../auth', () => ({
  getCredentialVault: () => ({
    read: () =>
      vaultPayload.value
        ? { status: 'ok', doc: { payload: vaultPayload.value } }
        : { status: 'missing' },
    readUserProviders: () => ({ status: 'absent' }),
  }),
}));

vi.mock('../../appStatePaths', () => ({ getAppStateRoot: () => stateRoot }));

vi.mock('../../onboarding/serviceUrl', () => ({
  getOnboardingServiceUrl: () => 'https://onboarding.example.com',
}));

async function load() {
  return import('../index');
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  managedEnabled.value = true;
  vaultPayload.value = { pi: { apiKey: 'company-key', baseUrl: 'https://gw.example.com/v1' } };
  stateRoot = mkdtempSync(join(tmpdir(), 'aiclient-sync-failure-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe('managed Pi model sync failures', () => {
  it('remembers a sync refused because this install is on the local route', async () => {
    managedEnabled.value = false;
    const { syncManagedPiModels, getManagedPiSyncFailure } = await load();

    const result = await syncManagedPiModels(undefined, { force: true });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(MANAGED_CREDENTIALS_DISABLED_ERROR);
    expect(getManagedPiSyncFailure()?.kind).toBe('credentials-disabled');
    // Never reached the wire: the refusal happens before any request.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remembers a login that produced no gateway credential', async () => {
    vaultPayload.value = null;
    const { syncManagedPiModels, getManagedPiSyncFailure } = await load();

    const result = await syncManagedPiModels(undefined, { force: true });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(MANAGED_CREDENTIALS_UNAVAILABLE_ERROR);
    expect(getManagedPiSyncFailure()?.kind).toBe('credentials-missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remembers a refused account even though the shipped baseline answered', async () => {
    // The A3 rung returns `ok: true` on a 401 — and writes that baseline's
    // providers with the key the endpoint just rejected, so every turn would
    // fail at request time. A full menu is not a rescue when the account
    // cannot use it, which is why this one is reported anyway.
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'nope' });
    const { syncManagedPiModels, getManagedPiSyncFailure } = await load();

    const result = await syncManagedPiModels(undefined, { force: true });

    // Pinned, because it is the whole point of the case: the sync reports
    // success off the shipped snapshot and the failure is remembered anyway.
    expect(result.ok).toBe(true);
    expect(result.source).toBe('bundled');
    expect(getManagedPiSyncFailure()?.kind).toBe('unauthorized');
  });

  it('forgets the failure once a sync succeeds', async () => {
    managedEnabled.value = false;
    const { syncManagedPiModels, getManagedPiSyncFailure } = await load();
    await syncManagedPiModels(undefined, { force: true });
    expect(getManagedPiSyncFailure()).not.toBeNull();

    managedEnabled.value = true;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          version: 1,
          providers: {
            dan: {
              api: 'openai-responses',
              baseUrl: 'https://models.example.com/v1',
              models: [{ id: 'deepseek-v4' }],
            },
          },
        }),
    });
    await syncManagedPiModels(undefined, { force: true });

    // The card is driven off this value, so a stale one would leave a red box
    // standing over an install that is now working.
    expect(getManagedPiSyncFailure()).toBeNull();
  });
});
