/**
 * D47 S1 §2.4 — the login-state state machine. Pure module: it is handed a
 * vault-like object (duck-typed against `CredentialVault`, type-only import)
 * and computes one of the three states from mother-spec §4's judgment table.
 *
 * S1 wires nothing into IPC or the renderer (mother spec §1 "不做"): this
 * class exists so the mapping and the flag-off zero-IO guarantee are
 * independently testable ahead of S5, when Root/MainWindow actually read it.
 */

import type { VaultReadResult } from './CredentialVault';

export const MANAGED_CREDENTIALS_FLAG_ENV = 'AICLIENT_MANAGED_CREDENTIALS';

/**
 * Strict `'1'` only (S1 spec §2.6) — every other spelling, including a
 * shell-inherited truthy-looking value, must read as off. Read per call, not
 * captured at module load, matching `resolveCodexEnabled`'s convention
 * (`agentSupport.ts`) so tests can flip positions without re-importing.
 */
export function resolveManagedCredentialsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MANAGED_CREDENTIALS_FLAG_ENV] === '1';
}

export type SignedOutReason = 'never' | 'logout';
export type CredentialsInvalidReason = 'corrupt' | 'decrypt_failed';
export type RemoteHealth = 'unknown' | 'valid';

export type AuthState =
  | { status: 'signed_out'; reason: SignedOutReason }
  | { status: 'authenticated'; remoteHealth: RemoteHealth }
  | { status: 'credentials_invalid'; reason: CredentialsInvalidReason };

export interface AuthStateVault {
  read(): VaultReadResult;
}

export interface AuthStateServiceOptions {
  vault: AuthStateVault;
  env?: NodeJS.ProcessEnv;
}

const SIGNED_OUT_NEVER: AuthState = { status: 'signed_out', reason: 'never' };

/**
 * S1 spec §2.4: `locked`/`unsupported` fold into `signed_out` — a temporary
 * keyring lock or a schema this build cannot read is not "invalid
 * credentials", it is "cannot tell right now" (S5 gives it a distinct UI
 * treatment). Only a truly broken payload (`malformed_json`/`schema_invalid`
 * → `corrupt`, `decrypt_failed` → `decrypt_failed`) is `credentials_invalid`.
 */
function mapVaultResultToAuthState(result: VaultReadResult): AuthState {
  switch (result.status) {
    case 'ok':
      return { status: 'authenticated', remoteHealth: 'unknown' };
    case 'absent':
    case 'locked':
    case 'unsupported':
      return SIGNED_OUT_NEVER;
    case 'invalid':
      return {
        status: 'credentials_invalid',
        reason: result.reason === 'decrypt_failed' ? 'decrypt_failed' : 'corrupt',
      };
  }
}

export class AuthStateService {
  private readonly vault: AuthStateVault;
  private readonly env?: NodeJS.ProcessEnv;
  private snapshot: AuthState = SIGNED_OUT_NEVER;
  private readonly listeners = new Set<(state: AuthState) => void>();

  constructor(options: AuthStateServiceOptions) {
    this.vault = options.vault;
    this.env = options.env;
  }

  /** Cache-only, never touches disk — safe to call on every render/query. */
  getState(): AuthState {
    return this.snapshot;
  }

  /**
   * Recomputes the snapshot and notifies every subscriber exactly once. Flag
   * off short-circuits BEFORE `vault.read()` is called — zero filesystem IO
   * is a hard requirement (S1 spec §2.4), not just a fast path.
   */
  refresh(): AuthState {
    const enabled = resolveManagedCredentialsEnabled(this.env ?? process.env);
    const next = enabled ? mapVaultResultToAuthState(this.vault.read()) : SIGNED_OUT_NEVER;
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener(next);
    }
    return next;
  }

  /** Returns the unsubscribe function. */
  onChange(callback: (state: AuthState) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
}
