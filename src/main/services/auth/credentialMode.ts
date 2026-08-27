/**
 * The electron-reading half of the credential-mode rule (D64 / S3).
 *
 * The rule itself is pure and lives in `@shared/credentialMode`; this reads the
 * two real inputs it needs — the app's own `settings.json` and `app.isPackaged`
 * — and owns writing a new choice down.
 *
 * ## Why this is its own module rather than a function on `AuthStateService`
 *
 * That is where `resolveManagedCredentialsEnabled` lived, and it could, because
 * the answer came from an environment variable. It no longer does: the answer
 * needs `SharedSessionState`, which needs `electron`. `AuthStateService` is a
 * documented pure module (it is handed a vault-like object and computes a
 * state), and `adoption.ts` is one whose purity is asserted by a static import
 * scan. Reaching for settings from either would have quietly ended that.
 *
 * So the electron dependency sits here, and the two pure modules take the
 * resolved mode as an INPUT from the caller that already has it.
 */

import {
  CREDENTIAL_MODE_SETTING_KEY,
  type CredentialMode,
  resolveCredentialMode,
} from '@shared/credentialMode';
import { app } from 'electron';
import { readSharedSettings, writeSharedSettings } from '../SharedSessionState';

export { CREDENTIAL_MODE_SETTING_KEY, type CredentialMode };

/**
 * Read per call, never cached here.
 *
 * `SharedSessionState` already memoises the parsed file and invalidates that
 * memo on write, so a second cache would only add a way for the two to
 * disagree. Reading fresh is also what makes a mode change take effect on the
 * next spawn without a restart — see `applyCredentialMode`.
 */
export function getCredentialMode(): CredentialMode {
  return resolveCredentialMode({ settings: readSharedSettings, isPackaged: app.isPackaged });
}

/**
 * The boolean 21 call sites across 15 files already ask for.
 *
 * Kept as a boolean rather than migrating every one of them to the two-arm
 * union: every existing reader genuinely asks a yes/no question ("do I inject
 * our credential"), and widening them all would be a large mechanical change
 * with no behaviour attached. New readers that care about the DISTINCTION
 * should call `getCredentialMode()`.
 */
export function resolveManagedCredentialsEnabled(): boolean {
  return getCredentialMode() === 'managed';
}

/**
 * Record a choice.
 *
 * Merged into the existing settings rather than replacing them — this file also
 * holds the user's own preferences and the onboarding state, and S2 put the
 * credential vault in the same directory. A whole-file write here would be one
 * misordered call away from erasing all of it.
 *
 * Returns whether the value actually changed, so the caller can skip the Host
 * restart when it did not.
 */
export function setCredentialMode(mode: CredentialMode): boolean {
  const settings = readSharedSettings();
  if (settings[CREDENTIAL_MODE_SETTING_KEY] === mode) return false;
  writeSharedSettings({ ...settings, [CREDENTIAL_MODE_SETTING_KEY]: mode });
  return true;
}
