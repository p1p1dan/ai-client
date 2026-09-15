import { describe, expect, it, vi } from 'vitest';
import type { UserProvider } from '../../auth/CredentialVault';
import { type NativeModelCatalogDeps, resolveNativeModelCatalogWith } from '../nativeCatalog';

/**
 * import-catalog-12 — the layer that decides whether a native worker gets a
 * catalog at all had no test of any kind. Deleting the `try`/`catch` or turning
 * `length > 0` into `length >= 0` left the whole suite green.
 *
 * import-catalog-02 — and the rule it was supposed to implement ("a locked
 * keyring means fall back to the file on disk") was never reachable: the
 * managed half is an ordinary file read, so the provider list stayed non-empty
 * no matter what the vault said.
 */

const userProvider: UserProvider = {
  id: '3f2a9c11-0000-4000-8000-000000000000',
  name: 'My DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  api: 'openai-completions',
  apiKey: 'USER-KEY',
  enabled: true,
  createdAt: '2026-09-10T00:00:00.000Z',
};

/**
 * A healthy managed installation, with a note of what the builder was handed.
 *
 * The managed half is stated as a plain object rather than built: this module's
 * job is to decide whether to deliver, and `PiModelConfigService` has its own
 * tests for what the delivered documents contain.
 */
function deps(overrides: Partial<NativeModelCatalogDeps> = {}): {
  deps: NativeModelCatalogDeps;
  seen: Array<{ inheritedApiKey: string; userProviders: readonly UserProvider[] }>;
  warn: ReturnType<typeof vi.fn>;
} {
  const seen: Array<{ inheritedApiKey: string; userProviders: readonly UserProvider[] }> = [];
  const warn = vi.fn();
  return {
    seen,
    warn,
    deps: {
      managedCredentialsEnabled: () => true,
      managedCredential: () => ({ apiKey: 'login-key', baseUrl: 'https://cch.example/v1' }),
      readUserProviderGroup: () => ({ readable: true, providers: [userProvider] }),
      buildCatalog: (input) => {
        seen.push({ inheritedApiKey: input.inheritedApiKey, userProviders: input.userProviders });
        return {
          models: { providers: { dan: {}, 'my-deepseek': {} } },
          auth: { dan: { type: 'api_key', key: input.inheritedApiKey } },
        };
      },
      warn,
      ...overrides,
    },
  };
}

describe('resolveNativeModelCatalogWith (P5-5 / import-catalog-12)', () => {
  it('hands over the catalog when the vault answers both questions', () => {
    const { deps: d, seen } = deps();
    const catalog = resolveNativeModelCatalogWith(d);
    expect(catalog?.models).toEqual({ providers: { dan: {}, 'my-deepseek': {} } });
    // The group this module read is the group the builder used — not a second
    // read of the same vault, which could answer differently.
    expect(seen[0]?.userProviders).toEqual([userProvider]);
    expect(seen[0]?.inheritedApiKey).toBe('login-key');
  });

  it('falls back to the file on disk when the login credential is unreadable', () => {
    // import-catalog-02: this is the locked-keyring case, and it used to deliver
    // a catalog whose every inheriting provider carried an empty key.
    const { deps: d, seen } = deps({ managedCredential: () => null });
    expect(resolveNativeModelCatalogWith(d)).toBeUndefined();
    // Asserting `undefined` rather than "the provider was dropped": T007 makes
    // an empty-key provider disappear from the catalog later on, so the visible
    // symptom would be a vanished provider, not a delayed auth error. The fix
    // is to never assemble that catalog in the first place.
    expect(seen).toHaveLength(0);
  });

  it('falls back to the file on disk when the user group cannot be read', () => {
    // A `locked` or `invalid` vault. Delivering here would hand the worker a
    // catalog with the user's whole service group missing for the session.
    const { deps: d } = deps({
      readUserProviderGroup: () => ({ readable: false, providers: [] }),
    });
    expect(resolveNativeModelCatalogWith(d)).toBeUndefined();
  });

  it('delivers on the local route, where a null login credential is normal', () => {
    // Nothing is inherited here, so "no managed credential" is the expected
    // state rather than a failed read — gating on it would send every local
    // installation down the disk fallback forever.
    const { deps: d, seen } = deps({
      managedCredentialsEnabled: () => false,
      managedCredential: () => null,
      buildCatalog: (input) => {
        seen.push({ inheritedApiKey: input.inheritedApiKey, userProviders: input.userProviders });
        return { models: { providers: { 'my-deepseek': {} } }, auth: {} };
      },
    });
    expect(resolveNativeModelCatalogWith(d)?.models).toEqual({
      providers: { 'my-deepseek': {} },
    });
    expect(seen[0]?.inheritedApiKey).toBe('');
  });

  it('hands over nothing when there are no providers at all', () => {
    const { deps: d } = deps({
      readUserProviderGroup: () => ({ readable: true, providers: [] }),
      buildCatalog: () => ({ models: { providers: {} }, auth: {} }),
    });
    expect(resolveNativeModelCatalogWith(d)).toBeUndefined();
  });

  it('warns and falls back when assembling throws', () => {
    const { deps: d, warn } = deps({
      buildCatalog: () => {
        throw new Error('models.json is not readable');
      },
    });
    expect(resolveNativeModelCatalogWith(d)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('native model catalog');
  });
});
