import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProvider, UserProvidersReadResult } from '../../auth/CredentialVault';

/**
 * import-catalog-02 — the vault's verdict, which the runtime reader used to
 * throw away.
 *
 * Both callers read the same group; only one of them can live with "the vault
 * was unreadable" being reported as "the user has no services". This pins the
 * mapping, because it is the whole reason the native catalog can tell the two
 * apart now.
 */

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

let vaultResult: UserProvidersReadResult = { status: 'absent' };
vi.mock('../../auth', () => ({
  getCredentialVault: () => ({ readUserProviders: () => vaultResult }),
}));

const enabled: UserProvider = {
  id: '3f2a9c11-0000-4000-8000-000000000000',
  name: 'Mine',
  baseUrl: 'https://api.example/v1',
  api: 'openai-completions',
  apiKey: 'USER-KEY',
  enabled: true,
  createdAt: '2026-09-10T00:00:00.000Z',
};
const disabled: UserProvider = { ...enabled, id: 'other', name: 'Off', enabled: false };

async function readGroup() {
  const { readUserProviderGroupForRuntime } = await import('../index');
  return readUserProviderGroupForRuntime();
}

describe('readUserProviderGroupForRuntime', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reports a readable group, with disabled services already filtered out', async () => {
    vaultResult = { status: 'ok', providers: [enabled, disabled] };
    expect(await readGroup()).toEqual({ readable: true, providers: [enabled] });
  });

  it('counts an absent vault as readable: nobody has added a service yet', async () => {
    vaultResult = { status: 'absent' };
    expect(await readGroup()).toEqual({ readable: true, providers: [] });
  });

  it.each([
    ['locked', { status: 'locked' } as UserProvidersReadResult],
    ['unsupported', { status: 'unsupported' } as UserProvidersReadResult],
    ['decrypt_failed', { status: 'invalid', reason: 'decrypt_failed' } as UserProvidersReadResult],
  ])('reports %s as UNREADABLE rather than as an empty group', async (_label, result) => {
    // A locked keyring is the reported failure: the services are on disk and
    // decryptable later, so "there are none" is the one answer that is wrong.
    vaultResult = result;
    expect(await readGroup()).toEqual({ readable: false, providers: [] });
  });

  it('keeps the old empty-on-failure reading for the file writer', async () => {
    vaultResult = { status: 'locked' };
    const { readUserProvidersForRuntime } = await import('../index');
    expect(readUserProvidersForRuntime()).toEqual([]);
  });
});
