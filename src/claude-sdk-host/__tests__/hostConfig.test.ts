import { describe, expect, it } from 'vitest';
import { buildHostConfig } from '../hostConfig.ts';

/**
 * Route B S-3 (topic s3-project-config.md K-1): the CLI is configured with the
 * host's auth proxy and its session token only. The gateway key is in no part
 * of what the CLI is handed (its environment, its command-line settings); the
 * host keeps it only to redact it.
 */

const KEY = 'sk-fake-hostconfig-gateway-key';
const TOKEN = 'sk-pilab-session-00112233445566778899aabbccddeeff0011223344556677';

describe('buildHostConfig', () => {
  const { config } = buildHostConfig({
    inherited: {
      Path: 'C:Windows',
      ANTHROPIC_API_KEY: KEY,
      AICLIENT_CLAUDE_SDK_BASE_URL: 'https://gw',
    },
    configDir: 'D:stateclaude-sdk-home',
    settingSources: ['project'],
    apiKey: KEY,
    proxy: { url: 'http://127.0.0.1:50123', token: TOKEN },
  });

  it('hands the CLI the proxy and the token, never the key', () => {
    expect(config.cliEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:50123');
    expect(config.cliEnv.ANTHROPIC_API_KEY).toBe(TOKEN);
    expect(JSON.stringify(config.cliEnv)).not.toContain(KEY);
  });

  it('pins the proxy and the token in the flag tier, never the key', () => {
    expect(config.settingsEnv.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:50123');
    expect(config.settingsEnv.ANTHROPIC_API_KEY).toBe(TOKEN);
    expect(JSON.stringify(config.settingsEnv)).not.toContain(KEY);
  });

  it('redacts both the key and the token', () => {
    expect(config.secrets).toEqual([KEY, TOKEN]);
  });
});
