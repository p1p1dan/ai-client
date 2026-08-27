import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_ENV_KEYS,
  CREDENTIAL_ENV_PREFIX,
  isCredentialEnvKey,
} from '../credential-env-keys.mjs';

describe('credential-env-keys (D47 S2a §1 shared strip list)', () => {
  it('exposes the exact explicit key list from the spec', () => {
    expect(CREDENTIAL_ENV_PREFIX).toBe('ANTHROPIC_');
    expect(CREDENTIAL_ENV_KEYS).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'AWS_BEARER_TOKEN_BEDROCK',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'CLOUD_ML_REGION',
    ]);
  });

  it('matches every ANTHROPIC_-prefixed key', () => {
    expect(isCredentialEnvKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(isCredentialEnvKey('ANTHROPIC_AUTH_TOKEN')).toBe(true);
    expect(isCredentialEnvKey('ANTHROPIC_BASE_URL')).toBe(true);
    expect(isCredentialEnvKey('ANTHROPIC_')).toBe(true);
  });

  it('matches every explicit key exactly', () => {
    for (const key of CREDENTIAL_ENV_KEYS) {
      expect(isCredentialEnvKey(key)).toBe(true);
    }
  });

  it('does not match unrelated keys (negative control)', () => {
    expect(isCredentialEnvKey('PATH')).toBe(false);
    expect(isCredentialEnvKey('HOME')).toBe(false);
    expect(isCredentialEnvKey('AICLIENT_MANAGED_CREDENTIALS')).toBe(false);
    expect(isCredentialEnvKey('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBe(false);
    // D60: a path the user chose, not credential material. Stripping it would
    // delete a deliberate `CLAUDE_CONFIG_DIR` now that Main no longer sets one.
    expect(isCredentialEnvKey('CLAUDE_CONFIG_DIR')).toBe(false);
    // Prefix match must be a real prefix, not a substring anywhere.
    expect(isCredentialEnvKey('MY_ANTHROPIC_TOKEN')).toBe(false);
  });
});
