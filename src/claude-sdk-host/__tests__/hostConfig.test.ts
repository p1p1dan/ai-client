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

  it('S-3: keeps the setting sources, and a home directory only when one is given', () => {
    expect(config.settingSources).toEqual(['project']);
    expect(config).not.toHaveProperty('homeDir');
    const withHome = buildHostConfig({
      inherited: {},
      configDir: 'D:stateclaude-sdk-home',
      settingSources: ['project', 'local'],
      apiKey: KEY,
      homeDir: 'D:fakehome',
      proxy: { url: 'http://127.0.0.1:50123', token: TOKEN },
    }).config;
    expect(withHome.settingSources).toEqual(['project', 'local']);
    expect(withHome.homeDir).toBe('D:fakehome');
  });

  it('reads the catalog windows Main passed, and has none when Main passed none (user 2026-10-18)', () => {
    expect(config).not.toHaveProperty('modelWindows');
    const windowed = buildHostConfig({
      inherited: {
        AICLIENT_CLAUDE_SDK_MODEL_WINDOWS: JSON.stringify({
          'claude-opus-5-5': 200_000,
          broken: 'x',
        }),
      },
      configDir: 'D:stateclaude-sdk-home',
      settingSources: ['project'],
      apiKey: KEY,
      proxy: { url: 'http://127.0.0.1:50123', token: TOKEN },
    }).config;
    expect(windowed.modelWindows).toEqual({ 'claude-opus-5-5': 200_000 });
    // The CLI's environment does not carry Main's variable.
    expect(windowed.cliEnv).not.toHaveProperty('AICLIENT_CLAUDE_SDK_MODEL_WINDOWS');
  });

  it('hands the CLI Main’s auto-compact percentage, 60 when absent or malformed (user 2026-10-23)', () => {
    expect(config.cliEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('60');
    expect(config.settingsEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('60');
    const percentOf = (raw: string) =>
      buildHostConfig({
        inherited: { AICLIENT_CLAUDE_SDK_AUTO_COMPACT_PERCENT: raw },
        configDir: 'D:stateclaude-sdk-home',
        settingSources: ['project'],
        apiKey: KEY,
        proxy: { url: 'http://127.0.0.1:50123', token: TOKEN },
      }).config;
    const set = percentOf('70');
    expect(set.cliEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('70');
    expect(set.settingsEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('70');
    expect(set.cliEnv).not.toHaveProperty('AICLIENT_CLAUDE_SDK_AUTO_COMPACT_PERCENT');
    for (const raw of ['5', '101', '55.5', 'x', ''])
      expect(percentOf(raw).cliEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, raw).toBe('60');
  });
});

/**
 * Dsh-rebase decision 196 rule 7: the CLI and its children see the product
 * proxy for the schemes the launch environment did not name, as a DSH tool
 * does; with it off, exactly what they saw before.
 */
describe('buildHostConfig with the product proxy (decision 196)', () => {
  const PRODUCT = 'http://pi%20lab:pr0xy-secret-word@proxy.corp:8080';
  const base = {
    configDir: 'D:stateclaude-sdk-home',
    settingSources: ['project'] as const,
    apiKey: KEY,
    proxy: { url: 'http://127.0.0.1:50123', token: TOKEN },
  };
  const build = (
    inherited: NodeJS.ProcessEnv,
    outboundProxy?: { url: string; noProxy: string } | null
  ) =>
    buildHostConfig({
      ...base,
      settingSources: [...base.settingSources],
      inherited: { Path: 'C:Windows', ...inherited },
      ...(outboundProxy !== undefined ? { outboundProxy } : {}),
    });

  it('on: the CLI gets the product proxy, loopback bypassed, and Node children honour it', () => {
    const { config, credentialedProxies } = build({}, { url: PRODUCT, noProxy: '.corp' });
    expect(config.cliEnv.HTTPS_PROXY).toBe(PRODUCT);
    expect(config.cliEnv.http_proxy).toBe(PRODUCT);
    expect(config.cliEnv.NO_PROXY).toBe('.corp,localhost,127.0.0.1,::1,[::1]');
    expect(config.cliEnv.NODE_USE_ENV_PROXY).toBe('1');
    // Credentials never go on the CLI's command line (the flag tier): left unpinned, named.
    expect(credentialedProxies).toEqual(['HTTP_PROXY', 'HTTPS_PROXY']);
    expect(JSON.stringify(config.settingsEnv)).not.toContain('pr0xy-secret-word');
    expect(config.settingsEnv.NO_PROXY).toBe('.corp,localhost,127.0.0.1,::1,[::1]');
    // And the password is blanked out of whatever the CLI prints.
    expect(config.secrets).toEqual([KEY, TOKEN, PRODUCT, 'pr0xy-secret-word']);
  });

  it('on, without credentials: pinned in the flag tier like any proxy', () => {
    const { config, credentialedProxies } = build(
      {},
      { url: 'http://proxy.corp:8080', noProxy: '' }
    );
    expect(credentialedProxies).toEqual([]);
    expect(config.settingsEnv.HTTPS_PROXY).toBe('http://proxy.corp:8080');
    expect(config.settingsEnv.http_proxy).toBe('http://proxy.corp:8080');
  });

  it('keeps a scheme the launch environment named, and its NO_PROXY entries', () => {
    const { config } = build(
      { HTTPS_PROXY: 'http://own:3128', NO_PROXY: '.intra' },
      { url: 'http://proxy.corp:8080', noProxy: '' }
    );
    expect(config.cliEnv.HTTPS_PROXY).toBe('http://own:3128');
    expect(config.cliEnv.HTTP_PROXY).toBe('http://proxy.corp:8080');
    expect(config.cliEnv.NO_PROXY).toBe('.intra,localhost,127.0.0.1,::1,[::1]');
  });

  it('off, SOCKS, or Main keeping the engines off it: the CLI sees only what it inherited', () => {
    const inherited = { HTTPS_PROXY: 'http://own:3128' };
    const before = build(inherited).config.cliEnv;
    expect(build(inherited, null).config.cliEnv).toEqual(before);
    expect(build(inherited, { url: 'socks5://127.0.0.1:1080', noProxy: '' }).config.cliEnv).toEqual(
      before
    );
    expect(before).not.toHaveProperty('NODE_USE_ENV_PROXY');
    expect(before.HTTP_PROXY).toBeUndefined();
  });
});
