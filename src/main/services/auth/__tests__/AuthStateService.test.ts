import { describe, expect, it, vi } from 'vitest';
import {
  AuthStateService,
  type AuthStateVault,
  MANAGED_CREDENTIALS_FLAG_ENV,
  resolveManagedCredentialsEnabled,
} from '../AuthStateService';
import type { VaultReadResult } from '../CredentialVault';

/** D47 S1 spec §3 test group 2 — the three-state derivation table, subscription lifecycle, and the flag-off zero-IO guarantee. */

function fakeVault(result: VaultReadResult): AuthStateVault {
  return { read: vi.fn(() => result) };
}

describe('resolveManagedCredentialsEnabled', () => {
  it('is on only for the exact string "1"', () => {
    expect(resolveManagedCredentialsEnabled({ [MANAGED_CREDENTIALS_FLAG_ENV]: '1' })).toBe(true);
  });

  it('is off for absent, empty, and every truthy-looking spelling (falsifies a permissive reader)', () => {
    for (const raw of ['', '0', 'true', 'True', 'yes', 'on', '2', ' 1', '1 ']) {
      expect(resolveManagedCredentialsEnabled({ [MANAGED_CREDENTIALS_FLAG_ENV]: raw })).toBe(false);
    }
    expect(resolveManagedCredentialsEnabled({})).toBe(false);
  });

  it('re-reads the environment on every call', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(resolveManagedCredentialsEnabled(env)).toBe(false);
    env[MANAGED_CREDENTIALS_FLAG_ENV] = '1';
    expect(resolveManagedCredentialsEnabled(env)).toBe(true);
  });
});

describe('AuthStateService — three-state derivation table', () => {
  it('maps vault "ok" to authenticated/unknown', () => {
    const vault = fakeVault({
      status: 'ok',
      doc: {
        version: 1,
        enc: 'none',
        lastEmail: 'user@jcdz.cc',
        invalidatedAt: null,
        encReason: 'unavailable',
        payload: {
          identity: { email: 'user@jcdz.cc', userId: 1 },
          cchBaseUrl: 'https://cch.example.com',
          claude: { baseUrl: 'https://cch.example.com/v1', authToken: 'x' },
          codex: { baseUrl: 'https://cch.example.com/v1', apiKey: 'y' },
          receivedAt: '2026-08-15T00:00:00.000Z',
        },
      },
    });
    const service = new AuthStateService({ vault, env: { [MANAGED_CREDENTIALS_FLAG_ENV]: '1' } });
    expect(service.refresh()).toEqual({ status: 'authenticated', remoteHealth: 'unknown' });
  });

  it('maps vault "absent" to signed_out', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'absent' }),
      env: { [MANAGED_CREDENTIALS_FLAG_ENV]: '1' },
    });
    expect(service.refresh()).toEqual({ status: 'signed_out', reason: 'never' });
  });

  it('maps vault "locked" to signed_out, never credentials_invalid', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'locked', lastEmail: 'user@jcdz.cc' }),
      env: { [MANAGED_CREDENTIALS_FLAG_ENV]: '1' },
    });
    expect(service.refresh()).toEqual({ status: 'signed_out', reason: 'never' });
  });

  it('maps vault "unsupported" to signed_out, never credentials_invalid', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'unsupported', lastEmail: 'user@jcdz.cc' }),
      env: { [MANAGED_CREDENTIALS_FLAG_ENV]: '1' },
    });
    expect(service.refresh()).toEqual({ status: 'signed_out', reason: 'never' });
  });

  it('maps vault "invalid/malformed_json" and "invalid/schema_invalid" to credentials_invalid: corrupt', () => {
    const serviceA = new AuthStateService({
      vault: fakeVault({ status: 'invalid', reason: 'malformed_json' }),
      env: { [MANAGED_CREDENTIALS_FLAG_ENV]: '1' },
    });
    expect(serviceA.refresh()).toEqual({ status: 'credentials_invalid', reason: 'corrupt' });

    const serviceB = new AuthStateService({
      vault: fakeVault({ status: 'invalid', reason: 'schema_invalid' }),
      env: { [MANAGED_CREDENTIALS_FLAG_ENV]: '1' },
    });
    expect(serviceB.refresh()).toEqual({ status: 'credentials_invalid', reason: 'corrupt' });
  });

  it('maps vault "invalid/decrypt_failed" to credentials_invalid: decrypt_failed', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'invalid', reason: 'decrypt_failed' }),
      env: { [MANAGED_CREDENTIALS_FLAG_ENV]: '1' },
    });
    expect(service.refresh()).toEqual({ status: 'credentials_invalid', reason: 'decrypt_failed' });
  });
});

