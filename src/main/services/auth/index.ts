/**
 * D47 S1 §1 — the ONLY place in `services/auth` allowed to import `electron`.
 * `CredentialVault.ts` / `AuthStateService.ts` / `redact.ts` are pure and take
 * everything as constructor input; this module supplies the real
 * `app.getPath('userData')` root and the real `safeStorage` adapter, both
 * lazily.
 *
 * ## Why `getCredentialVault()` is a lazy singleton factory, not a module-level const
 *
 * ESM imports are hoisted ahead of `app.setPath('userData', …)` calls, so
 * capturing `app.getPath('userData')` at module scope would read the
 * pre-override default. The real fix already lives in this repo —
 * `MainWindow.ts`'s `getStatePath()` calls `app.getPath` inside the function,
 * not at import time — this factory follows the same shape (A-track B1).
 */

import { net, safeStorage } from 'electron';
import { getCredentialsDir } from '../appStatePaths';
import { type AuthProbeFetchResponse, AuthProbeScheduler } from './AuthProbeScheduler';
import { AuthStateService } from './AuthStateService';
import { getMigrationIncompleteSignal } from './adoption';
import { CredentialVault, type VaultCrypto } from './CredentialVault';
import { resolveManagedCredentialsEnabled } from './credentialMode';

/** Placeholder adapter the vault starts with — `save()` refuses until `promoteVaultCrypto` swaps this out. */
const inertCrypto: VaultCrypto = {
  available: () => false,
  encrypt: () => {
    throw new Error('[auth] encrypt called before crypto promotion');
  },
  decrypt: () => {
    throw new Error('[auth] decrypt called before crypto promotion');
  },
};

function createSafeStorageCrypto(): VaultCrypto {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plainText) => safeStorage.encryptString(plainText).toString('base64'),
    decrypt: (cipherText) => safeStorage.decryptString(Buffer.from(cipherText, 'base64')),
  };
}

let cachedVault: CredentialVault | null = null;
let cachedAuthStateService: AuthStateService | null = null;

/**
 * S2 moved the vault out of `<userData>/credentials` and into
 * `~/.pilab/<profile>/credentials` — the user's ruling that our own files
 * belong in our own directory, not in Electron's. `getCredentialsDir()` keeps
 * the per-install isolation `<userData>`'s `-dev` suffix used to give for
 * free; `appStateMigration.ts` carries an existing vault across so nobody is
 * asked to log in again. Still lazy, for the same reason as before: the root
 * depends on `app.setPath('userData', …)`, which runs after imports.
 */
export function getCredentialVault(): CredentialVault {
  if (!cachedVault) {
    cachedVault = new CredentialVault({ baseDir: getCredentialsDir(), crypto: inertCrypto });
  }
  return cachedVault;
}

/**
 * D47 S5 §2 — credential rejection invalidates all live Pi workers before the
 * refreshed auth state becomes visible. Dynamic import keeps Electron worker
 * process dependencies out of pure auth tests.
 */
async function invalidateRealWorkers(): Promise<void> {
  const { workerManager } = await import('../agent-host/WorkerManager');
  await workerManager.invalidateAll();
}

export function getAuthStateService(): AuthStateService {
  if (!cachedAuthStateService) {
    cachedAuthStateService = new AuthStateService({
      vault: getCredentialVault(),
      // D64/S3 — a getter, not a captured boolean: the mode is a user setting
      // now, and a login (or the login page) can change it while this
      // singleton is alive.
      managed: resolveManagedCredentialsEnabled,
      runtimeInvalidator: { invalidateAll: invalidateRealWorkers },
      // D47 S6 §1.4 — sourced from `adoption.ts`'s last boot-time outcome.
      migrationSignal: getMigrationIncompleteSignal,
    });
  }
  return cachedAuthStateService;
}

let cachedProbeScheduler: AuthProbeScheduler | null = null;

function toProbeFetchResponse(response: Response): AuthProbeFetchResponse {
  return { status: response.status, text: () => response.text() };
}

/**
 * D47 S5 §2 — the `AuthProbeScheduler` singleton, wired to the same
 * `net.fetch`-shaped adapter both `main/ipc/auth.ts` (the `onChange`/timer
 * bridge) and `UsageService.ts` (the "additional trigger source",
 * `reportExternalLoginResponse`) need to reach the SAME instance through —
 * two independent schedulers would each run their own singleflight/backoff
 * bookkeeping and could double-fire `markRejected()`.
 */
export function getAuthProbeScheduler(): AuthProbeScheduler {
  if (!cachedProbeScheduler) {
    cachedProbeScheduler = new AuthProbeScheduler({
      authStateService: getAuthStateService(),
      vault: getCredentialVault(),
      fetchFn: async (url, init) => toProbeFetchResponse(await net.fetch(url, init)),
    });
  }
  return cachedProbeScheduler;
}

/**
 * The promotion API (S1 spec §1/§2.2). Callers pass the real `safeStorage`
 * adapter; `createRealVaultCrypto` below is the one production callers should
 * use. Kept as a plain function taking the adapter (rather than binding
 * `safeStorage` internally) so the "browser-window-created, once" latch that
 * calls this stays in `main/index.ts`, where the rest of that event's
 * listeners already live.
 */
export function promoteVaultCrypto(crypto: VaultCrypto): void {
  getCredentialVault().promoteCrypto(crypto);
}

/** Production adapter for the promotion latch — see `promoteVaultCrypto`. */
export function createRealVaultCrypto(): VaultCrypto {
  return createSafeStorageCrypto();
}

/** Test-only: reset module state between test cases (mirrors `agentSupport.ts`'s `resetHostAgentRegistryForTests`). */
export function resetAuthSingletonsForTests(): void {
  cachedVault = null;
  cachedAuthStateService = null;
  cachedProbeScheduler?.stop();
  cachedProbeScheduler = null;
}
