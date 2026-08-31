import { PI_PROJECT_TRUST_ENV } from '@shared/piModelConfig';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T08-c (D-Q9 decision 4) — what each Pi worker is told about project trust.
 *
 * The worker runs in its own process and cannot see the credential mode, so this
 * env var is the whole channel. Two things it must get right, and both are
 * silent when wrong:
 *
 *  - The managed route must send `'0'`. Sending `'1'` (or nothing) lets a
 *    repository the user cloned ship a `.pi/` config that turns the permission
 *    gate off, and nothing on screen would say so.
 *  - The key must be sent in BOTH modes. The per-slot worker treats absence as
 *    untrusted, but local mode still needs an explicit `'1'` to preserve the
 *    user's own project-scoped Pi configuration.
 */

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/aiclient-test' },
  net: { fetch: vi.fn() },
}));

const readSharedSettingsMock = vi.fn(() => ({}) as Record<string, unknown>);
vi.mock('../../SharedSessionState', () => ({
  readSharedSettings: () => readSharedSettingsMock(),
  writeSharedSettings: vi.fn(),
}));

vi.mock('../../auth', () => ({
  getCredentialVault: () => ({ read: () => ({ status: 'missing' }) }),
}));

vi.mock('../../appStatePaths', () => ({ getAppStateRoot: () => '/tmp/aiclient-test/.pilab/dev' }));

async function workerEnv(managed: boolean): Promise<Record<string, string>> {
  readSharedSettingsMock.mockReturnValue({ credentialMode: managed ? 'managed' : 'local' });
  const { resolveManagedPiWorkerEnv } = await import('../index');
  return resolveManagedPiWorkerEnv();
}

describe('resolveManagedPiWorkerEnv — project trust', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  });

  afterEach(() => {
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  });

  it('withholds a repository’s own scope on the managed route', async () => {
    const env = await workerEnv(true);
    expect(env[PI_PROJECT_TRUST_ENV]).toBe('0');
    // The managed route also isolates the agent directory — both keys travel.
    expect(env.PI_CODING_AGENT_DIR).toMatch(/pi-agent$/);
  });

  it('trusts a repository’s own scope on the local route', async () => {
    const env = await workerEnv(false);
    expect(env[PI_PROJECT_TRUST_ENV]).toBe('1');
    // The local route injects nothing else: the user's own ~/.pi stays in play.
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it('always sends the key so both trust postures are explicit', async () => {
    for (const managed of [true, false]) {
      expect(Object.keys(await workerEnv(managed))).toContain(PI_PROJECT_TRUST_ENV);
    }
  });
});
