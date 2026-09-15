/**
 * P5-5 — the decision of whether a native worker gets a catalog at all.
 *
 * ## Why this is its own module rather than a body inside `index.ts`
 *
 * import-catalog-12: this layer had no tests. `index.ts` is the `electron`
 * wiring — it reaches for `app`, `net`, the app state root and the credential
 * vault at import time — so testing the decision through it means mocking four
 * modules to exercise three `if`s. The rule itself needs none of that: it needs
 * two yes/no signals and a builder. Those are parameters here, and `index.ts`
 * supplies the real ones.
 */

import type { UserProvider } from '../auth/CredentialVault';

/** The shape `worker.bootstrap` carries: `models.json` and `auth.json`, in memory. */
export interface NativeModelCatalog {
  models: Record<string, unknown>;
  auth: Record<string, unknown>;
}

export interface NativeModelCatalogDeps {
  /** Whether this installation is on the managed route (`auth/credentialMode`). */
  managedCredentialsEnabled: () => boolean;
  /** The login credentials every inheriting provider gets, or `null` if unreadable. */
  managedCredential: () => { apiKey: string; baseUrl: string } | null;
  /** The user's own services, with the vault's verdict attached. */
  readUserProviderGroup: () => { readable: boolean; providers: readonly UserProvider[] };
  buildCatalog: (input: {
    inheritedApiKey: string;
    inheritedBaseUrl: string;
    userProviders: readonly UserProvider[];
  }) => NativeModelCatalog;
  warn: (...args: unknown[]) => void;
}

/**
 * The catalog to hand a native worker, or `undefined` to let it read the agent
 * directory the way it always could.
 *
 * `undefined` is the safe answer, and the three cases below are all the same
 * one: we could not assemble a catalog we are sure is COMPLETE, and an
 * incomplete catalog is worse than the files the last successful write left on
 * disk — it silently replaces them for the life of the session.
 *
 * import-catalog-02 — the third case used to be the only one, and it could not
 * fire: the managed half comes from an ordinary file read that does not touch
 * the keyring, so a locked vault still produced a non-empty provider list. What
 * the worker got was that list with an EMPTY key and the user's entire service
 * group missing, on a machine whose `auth.json` held a working key all along.
 */
export function resolveNativeModelCatalogWith(
  deps: NativeModelCatalogDeps
): NativeModelCatalog | undefined {
  try {
    const credential = deps.managedCredential();
    // A managed installation with no readable login credential cannot fill in
    // the address or the key of any provider that inherits them. On the local
    // route there is nothing to inherit, so a null credential is the normal
    // state and says nothing about whether the vault can be read.
    if (deps.managedCredentialsEnabled() && !credential) return undefined;

    const group = deps.readUserProviderGroup();
    if (!group.readable) return undefined;

    const catalog = deps.buildCatalog({
      inheritedApiKey: credential?.apiKey ?? '',
      inheritedBaseUrl: credential?.baseUrl ?? '',
      userProviders: group.providers,
    });
    // Nothing to hand over: no managed catalog has ever been fetched, no
    // snapshot shipped, and the user has added nothing.
    const providers = catalog.models.providers;
    const count =
      providers && typeof providers === 'object' ? Object.keys(providers as object).length : 0;
    return count > 0 ? catalog : undefined;
  } catch (error) {
    deps.warn('[pi-models] failed to assemble the native model catalog', error);
    return undefined;
  }
}
