/**
 * The single source of truth for "which env vars carry CREDENTIAL MATERIAL
 * that must never shadow the managed credential".
 *
 * Two independent consumers import this file directly (not a copy):
 *   - `scripts/dev.js` (plain Node ESM) strips these from the inherited
 *     shell env before spawning the Electron dev child process.
 *   - `managedCredentialsStartup.ts` strips these from Main's own
 *     `process.env`, so a host-OS credential (e.g. the developer's own
 *     `ANTHROPIC_API_KEY`) can't shadow the managed one.
 *
 * ## Why `CLAUDE_CONFIG_DIR` is NOT in this list (D60)
 *
 * It used to be. That made sense while Main redirected the variable at a
 * managed claude-home: an inherited value had to be cleared out of the way of
 * the one we were about to set. D60 stopped setting it — so stripping it now
 * would DELETE a path the user chose deliberately, which is the opposite of
 * what that release is for.
 *
 * `dev.js` still clears it, because `dev.js` still sets its own isolated
 * config dir immediately afterwards. It appends the key locally, the same way
 * it already appends `AICLIENT_MANAGED_CREDENTIALS` — a consumer that is
 * about to overwrite a variable is entitled to clear it first; this shared
 * list is not the place to encode that.
 *
 * A vitest asserts both call sites resolve to the same list (no copy-paste
 * drift) — see `scripts/__tests__/credential-env-keys.test.mjs`.
 */

/** Every env var starting with this prefix is credential-shaped. */
export const CREDENTIAL_ENV_PREFIX = 'ANTHROPIC_';

/** Exact-match credential-shaped env vars outside the ANTHROPIC_ prefix. */
export const CREDENTIAL_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUD_ML_REGION',
];

/** True when `key` carries credential material and must be stripped from an inherited env. */
export function isCredentialEnvKey(key) {
  return key.startsWith(CREDENTIAL_ENV_PREFIX) || CREDENTIAL_ENV_KEYS.includes(key);
}
