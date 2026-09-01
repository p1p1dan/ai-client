import { describe, expect, it, vi } from 'vitest';
import { AuthStateService, type AuthStateVault } from '../AuthStateService';
import type { VaultReadResult } from '../CredentialVault';

/**
 * D47 S1 spec §3 test group 2 (three-state derivation, subscription
 * lifecycle, flag-off zero-IO) + D47 S5 §1.2/§3 (five-arm derivation, "value
 * changed only" broadcast, `markRejected` orchestration, logout latch).
 */

function fakeVault(result: VaultReadResult): AuthStateVault {
  return { read: vi.fn(() => result), markInvalidated: vi.fn(async () => {}) };
}

/**
 * D64/S3 — "are managed credentials on" is INJECTED now, not read from an env
 * var this service resolves itself. The rule that produces it moved to
 * `@shared/credentialMode` and has its own tests; what belongs here is only
 * that this service honours whichever answer it is handed.
 */
const ON_ENV = { managed: () => true };
const OFF_ENV = { managed: () => false };

describe('AuthStateService — five-arm derivation table (D47 S5 §1.1)', () => {
  it('maps vault "ok" to authenticated/email/unknown', () => {
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
    const service = new AuthStateService({ vault, ...ON_ENV });
    expect(service.refresh()).toEqual({
      status: 'authenticated',
      email: 'user@jcdz.cc',
      remoteHealth: 'unknown',
    });
  });

  it('maps vault "absent" to signed_out with lastEmail null', () => {
    const service = new AuthStateService({ vault: fakeVault({ status: 'absent' }), ...ON_ENV });
    expect(service.refresh()).toEqual({ status: 'signed_out', lastEmail: null });
  });

  it('maps vault "cleared" to signed_out, carrying lastEmail', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'cleared', lastEmail: 'past@jcdz.cc' }),
      ...ON_ENV,
    });
    expect(service.refresh()).toEqual({ status: 'signed_out', lastEmail: 'past@jcdz.cc' });
  });

  it('maps vault "locked" to its own `locked` arm, never signed_out or credentials_invalid', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'locked', lastEmail: 'user@jcdz.cc' }),
      ...ON_ENV,
    });
    expect(service.refresh()).toEqual({ status: 'locked', lastEmail: 'user@jcdz.cc' });
  });

  it('maps vault "unsupported" to signed_out (unchanged S1 rule)', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'unsupported', lastEmail: 'user@jcdz.cc' }),
      ...ON_ENV,
    });
    expect(service.refresh()).toEqual({ status: 'signed_out', lastEmail: 'user@jcdz.cc' });
  });

  it('maps vault "rejected" to credentials_invalid: rejected', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'rejected', lastEmail: 'user@jcdz.cc' }),
      ...ON_ENV,
    });
    expect(service.refresh()).toEqual({
      status: 'credentials_invalid',
      reason: 'rejected',
      lastEmail: 'user@jcdz.cc',
    });
  });

  it('maps vault "invalid/malformed_json" and "invalid/schema_invalid" to credentials_invalid: corrupt', () => {
    const serviceA = new AuthStateService({
      vault: fakeVault({ status: 'invalid', reason: 'malformed_json' }),
      ...ON_ENV,
    });
    expect(serviceA.refresh()).toEqual({
      status: 'credentials_invalid',
      reason: 'corrupt',
      lastEmail: null,
    });

    const serviceB = new AuthStateService({
      vault: fakeVault({ status: 'invalid', reason: 'schema_invalid' }),
      ...ON_ENV,
    });
    expect(serviceB.refresh()).toEqual({
      status: 'credentials_invalid',
      reason: 'corrupt',
      lastEmail: null,
    });
  });

  it('maps vault "invalid/decrypt_failed" to credentials_invalid: decrypt_failed', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'invalid', reason: 'decrypt_failed', lastEmail: 'user@jcdz.cc' }),
      ...ON_ENV,
    });
    expect(service.refresh()).toEqual({
      status: 'credentials_invalid',
      reason: 'decrypt_failed',
      lastEmail: 'user@jcdz.cc',
    });
  });
});

