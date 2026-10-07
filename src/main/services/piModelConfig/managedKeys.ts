/**
 * dsh-rebase P1-5e (decisions 038, 149, 152) — administrator keys stay out of
 * `managed-models-source.json`.
 *
 * The management endpoint may hand a provider its own key (`credentials.apiKey:
 * 'managed'` plus `apiKey`). The wire-form cache used to keep that key in the
 * clear; now the cache keeps only the statement that the key is managed, and
 * the key itself goes to the credential vault, protected like every other key
 * the user has. These are the two pure halves of that split; the service does
 * the I/O.
 */

import type { PiManagedModelsConfig, PiManagedProviderDefinition } from '@shared/piModelConfig';

/**
 * Where the administrator keys are kept: the credential vault in production
 * (`index.ts`), a fake in tests.
 */
export interface ManagedKeyStore {
  /** Keys by provider id, or `null` when the store cannot be read right now. */
  read(): Readonly<Record<string, string>> | null;
  /** Replace the whole set; an empty set removes it. `false` when nothing was stored. */
  replace(keys: Readonly<Record<string, string>>): Promise<boolean>;
}

/**
 * The store a service gets when none is injected: holds nothing, stores
 * nothing. Fails closed — a managed provider is left out rather than its key
 * written anywhere else.
 */
export const NO_MANAGED_KEY_STORE: ManagedKeyStore = {
  read: () => ({}),
  replace: async () => false,
};

function isManagedKey(provider: PiManagedProviderDefinition): boolean {
  return provider.credentials?.apiKey === 'managed';
}

/**
 * Split a catalog into the document that may go to disk and the keys that go
 * to the vault. Every `apiKey` leaves the document; `credentials` stays, so the
 * cache still says which providers carry an administrator key.
 */
export function detachManagedKeys(config: PiManagedModelsConfig): {
  document: PiManagedModelsConfig;
  keys: Record<string, string>;
} {
  const providers: Record<string, PiManagedProviderDefinition> = {};
  const keys: Record<string, string> = {};
  for (const [providerId, provider] of Object.entries(config.providers)) {
    const { apiKey, ...rest } = provider;
    if (apiKey && isManagedKey(provider)) keys[providerId] = apiKey;
    providers[providerId] = rest;
  }
  return { document: { ...config, providers }, keys };
}

/**
 * Put the keys back on a cached document.
 *
 * A managed provider with no key is left out, not kept with an empty one: the
 * wire rule is that "managed without a key" is a credential violation
 * (`configValidation.ts`), and a provider that can never authenticate does not
 * belong in a menu. The other providers are unaffected — one lost key must not
 * cost the user the whole catalog.
 */
export function attachManagedKeys(
  document: PiManagedModelsConfig,
  keys: Readonly<Record<string, string>>
): { config: PiManagedModelsConfig; missing: string[] } {
  const providers: Record<string, PiManagedProviderDefinition> = {};
  const missing: string[] = [];
  for (const [providerId, provider] of Object.entries(document.providers)) {
    if (!isManagedKey(provider)) {
      providers[providerId] = provider;
      continue;
    }
    const apiKey = provider.apiKey || keys[providerId];
    if (apiKey) providers[providerId] = { ...provider, apiKey };
    else missing.push(providerId);
  }
  return { config: { ...document, providers }, missing };
}
