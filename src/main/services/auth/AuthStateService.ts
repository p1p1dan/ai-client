/**
 * D47 S1 §2.4 / D47 S5 §1.2-§1.4/§3 — the login-state state machine. Pure
 * module: it is handed a vault-like object (duck-typed against
 * `CredentialVault`, type-only import) and an optional runtime invalidator,
 * and computes one of the
 * FIVE `AuthState` arms (`@shared/types/auth`, the S5 authoritative DTO —
 * replaces this file's own S1-local 3-arm type).
 *
 * D64/S3 — "are managed credentials on" MOVED OUT of this file. It used to be
 * `resolveManagedCredentialsEnabled(env)`, answerable from an environment
 * variable and therefore pure; the answer now comes from
 * `~/.pilab/<profile>/settings.json`, which needs `electron`. Rather than end
 * this module's purity, the resolved value is INJECTED — see the `managed`
 * option below. `services/auth/credentialMode.ts` is where it comes from.
 *
 * S5 wires this into `main/ipc/auth.ts` (`auth.getGateSnapshot` /
 * `auth.stateChanged`), the spawn gate (`main/ipc/chat.ts` /
 * `SessionManager.create`), and the I9 logout orchestration
 * (`main/ipc/onboarding.ts`'s `performLogoutSequence`) — this class stays the
 * single owner of "what is the current login state" and "how does it change".
 */

import type { AuthState } from '@shared/types/auth';
import type { VaultReadResult } from './CredentialVault';

export interface AuthStateVault {
  read(): VaultReadResult;
  markInvalidated(iso: string): Promise<void>;
}

/** Pure dependency seam for invalidating worker generations after credential rejection. */
export interface AuthStateRuntimeInvalidator {
  invalidateAll(): Promise<void>;
}

/** D47 S6 §1.4 — see `adoption.ts`'s `AuthStateMigrationSignal` (duck-typed here rather than imported, keeping this file's own dependency surface unchanged). */
export interface AuthStateMigrationSignal {
  migrationIncomplete: boolean;
  legacyEmail: string | null;
}

export interface AuthStateServiceOptions {
  vault: AuthStateVault;
  /**
   * D64/S3 — "are managed credentials on right now", injected rather than read.
   *
   * A FUNCTION, not a boolean: the answer is a user setting now, so it can
   * change while this service is alive (the login page writes it, and a login
   * writes it too). Capturing it once would freeze the gate on whatever was
   * true at construction. Defaults to `true` — every pre-D64 caller, including
   * this file's own tests, was written against a service that only ever ran
   * with managed credentials on.
   */
  managed?: () => boolean;
  env?: NodeJS.ProcessEnv;
  /** Defaults to a no-op; production supplies the Main-owned WorkerManager. */
  runtimeInvalidator?: AuthStateRuntimeInvalidator;
  /** Injectable clock for `markRejected()`'s `invalidatedAt` timestamp — defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * D47 S6 §1.4 — supplies the "registered=true but adoption's required
   * source was missing, or the gateway guard rejected it" signal (plus the
   * legacy email to prefill). Only consulted when `vault.read()` comes back
   * `absent`; turns that into `credentials_invalid: migration_incomplete`
   * instead of `signed_out`. Defaults to "never incomplete" — every S1-S5
   * caller (tests, and any wiring that predates adoption) keeps its exact
   * prior behavior unchanged.
   */
  migrationSignal?: () => AuthStateMigrationSignal;
}

const DEFAULT_STATE: AuthState = { status: 'signed_out', lastEmail: null };

function normalizeLastEmail(value: string | null | undefined): string | null {
  return value ?? null;
}