describe('AuthStateService — migrationSignal / migration_incomplete (D47 S6 §1.4)', () => {
  it('vault absent + migrationSignal incomplete produces credentials_invalid/migration_incomplete with the legacy email', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'absent' }),
      ...ON_ENV,
      migrationSignal: () => ({ migrationIncomplete: true, legacyEmail: 'legacy@jcdz.cc' }),
    });
    expect(service.refresh()).toEqual({
      status: 'credentials_invalid',
      reason: 'migration_incomplete',
      lastEmail: 'legacy@jcdz.cc',
    });
  });

  it('vault absent + migrationSignal NOT incomplete is still a plain signed_out', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'absent' }),
      ...ON_ENV,
      migrationSignal: () => ({ migrationIncomplete: false, legacyEmail: null }),
    });
    expect(service.refresh()).toEqual({ status: 'signed_out', lastEmail: null });
  });

  it('no migrationSignal injected at all defaults to the no-op signal (plain signed_out on absent)', () => {
    const service = new AuthStateService({ vault: fakeVault({ status: 'absent' }), ...ON_ENV });
    expect(service.refresh()).toEqual({ status: 'signed_out', lastEmail: null });
  });

  it('every non-absent vault status ignores migrationSignal entirely, even when it claims incomplete', () => {
    const incompleteSignal = () => ({ migrationIncomplete: true, legacyEmail: 'legacy@jcdz.cc' });

    const cleared = new AuthStateService({
      vault: fakeVault({ status: 'cleared', lastEmail: 'past@jcdz.cc' }),
      ...ON_ENV,
      migrationSignal: incompleteSignal,
    });
    expect(cleared.refresh()).toEqual({ status: 'signed_out', lastEmail: 'past@jcdz.cc' });

    const rejected = new AuthStateService({
      vault: fakeVault({ status: 'rejected', lastEmail: 'user@jcdz.cc' }),
      ...ON_ENV,
      migrationSignal: incompleteSignal,
    });
    expect(rejected.refresh()).toEqual({
      status: 'credentials_invalid',
      reason: 'rejected',
      lastEmail: 'user@jcdz.cc',
    });

    const locked = new AuthStateService({
      vault: fakeVault({ status: 'locked', lastEmail: 'user@jcdz.cc' }),
      ...ON_ENV,
      migrationSignal: incompleteSignal,
    });
    expect(locked.refresh()).toEqual({ status: 'locked', lastEmail: 'user@jcdz.cc' });

    const unsupported = new AuthStateService({
      vault: fakeVault({ status: 'unsupported', lastEmail: 'user@jcdz.cc' }),
      ...ON_ENV,
      migrationSignal: incompleteSignal,
    });
    expect(unsupported.refresh()).toEqual({ status: 'signed_out', lastEmail: 'user@jcdz.cc' });

    const invalid = new AuthStateService({
      vault: fakeVault({ status: 'invalid', reason: 'decrypt_failed', lastEmail: 'user@jcdz.cc' }),
      ...ON_ENV,
      migrationSignal: incompleteSignal,
    });
    expect(invalid.refresh()).toEqual({
      status: 'credentials_invalid',
      reason: 'decrypt_failed',
      lastEmail: 'user@jcdz.cc',
    });

    const ok = new AuthStateService({
      vault: fakeVault({
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
      }),
      ...ON_ENV,
      migrationSignal: incompleteSignal,
    });
    expect(ok.refresh()).toEqual({
      status: 'authenticated',
      email: 'user@jcdz.cc',
      remoteHealth: 'unknown',
    });
  });
});