describe('AuthStateService — subscription lifecycle', () => {
  it('refresh() notifies onChange exactly once', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'absent' }),
      env: { [MANAGED_CREDENTIALS_FLAG_ENV]: '1' },
    });
    const listener = vi.fn();
    service.onChange(listener);

    service.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ status: 'signed_out', reason: 'never' });
  });

  it('the returned unsubscribe function stops further notifications', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'absent' }),
      env: { [MANAGED_CREDENTIALS_FLAG_ENV]: '1' },
    });
    const listener = vi.fn();
    const unsubscribe = service.onChange(listener);

    unsubscribe();
    service.refresh();

    expect(listener).not.toHaveBeenCalled();
  });

  it('getState() returns the cached snapshot without ever calling vault.read()', () => {
    const vault = fakeVault({ status: 'absent' });
    const service = new AuthStateService({ vault, env: { [MANAGED_CREDENTIALS_FLAG_ENV]: '1' } });

    expect(service.getState()).toEqual({ status: 'signed_out', reason: 'never' });
    expect(vault.read).not.toHaveBeenCalled();
  });
});

describe('AuthStateService — flag off is signed_out with zero filesystem IO', () => {
  it('refresh() never calls vault.read() when the flag is off', () => {
    const vault = fakeVault({ status: 'absent' });
    const service = new AuthStateService({ vault, env: {} });

    const state = service.refresh();

    expect(state).toEqual({ status: 'signed_out', reason: 'never' });
    expect(vault.read).not.toHaveBeenCalled();
  });

  it('getState() is signed_out before any refresh(), also with zero IO', () => {
    const vault = fakeVault({ status: 'absent' });
    const service = new AuthStateService({ vault, env: {} });

    expect(service.getState()).toEqual({ status: 'signed_out', reason: 'never' });
    expect(vault.read).not.toHaveBeenCalled();
  });

  it('a shell-inherited "true" spelling still means off — zero IO, matching the strict flag matrix', () => {
    // Vault would report "ok" (authenticated) if the flag were mistakenly
    // read as on — a permissive reader (`=== '1' || === 'true'`) would flip
    // both this state AND the IO count.
    const vault = fakeVault({
      status: 'ok',
      doc: {
        version: 1,
        enc: 'none',
        lastEmail: 'user@jcdz.cc',
        invalidatedAt: null,
        encReason: 'unavailable',
        payload: {
          identity: { email: 'user@jcdz.cc', userId: 1 },
          cchBaseUrl: 'https://cch.example.com',
          claude: { baseUrl: 'https://cch.example.com/v1', authToken: 'x' },
          codex: { baseUrl: 'https://cch.example.com/v1', apiKey: 'y' },
          receivedAt: '2026-08-15T00:00:00.000Z',
        },
      },
    });
    const service = new AuthStateService({
      vault,
      env: { [MANAGED_CREDENTIALS_FLAG_ENV]: 'true' },
    });

    const state = service.refresh();

    expect(state).toEqual({ status: 'signed_out', reason: 'never' });
    expect(vault.read).not.toHaveBeenCalled();
  });
});
