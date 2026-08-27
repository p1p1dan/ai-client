import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppStateRoot } from '@shared/appStateLayout';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultPayload } from '../CredentialVault';

/**
 * D47 S1 spec §3-1h and §1/§2.2 — the ONLY module allowed to import
 * `electron`. Everything here mocks `electron` and drives the lazy
 * singleton factory + promotion latch through it.
 */

const state = {
  userDataPath: '/initial/aiclient-userdata',
  encryptionAvailable: false,
};

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : `/other/${name}`)),
    setPath: vi.fn((name: string, value: string) => {
      if (name === 'userData') state.userDataPath = value;
    }),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => state.encryptionAvailable),
    encryptString: vi.fn((plainText: string) => Buffer.from(plainText, 'utf-8')),
    decryptString: vi.fn((buffer: Buffer) => buffer.toString('utf-8')),
  },
}));

function makePayload(): VaultPayload {
  return {
    identity: { email: 'user@jcdz.cc', userId: 1 },
    cchBaseUrl: 'https://cch.example.com',
    claude: { baseUrl: 'https://cch.example.com/v1', authToken: 'claude-secret' },
    codex: { baseUrl: 'https://cch.example.com/v1', apiKey: 'codex-secret' },
    receivedAt: '2026-08-15T00:00:00.000Z',
  };
}

let tmpRoot: string;
let tmpHome: string;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

beforeEach(() => {
  vi.resetModules();
  tmpRoot = mkdtempSync(join(tmpdir(), 'aiclient-auth-index-'));
  // S2 moved the vault out of `<userData>` and into `$HOME/.pilab/<profile>`,
  // so `$HOME` has to be redirected too — otherwise this test would write a
  // vault into the developer's real home directory.
  tmpHome = mkdtempSync(join(tmpdir(), 'aiclient-auth-index-home-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  state.userDataPath = '/initial/aiclient-userdata';
  state.encryptionAvailable = false;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('getCredentialVault — lazy baseDir resolution (A-track B1)', () => {
  it('follows a setPath("userData", …) that happens AFTER this module was imported, not the path captured at import time', async () => {
    const authIndex = await import('../index');
    // Import already happened above, at the stale default userData path —
    // a module-scope `app.getPath('userData')` capture would now be frozen
    // on '/initial/aiclient-userdata'.
    const { app } = await import('electron');
    (app.setPath as ReturnType<typeof vi.fn>)('userData', tmpRoot);

    const vault = authIndex.getCredentialVault();
    vault.promoteCrypto({ available: () => false, encrypt: (s) => s, decrypt: (s) => s });
    await vault.save(makePayload());

    // The lazy property is unchanged by S2 — only the destination moved:
    // `<userData>`'s basename is now the profile segment of the state root,
    // so a module-scope capture would still put the vault under
    // `/initial/aiclient-userdata`'s name instead of this one.
    expect(existsSync(join(buildAppStateRoot(tmpHome, tmpRoot), 'credentials', 'vault.json'))).toBe(
      true
    );
  });

  it('memoizes the vault instance across calls (singleton)', async () => {
    const authIndex = await import('../index');
    expect(authIndex.getCredentialVault()).toBe(authIndex.getCredentialVault());
  });

  it('resetAuthSingletonsForTests() clears the memoized instances', async () => {
    const authIndex = await import('../index');
    const first = authIndex.getCredentialVault();
    authIndex.resetAuthSingletonsForTests();
    const second = authIndex.getCredentialVault();
    expect(second).not.toBe(first);
  });
});

describe('getAuthStateService — wired to the same vault singleton', () => {
  it('reads through getCredentialVault()', async () => {
    const authIndex = await import('../index');
    (await import('electron')).app.setPath('userData', tmpRoot);

    const vault = authIndex.getCredentialVault();
    vault.promoteCrypto({ available: () => true, encrypt: (s) => s, decrypt: (s) => s });
    await vault.save(makePayload());

    const authState = authIndex.getAuthStateService();
    const snapshot = authState.refresh();
    // Flag is off in this test's process env (not set) — AuthStateService's
    // own zero-IO gate applies regardless of what the vault holds.
    expect(snapshot).toEqual({ status: 'signed_out', lastEmail: null });
  });
});

describe('promoteVaultCrypto / createRealVaultCrypto', () => {
  it('wires the real safeStorage adapter through to CredentialVault', async () => {
    const authIndex = await import('../index');
    (await import('electron')).app.setPath('userData', tmpRoot);
    state.encryptionAvailable = true;

    authIndex.promoteVaultCrypto(authIndex.createRealVaultCrypto());
    const saveResult = await authIndex.getCredentialVault().save(makePayload());

    expect(saveResult).toEqual({ ok: true });
    const { safeStorage } = await import('electron');
    expect(safeStorage.isEncryptionAvailable).toHaveBeenCalled();
    expect(safeStorage.encryptString).toHaveBeenCalled();
  });

  it('promotion is idempotent across repeated calls', async () => {
    const authIndex = await import('../index');
    (await import('electron')).app.setPath('userData', tmpRoot);

    authIndex.promoteVaultCrypto(authIndex.createRealVaultCrypto());
    authIndex.promoteVaultCrypto(authIndex.createRealVaultCrypto());
    const saveResult = await authIndex.getCredentialVault().save(makePayload());
    expect(saveResult).toEqual({ ok: true });
  });
});