describe('AuthStateService — subscription lifecycle, value-changed-only broadcast (D47 S5 §1.2)', () => {
  it('refresh() notifies onChange when the value actually changes', () => {
    // The service's own pre-refresh default is already `signed_out/null`
    // (D47 S5 — Main never produces `unknown`), so a vault outcome that
    // ALSO derives to `signed_out/null` would be a no-op broadcast under the
    // new "value changed only" rule. Use `locked`, which differs from the
    // default, to exercise the "did change" path.
    const service = new AuthStateService({
      vault: fakeVault({ status: 'locked', lastEmail: 'user@jcdz.cc' }),
      ...ON_ENV,
    });
    const listener = vi.fn();
    service.onChange(listener);

    service.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ status: 'locked', lastEmail: 'user@jcdz.cc' });
  });

  it('a second refresh() with an unchanged value does NOT notify again', () => {
    const vault = fakeVault({ status: 'locked', lastEmail: 'user@jcdz.cc' });
    const service = new AuthStateService({ vault, ...ON_ENV });
    const listener = vi.fn();
    service.onChange(listener);

    service.refresh();
    service.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('the pre-refresh default already equals a plain signed_out/null vault outcome, so the first refresh() does NOT broadcast', () => {
    const service = new AuthStateService({ vault: fakeVault({ status: 'absent' }), ...ON_ENV });
    const listener = vi.fn();
    service.onChange(listener);

    const state = service.refresh();

    expect(state).toEqual({ status: 'signed_out', lastEmail: null });
    expect(listener).not.toHaveBeenCalled();
  });

  it('a refresh() that changes reason/lastEmail on the same status DOES notify again', () => {
    let current: VaultReadResult = { status: 'locked', lastEmail: 'a@jcdz.cc' };
    const vault: AuthStateVault = {
      read: vi.fn(() => current),
      markInvalidated: vi.fn(async () => {}),
    };
    const service = new AuthStateService({ vault, ...ON_ENV });
    const listener = vi.fn();
    service.refresh();
    service.onChange(listener);

    current = { status: 'locked', lastEmail: 'b@jcdz.cc' };
    service.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ status: 'locked', lastEmail: 'b@jcdz.cc' });
  });

  it('the returned unsubscribe function stops further notifications', () => {
    const service = new AuthStateService({ vault: fakeVault({ status: 'absent' }), ...ON_ENV });
    const listener = vi.fn();
    const unsubscribe = service.onChange(listener);

    unsubscribe();
    service.refresh();

    expect(listener).not.toHaveBeenCalled();
  });

  it('getState() returns the cached snapshot without ever calling vault.read()', () => {
    const vault = fakeVault({ status: 'absent' });
    const service = new AuthStateService({ vault, ...ON_ENV });

    expect(service.getState()).toEqual({ status: 'signed_out', lastEmail: null });
    expect(vault.read).not.toHaveBeenCalled();
  });
});

describe('AuthStateService — local mode is signed_out with zero filesystem IO', () => {
  it('refresh() never calls vault.read() in local mode', () => {
    const vault = fakeVault({ status: 'absent' });
    const service = new AuthStateService({ vault, ...OFF_ENV });

    const state = service.refresh();

    expect(state).toEqual({ status: 'signed_out', lastEmail: null });
    expect(vault.read).not.toHaveBeenCalled();
  });

  it('getState() is signed_out before any refresh(), also with zero IO', () => {
    const vault = fakeVault({ status: 'absent' });
    const service = new AuthStateService({ vault, ...OFF_ENV });

    expect(service.getState()).toEqual({ status: 'signed_out', lastEmail: null });
    expect(vault.read).not.toHaveBeenCalled();
  });

  /**
   * The spelling matrix that used to live here (`'true'` must not read as on)
   * moved with the rule itself to `shared/__tests__/credentialMode.test.ts`.
   * What is still THIS file's business is that a `false` answer costs no IO
   * even when the vault would have reported `ok` — i.e. the short-circuit is
   * before `vault.read()`, not after it.
   */
  it('skips the vault entirely in local mode, even when it would have said ok', () => {
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
    const service = new AuthStateService({ vault, ...OFF_ENV });

    expect(service.refresh()).toEqual({ status: 'signed_out', lastEmail: null });
    expect(vault.read).not.toHaveBeenCalled();
  });
});

