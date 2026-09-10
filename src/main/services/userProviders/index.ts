/**
 * H/17 L2 wiring — the `electron`-facing half of the user-added service group.
 *
 * ## Why the derived files are never written into `~/.pi/agent`
 *
 * Local mode's whole promise is "Pi reads YOUR configuration". That directory
 * belongs to the user and may hold a `models.json` they maintain by hand;
 * merging our providers into it would overwrite their file. So the derived
 * `models.json` / `auth.json` go into this app's own agent directory, and the
 * user's directory is only ever read.
 *
 * H/17 made that a CONDITIONAL move: local mode left `~/.pi/agent` only once a
 * service existed. H/19 removed the condition — both modes always run out of
 * this app's directory — so nothing in this module decides where pi points any
 * more. What the user had in their own directory is brought over once, on
 * request, by `services/agentMigration`.
 */

import { net } from 'electron';
import { getCredentialVault } from '../auth';
import type { UserProvider } from '../auth/CredentialVault';
import { UserProviderService, type UserProviderStore } from './UserProviderService';

/**
 * The vault, narrowed to what the service needs.
 *
 * `encryptionAvailable` probes by writing nothing: it asks the vault whether a
 * save would encrypt, which is the question the settings page renders.
 */
function vaultStore(): UserProviderStore {
  const vault = getCredentialVault();
  return {
    readUserProviders: () => vault.readUserProviders(),
    saveUserProviders: (providers) => vault.saveUserProviders(providers),
    encryptionAvailable: () => vault.encryptionAvailable(),
  };
}

/**
 * Every user service currently stored, or an empty list when the group cannot
 * be read.
 *
 * Empty-on-failure is right HERE and wrong in `UserProviderService.requireList`:
 * this feeds a file writer, where "write no user providers this time" is a
 * recoverable omission the next successful read repairs, while a mutation
 * starting from a wrongly-empty list would persist the deletion.
 */
export function readUserProvidersForRuntime(): readonly UserProvider[] {
  const read = getCredentialVault().readUserProviders();
  return read.status === 'ok' ? read.providers.filter((provider) => provider.enabled) : [];
}

let cached: UserProviderService | null = null;

export function getUserProviderService(): UserProviderService {
  if (!cached) {
    cached = new UserProviderService({
      store: vaultStore(),
      fetchFn: async (url, init) => {
        const response = await net.fetch(url, { headers: init.headers });
        return {
          ok: response.ok,
          status: response.status,
          json: () => response.json(),
          text: () => response.text(),
        };
      },
      onChange: () => {
        // Lazy import: this module is reached from IPC registration at boot,
        // and `piModelConfig` pulls in the whole managed-config stack.
        void import('../piModelConfig').then(({ writeUserProviderRuntimeConfig }) =>
          writeUserProviderRuntimeConfig()
        );
      },
    });
  }
  return cached;
}

/** Test-only, mirroring `resetAuthSingletonsForTests`. */
export function resetUserProviderServiceForTests(): void {
  cached = null;
}

export { UserProviderService } from './UserProviderService';
