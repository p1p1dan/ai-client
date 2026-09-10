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
 * The consequence is stated rather than hidden: once a user adds a service,
 * local mode stops pointing pi at `~/.pi/agent` and points it here instead —
 * which is why {@link localRouteUsesAppAgentDir} also turns on the
 * borrow-resources path, so the skills and prompt templates in the user's own
 * directory keep loading. With no user service configured, nothing changes.
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

/** Whether the local route must be pointed at this app's agent dir — see the file header. */
export function localRouteUsesAppAgentDir(): boolean {
  return readUserProvidersForRuntime().length > 0;
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
