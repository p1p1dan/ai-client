import { PI_PROJECT_TRUST_ENV } from '@shared/piModelConfig';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T08-c (D-Q9 decision 4) — what the pi Host is told about project trust.
 *
 * The Host runs in its own process and cannot see the credential mode, so this
 * env var is the whole channel. Two things it must get right, and both are
 * silent when wrong:
 *
 *  - The managed route must send `'0'`. Sending `'1'` (or nothing) lets a
 *    repository the user cloned ship a `.pi/` config that turns the permission
 *    gate off, and nothing on screen would say so.
 *  - The key must be sent in BOTH modes. The Host reads an ABSENT key as "old
 *    Main build, keep the historical posture" — so omitting it on the managed
 *    route would land on exactly the wrong answer.
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

async function hostEnv(managed: boolean): Promise<Record<string, string>> {
  readSharedSettingsMock.mockReturnValue({ credentialMode: managed ? 'managed' : 'local' });
  const { resolveManagedPiHostEnv } = await import('../index');
  return resolveManagedPiHostEnv();
}

describe('resolveManagedPiHostEnv — project trust', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  });

  afterEach(() => {
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  });

  it('withholds a repository’s own scope on the managed route', async () => {
    const env = await hostEnv(true);
    expect(env[PI_PROJECT_TRUST_ENV]).toBe('0');
    // The managed route also isolates the agent directory — both keys travel.
    expect(env.PI_CODING_AGENT_DIR).toMatch(/pi-agent$/);
  });

  it('trusts a repository’s own scope on the local route', async () => {
    const env = await hostEnv(false);
    expect(env[PI_PROJECT_TRUST_ENV]).toBe('1');
    // The local route injects nothing else: the user's own ~/.pi stays in play.
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  /** Omission is the Host's "old Main build" signal and must never be sent. */
  it('always sends the key, so an absent one can only mean an old Main build', async () => {
    for (const managed of [true, false]) {
      expect(Object.keys(await hostEnv(managed))).toContain(PI_PROJECT_TRUST_ENV);
    }
  });
});