describe('AuthStateService — markRejected() orchestration (D47 S5 §2, B-track B5)', () => {
  it('calls vault.markInvalidated, THEN worker invalidation, THEN refresh — in that order', async () => {
    const order: string[] = [];
    let vaultStatus: VaultReadResult = {
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
    };
    const vault: AuthStateVault = {
      read: vi.fn(() => vaultStatus),
      markInvalidated: vi.fn(async (iso: string) => {
        order.push(`markInvalidated:${iso}`);
        vaultStatus = { status: 'rejected', lastEmail: 'user@jcdz.cc' };
      }),
    };
    const runtimeInvalidator = {
      invalidateAll: vi.fn(async () => {
        order.push('invalidateAll');
      }),
    };
    const service = new AuthStateService({
      vault,
      ...ON_ENV,
      runtimeInvalidator,
      now: () => new Date('2026-08-15T12:00:00.000Z'),
    });
    service.refresh();
    const listener = vi.fn();
    service.onChange(listener);

    await service.markRejected();

    expect(order).toEqual(['markInvalidated:2026-08-15T12:00:00.000Z', 'invalidateAll']);
    expect(vault.markInvalidated).toHaveBeenCalledWith('2026-08-15T12:00:00.000Z');
    expect(runtimeInvalidator.invalidateAll).toHaveBeenCalledTimes(1);
    expect(service.getState()).toEqual({
      status: 'credentials_invalid',
      reason: 'rejected',
      lastEmail: 'user@jcdz.cc',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('defaults to a no-op runtime invalidator when none is injected', async () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'rejected', lastEmail: null }),
      ...ON_ENV,
    });
    await expect(service.markRejected()).resolves.toBeUndefined();
  });
});

describe('AuthStateService — logout latch (D47 S5 §3 I9 checkpoint ①)', () => {
  it('isAuthenticatedForSpawn() is true only while authenticated and no logout is in flight', () => {
    let vaultStatus: VaultReadResult = {
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
    };
    const vault: AuthStateVault = {
      read: vi.fn(() => vaultStatus),
      markInvalidated: vi.fn(async () => {}),
    };
    const service = new AuthStateService({ vault, ...ON_ENV });

    expect(service.isAuthenticatedForSpawn()).toBe(false); // before any refresh
    service.refresh();
    expect(service.isAuthenticatedForSpawn()).toBe(true);

    // Checkpoint ① fires before the vault is actually cleared — the gate
    // must already reject.
    service.beginLogout();
    expect(service.isAuthenticatedForSpawn()).toBe(false);

    // A later refresh() (checkpoint ⑦'s broadcast, or any unrelated refresh)
    // releases the latch — the real (now signed_out) snapshot takes over.
    vaultStatus = { status: 'cleared', lastEmail: 'user@jcdz.cc' };
    service.refresh();
    expect(service.isAuthenticatedForSpawn()).toBe(false); // signed_out, not authenticated
  });
});

describe('AuthStateService — reportRemoteHealthy (D47 S5 §2)', () => {
  it('bumps remoteHealth unknown -> valid on the cached authenticated snapshot without a vault re-read, and broadcasts', () => {
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
    const service = new AuthStateService({ vault, ...ON_ENV });
    service.refresh();
    const readCallsBefore = vi.mocked(vault.read).mock.calls.length;
    const listener = vi.fn();
    service.onChange(listener);

    service.reportRemoteHealthy();

    expect(service.getState()).toEqual({
      status: 'authenticated',
      email: 'user@jcdz.cc',
      remoteHealth: 'valid',
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(vi.mocked(vault.read).mock.calls.length).toBe(readCallsBefore);

    // Calling it again is a no-op (already valid) — no double broadcast.
    service.reportRemoteHealthy();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is a no-op outside authenticated', () => {
    const service = new AuthStateService({
      vault: fakeVault({ status: 'absent' }),
      ...ON_ENV,
    });
    service.refresh();
    const listener = vi.fn();
    service.onChange(listener);

    service.reportRemoteHealthy();

    expect(listener).not.toHaveBeenCalled();
  });
});
