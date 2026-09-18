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
      reason: 'rejected' | 'corrupt' | 'decrypt_failed' | 'migration_incomplete';
      lastEmail: string | null;
    }
  // Keyring/session not yet unlocked — TEMPORARY, never folded into
  // signed_out (that would force a re-login for a merely-locked keyring,
  // breaking the S2 "保字节" contract). Root renders a LoadingShell and
  // retries; the spawn gate rejects but with locked-specific copy.
  | { status: 'locked'; lastEmail: string | null };

export type AuthStateStatus = AuthState['status'];

/**
 * Result of `auth:requestSignIn` — "leave whatever this run entered on and put
 * the sign-in screen back in front of me".
 *
 * `reason` is a CODE rather than a sentence for the same reason
 * `deriveUserProfilePresentation` returns no copy: the renderer owns the i18n
 * lookup, and literal UI strings stay out of Main/shared (src/shared/i18n.ts
 * convention).
 *
 * `credentials-unresolved` is the one refusal there is. `deriveWelcomeEntry`
 * returns `null` for `locked`/`unknown`, which routes to a spinner — so
 * dropping the entry latch in either of those states would strand the user on
 * a blank loading screen with no way back. The request is refused instead and
 * the caller says "try again in a moment".
 */
export type AuthSignInRequestResult =
  | { ok: true }
  | { ok: false; reason: 'credentials-unresolved' };