/**
 * D47 S5 §1.1 / D47 S6 §1.4 — the seven `CredentialVault.read()` outcomes
 * fold down to the six `AuthState` arms. `rejected` is checked ahead of
 * everything by the vault itself (`read()`'s own priority order), so this
 * switch only needs to translate 1:1. `locked` gets its OWN arm (rev.2
 * self-correction — rev.1 folded it into `signed_out`, which forces a
 * re-login for a merely-locked keyring and conflicts with S2's "保字节"
 * contract). `unsupported` stays folded into `signed_out`, unchanged from
 * S1 — rev.2 never re-litigated it (only `locked` was called out as "rev.1
 * 的错"), and it is not one of the five columns in the S5 20-cell matrix
 * (ok/cleared/rejected/locked/invalid). `absent` is the ONLY status that
 * consults `migrationSignal`: a fresh S6 adoption skip for a
 * "registered=true but source missing/guard rejected" machine reads as
 * `credentials_invalid: migration_incomplete` rather than plain
 * `signed_out` — every other `absent` case (never registered at all) is
 * unaffected.
 */
function mapVaultResultToAuthState(
  result: VaultReadResult,
  migrationSignal: AuthStateMigrationSignal
): AuthState {
  switch (result.status) {
    case 'ok':
      return {
        status: 'authenticated',
        email: result.doc.payload.identity.email,
        remoteHealth: 'unknown',
      };
    case 'absent':
      return migrationSignal.migrationIncomplete
        ? {
            status: 'credentials_invalid',
            reason: 'migration_incomplete',
            lastEmail: migrationSignal.legacyEmail,
          }
        : { status: 'signed_out', lastEmail: null };
    case 'cleared':
      return { status: 'signed_out', lastEmail: normalizeLastEmail(result.lastEmail) };
    case 'unsupported':
      return { status: 'signed_out', lastEmail: normalizeLastEmail(result.lastEmail) };
    case 'locked':
      return { status: 'locked', lastEmail: normalizeLastEmail(result.lastEmail) };
    case 'rejected':
      return {
        status: 'credentials_invalid',
        reason: 'rejected',
        lastEmail: normalizeLastEmail(result.lastEmail),
      };
    case 'invalid':
      return {
        status: 'credentials_invalid',
        reason: result.reason === 'decrypt_failed' ? 'decrypt_failed' : 'corrupt',
        lastEmail: normalizeLastEmail(result.lastEmail),
      };
  }
}

/** D47 S5 §1.2 "值变才广播" — structural equality per arm, not `===`/JSON.stringify (field order stays explicit and readable). */
function statesEqual(a: AuthState, b: AuthState): boolean {
  if (a.status !== b.status) return false;
  switch (a.status) {
    case 'unknown':
      return true;
    case 'signed_out':
      return a.lastEmail === (b as Extract<AuthState, { status: 'signed_out' }>).lastEmail;
    case 'authenticated': {
      const other = b as Extract<AuthState, { status: 'authenticated' }>;
      return a.email === other.email && a.remoteHealth === other.remoteHealth;
    }
    case 'credentials_invalid': {
      const other = b as Extract<AuthState, { status: 'credentials_invalid' }>;
      return a.reason === other.reason && a.lastEmail === other.lastEmail;
    }
    case 'locked':
      return a.lastEmail === (b as Extract<AuthState, { status: 'locked' }>).lastEmail;
  }
}

export class AuthStateService {
  private readonly vault: AuthStateVault;
  private readonly managed: () => boolean;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly runtimeInvalidator: AuthStateRuntimeInvalidator;
  private readonly now: () => Date;
  private readonly migrationSignal: () => AuthStateMigrationSignal;
  private snapshot: AuthState = DEFAULT_STATE;
  private readonly listeners = new Set<(state: AuthState) => void>();
  // D47 S5 §3 I9 checkpoint ① — set synchronously by `beginLogout()`, BEFORE
  // any session teardown, so the spawn gate rejects new agent sessions
  // immediately even though `refresh()` (which would otherwise re-derive
  // `signed_out` from the vault) has not run yet. Cleared by the next
  // `refresh()` — once a refresh has landed, the real snapshot is
  // authoritative again and the transient latch would otherwise stick
  // forever and block a later, successful re-login.
  private logoutInProgress = false;
  // D47 S5 §1.3 — `auth.getGateSnapshot`'s lazy latch: true once `refresh()`
  // has run at least once this process lifetime.
  private refreshed = false;

