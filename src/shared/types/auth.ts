/**
 * D47 S5 §1.1 — the single authoritative login-state DTO. Replaces the S1
 * `AuthStateService`-local 3-arm type (`signed_out|authenticated|credentials_invalid`,
 * no `lastEmail`/`email`): every producer (Main's `AuthStateService`) and every
 * consumer (Root, `MainWindow.isAppMountedFor`, `resolveGateDecision`, the spawn
 * gate, the Provider/UserProfile UI) now reads this one shape. Field name is
 * `status` everywhere in this repo (S1 as-built decision) — never `kind`.
 */
export type AuthState =
  // Renderer-only bootstrap fallback (argv snapshot missing/unparsable). Main
  // NEVER produces this — `AuthStateService.refresh()` always resolves to one
  // of the other four arms, even before the vault has been touched.
  | { status: 'unknown' }
  | { status: 'signed_out'; lastEmail: string | null }
  | { status: 'authenticated'; email: string; remoteHealth: 'unknown' | 'valid' }
  | {
      status: 'credentials_invalid';
      reason: 'rejected' | 'corrupt' | 'decrypt_failed';
      lastEmail: string | null;
    }
  // Keyring/session not yet unlocked — TEMPORARY, never folded into
  // signed_out (that would force a re-login for a merely-locked keyring,
  // breaking the S2 "保字节" contract). Root renders a LoadingShell and
  // retries; the spawn gate rejects but with locked-specific copy.
  | { status: 'locked'; lastEmail: string | null };

export type AuthStateStatus = AuthState['status'];
