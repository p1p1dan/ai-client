/**
 * D47 S2a §1 — the single source of truth for "which env vars carry
 * credential material that must never leak across a managed-home redirect".
 *
 * Two independent consumers import this file directly (not a copy):
 *   - `scripts/dev.js` (plain Node ESM) strips these from the inherited
 *     shell env before spawning the Electron dev child process.
 *   - `src/main/index.ts` strips these from Main's own `process.env` before
 *     setting `CLAUDE_CONFIG_DIR` to the managed `claude-home` directory, so
 *     a host-OS credential (e.g. the developer's own `ANTHROPIC_API_KEY`)
 *     can't shadow the managed credentials written into the redirected home.
 *
 * A vitest asserts both call sites resolve to the exact same list (no
 * copy-paste drift) — see `scripts/__tests__/credential-env-keys.test.mjs`.
 */

/** Every env var starting with this prefix is credential-shaped. */
export const CREDENTIAL_ENV_PREFIX = 'ANTHROPIC_';

/** Exact-match credential-shaped env vars outside the ANTHROPIC_ prefix. */
export const CREDENTIAL_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUD_ML_REGION',
];

/** True when `key` should be stripped from an inherited env before a managed redirect. */
export function isCredentialEnvKey(key) {
  return key.startsWith(CREDENTIAL_ENV_PREFIX) || CREDENTIAL_ENV_KEYS.includes(key);
}