  constructor(options: AuthStateServiceOptions) {
    this.vault = options.vault;
    this.managed = options.managed ?? (() => true);
    this.env = options.env;
    this.runtimeInvalidator = options.runtimeInvalidator ?? { invalidateAll: async () => {} };
    this.now = options.now ?? (() => new Date());
    this.migrationSignal =
      options.migrationSignal ?? (() => ({ migrationIncomplete: false, legacyEmail: null }));
  }

  /** Cache-only, never touches disk — safe to call on every render/query. */
  getState(): AuthState {
    return this.snapshot;
  }

  /**
   * Recomputes the snapshot and notifies every subscriber IFF the value
   * actually changed (D47 S5 §1.2 — upgraded from S1's "always notify
   * exactly once"). Local mode short-circuits BEFORE `vault.read()` is called
   * — zero filesystem IO is a hard requirement (S1 spec §2.4), not just a fast
   * path. Also releases the `beginLogout()` latch — see its field comment.
   */
  refresh(): AuthState {
    this.logoutInProgress = false;
    this.refreshed = true;
    const enabled = this.managed();
    const next = enabled
      ? mapVaultResultToAuthState(this.vault.read(), this.migrationSignal())
      : DEFAULT_STATE;
    const changed = !statesEqual(this.snapshot, next);
    this.snapshot = next;
    if (changed) {
      for (const listener of this.listeners) {
        listener(next);
      }
    }
    return next;
  }

  /** D47 S5 §1.3 — has `refresh()` run at least once this process lifetime? Used by `auth.getGateSnapshot`'s lazy latch. */
  hasRefreshed(): boolean {
    return this.refreshed;
  }

  /** Returns the unsubscribe function. */
  onChange(callback: (state: AuthState) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * D47 S5 §3 I9 checkpoint ① — synchronous, called as the very first step of
   * `performLogoutSequence()`, strictly before `terminateAllSessions()`
   * (checkpoint ②). See the `logoutInProgress` field comment for why this is
   * a separate latch instead of eagerly mutating `snapshot`.
   */
  beginLogout(): void {
    this.logoutInProgress = true;
  }

  /** Spawn-gate predicate (D47 S5 §3): true only while genuinely `authenticated` and no logout is mid-flight. Callers still need to check `managed`/`skipAuthGate` themselves — see `resolveSpawnGateDecision` (`@shared/authGate`), which folds this in. */
  isAuthenticatedForSpawn(): boolean {
    return !this.logoutInProgress && this.snapshot.status === 'authenticated';
  }

  /**
   * D47 S5 §2 — `markRejected()` orchestration (B-track B5): flips the
   * vault's `invalidatedAt` (plaintext layer only, payload untouched),
   * invalidates every Pi worker generation before `refresh()`s — which
   * re-derives `credentials_invalid: rejected` from the now-invalidated
   * vault and broadcasts exactly once (value changed).
   */
  async markRejected(): Promise<void> {
    const iso = this.now().toISOString();
    await this.vault.markInvalidated(iso);
    await this.runtimeInvalidator.invalidateAll();
    this.refresh();
  }

  /**
   * D47 S5 §2 — "`remoteHealth` unknown→valid 由下次 probe 200 恢复": bumps
   * the CACHED `authenticated` snapshot's `remoteHealth` without a vault
   * re-read (a successful probe response carries no new vault bytes to
   * read). No-op outside `authenticated` or when already `valid`. Every
   * subsequent `refresh()` resets to `'unknown'` — `mapVaultResultToAuthState`
   * always derives a fresh `'unknown'` off `status:'ok'` — so only the
   * probe's own success re-elevates it.
   */
  reportRemoteHealthy(): void {
    if (this.snapshot.status !== 'authenticated' || this.snapshot.remoteHealth === 'valid') {
      return;
    }
    const next: AuthState = { ...this.snapshot, remoteHealth: 'valid' };
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}
