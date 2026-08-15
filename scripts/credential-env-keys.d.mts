/**
 * Hand-written declaration sibling for `credential-env-keys.mjs` (outside
 * `src/`, so `tsc` won't infer types from the runtime file without
 * `allowJs`). Keep in sync with the `.mjs` file by hand — it is tiny and
 * covered by `scripts/__tests__/credential-env-keys.test.mjs`.
 */

export declare const CREDENTIAL_ENV_PREFIX: string;
export declare const CREDENTIAL_ENV_KEYS: readonly string[];
export declare function isCredentialEnvKey(key: string): boolean;
