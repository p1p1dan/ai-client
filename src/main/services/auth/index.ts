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

import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import { AuthStateService } from './AuthStateService';
import { CredentialVault, type VaultCrypto } from './CredentialVault';

const CREDENTIALS_DIR_NAME = 'credentials';

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

export function getCredentialVault(): CredentialVault {
  if (!cachedVault) {
    const baseDir = join(app.getPath('userData'), CREDENTIALS_DIR_NAME);
    cachedVault = new CredentialVault({ baseDir, crypto: inertCrypto });
  }
  return cachedVault;
}

export function getAuthStateService(): AuthStateService {
  if (!cachedAuthStateService) {
    cachedAuthStateService = new AuthStateService({ vault: getCredentialVault() });
  }
  return cachedAuthStateService;
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
}
