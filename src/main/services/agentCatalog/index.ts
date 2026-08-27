/**
 * D48 S2 §4.1 — the only file in `services/agentCatalog` allowed to import
 * `electron`, mirroring the `services/auth/index.ts` split: the service itself is
 * pure and takes `fetch` + credentials as constructor input, and this module
 * supplies the real `net.fetch` and the real vault, lazily.
 *
 * Lazy because ESM imports hoist ahead of `app.setPath('userData', …)`; a
 * module-scope singleton would capture the pre-override paths (the defect
 * `getCredentialVault()` documents).
 */

import { net } from 'electron';
import { getAuthStateService, getCredentialVault } from '../auth';
import { resolveManagedCredentialsEnabled } from '../auth/credentialMode';
import { type AgentCatalogCredentials, AgentCatalogService } from './AgentCatalogService';

/**
 * The vault snapshot, or nothing — with NO legacy fallback.
 *
 * `UsageService` still reads `~/.codex/auth.json` on the flag-off path for
 * backwards compatibility; this service deliberately does not. D47 S6 stopped
 * dual-writing that file, so it can hold a stale or since-rejected key, and the
 * consequence here would be a model menu authenticated with a credential the
 * user has already replaced. "No credentials" is a supported state with a
 * defined answer (the seed table), so the safe branch costs nothing.
 */
function readCatalogCredentials(): AgentCatalogCredentials {
  if (!resolveManagedCredentialsEnabled()) return { status: 'unavailable' };

  const authStateService = getAuthStateService();
  if (!authStateService.hasRefreshed()) authStateService.refresh();
  if (authStateService.getState().status !== 'authenticated') return { status: 'unavailable' };

  const vaultResult = getCredentialVault().read();
  // Covers `locked` (safeStorage not unlocked yet, E6) alongside every other
  // non-ok status: the caller gets the seed table and zero network traffic.
  if (vaultResult.status !== 'ok') return { status: 'unavailable' };

  const { claude, codex } = vaultResult.doc.payload;
  return { status: 'ok', vault: { claude, codex } };
}

let cachedService: AgentCatalogService | null = null;

export function getAgentCatalogService(): AgentCatalogService {
  if (!cachedService) {
    cachedService = new AgentCatalogService({
      fetchFn: (url, init) => net.fetch(url, init),
      readCredentials: readCatalogCredentials,
      log: (...args) => console.info(...args),
    });
  }
  return cachedService;
}

export { AgentCatalogService } from './AgentCatalogService';
