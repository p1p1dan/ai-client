import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCliEnvironment,
  buildPinnedSettingsEnv,
  findGitBash,
  hasUrlCredentials,
  withPathPrefix,
} from '../cliEnvironment.ts';

describe('buildCliEnvironment', () => {
  const inherited = {
    Path: 'C:\\Windows;G:\\Program Files\\Git\\cmd',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    ANTHROPIC_API_KEY: 'sk-inherited',
    ANTHROPIC_BASE_URL: 'https://inherited.example',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-inherited',
    CLAUDE_CODE_SESSION_ID: 'someone-elses-session',
    AWS_BEARER_TOKEN_BEDROCK: 'bedrock',
    https_proxy: 'http://proxy.local:3128',
  };

  it('keeps the allowlist and drops every inherited credential or Claude Code variable', () => {
    const env = buildCliEnvironment({
      inherited,
      configDir: 'D:\\state\\claude-sdk-home',
      baseUrl: 'http://127.0.0.1:18932',
      apiKey: 'sk-injected',
      clientApp: 'pilab/0',
    });
    expect(env.Path).toBe(inherited.Path);
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.https_proxy).toBe('http://proxy.local:3128');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-injected');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:18932');
    expect(env.CLAUDE_CONFIG_DIR).toBe('D:\\state\\claude-sdk-home');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined();
  });

  it('passes the Git Bash it was given', () => {
    const env = buildCliEnvironment({
      inherited: {},
      configDir: 'x',
      baseUrl: 'http://gw',
      apiKey: 'k',
      clientApp: 'a',
      gitBashPath: 'G:\\Program Files\\Git\\bin\\bash.exe',
    });
    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe('G:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('never lets the shipped binary update itself', () => {
    const env = buildCliEnvironment({
      inherited: {},
      configDir: 'x',
      baseUrl: 'http://gw',
      apiKey: 'k',
      clientApp: 'a',
    });
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env.USE_BUILTIN_RIPGREP).toBeUndefined();
  });

  it('puts a given rg directory first on PATH and turns the built-in rg off', () => {
    const env = buildCliEnvironment({
      inherited: { Path: 'C:\\Windows', USE_BUILTIN_RIPGREP: '1' },
      configDir: 'x',
      baseUrl: 'http://gw',
      apiKey: 'k',
      clientApp: 'a',
      ripgrepDir: 'D:\\PiLab\\rg',
    });
    expect(env.Path).toBe(`D:\\PiLab\\rg${path.delimiter}C:\\Windows`);
    expect(env.PATH).toBeUndefined();
    expect(env.USE_BUILTIN_RIPGREP).toBe('0');
  });
});

describe('withPathPrefix', () => {
  it('prepends to the PATH entry whatever case its name has', () => {
    expect(withPathPrefix({ Path: 'C:\\Windows', TEMP: 't' }, 'D:\\rg', ';')).toEqual({
      Path: 'D:\\rg;C:\\Windows',
      TEMP: 't',
    });
    expect(withPathPrefix({ PATH: '/usr/bin:/bin' }, '/opt/pilab/rg', ':')).toEqual({
      PATH: '/opt/pilab/rg:/usr/bin:/bin',
    });
  });

  it('starts a PATH when there is none, and leaves its input alone', () => {
    const env = { TEMP: 't' };
    expect(withPathPrefix(env, 'D:\\rg', ';')).toEqual({ TEMP: 't', PATH: 'D:\\rg' });
    expect(env).toEqual({ TEMP: 't' });
  });
});

describe('findGitBash', () => {
  const files = (list: string[]) => (file: string) => list.includes(file);

  it('derives bash.exe from a git.exe on PATH outside the default install', () => {
    const found = findGitBash(
      { Path: 'C:\\Windows;G:\\Program Files\\Git\\cmd' },
      files(['G:\\Program Files\\Git\\cmd\\git.exe', 'G:\\Program Files\\Git\\bin\\bash.exe'])
    );
    expect(found).toBe('G:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('understands mingw64\\bin and usr\\bin entries', () => {
    expect(
      findGitBash(
        { PATH: 'E:\\Git\\mingw64\\bin' },
        files(['E:\\Git\\mingw64\\bin\\git.exe', 'E:\\Git\\bin\\bash.exe'])
      )
    ).toBe('E:\\Git\\bin\\bash.exe');
    expect(
      findGitBash(
        { PATH: 'E:\\Git\\usr\\bin' },
        files(['E:\\Git\\usr\\bin\\bash.exe', 'E:\\Git\\bin\\bash.exe'])
      )
    ).toBe('E:\\Git\\bin\\bash.exe');
  });

  it('falls back to the standard install, and to nothing', () => {
    expect(
      findGitBash(
        { PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
        files(['C:\\Program Files\\Git\\bin\\bash.exe'])
      )
    ).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(findGitBash({ PATH: 'C:\\Windows' }, files([]))).toBeUndefined();
  });

  it('prefers an explicit AICLIENT_GIT_BASH_PATH that exists', () => {
    expect(
      findGitBash(
        { AICLIENT_GIT_BASH_PATH: 'X:\\bash.exe', PATH: 'G:\\Program Files\\Git\\cmd' },
        files([
          'X:\\bash.exe',
          'G:\\Program Files\\Git\\cmd\\git.exe',
          'G:\\Program Files\\Git\\bin\\bash.exe',
        ])
      )
    ).toBe('X:\\bash.exe');
  });
});

describe('buildPinnedSettingsEnv (decision 6: the flag tier a repository cannot override)', () => {
  const KEY = 'sk-fake-pin-test-key';
  const SWITCHES = [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_MANTLE',
    'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
    'CLAUDE_CODE_USE_GATEWAY',
  ];

  it('pins the gateway, no self-update, no nonessential traffic, and the Git Bash found', () => {
    const { env } = buildPinnedSettingsEnv({
      inherited: {},
      baseUrl: 'http://127.0.0.1:18950',
      gitBashPath: 'G:Program FilesGit\bin\bash.exe',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:18950');
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe('G:Program FilesGit\bin\bash.exe');
    expect(buildPinnedSettingsEnv({ inherited: {}, baseUrl: 'http://gw' }).env).not.toHaveProperty(
      'CLAUDE_CODE_GIT_BASH_PATH'
    );
  });

  it('pins certificate checks on, the bearer token, custom headers and extra CAs off, every provider switch off', () => {
    const { env } = buildPinnedSettingsEnv({ inherited: {}, baseUrl: 'http://gw' });
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('');
    for (const name of SWITCHES) expect(env[name]).toBe('0');
  });

  it("pins the model aliases, the experimental-betas switch and Auto's server check unset (route B S-2 A-17)", () => {
    // Written out, not imported: dropping one from the source must fail here.
    const S2 = [
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
      'CLAUDE_CODE_AUTO_MODE_SERVER',
    ];
    const { env } = buildPinnedSettingsEnv({
      inherited: Object.fromEntries(S2.map((name) => [name, 'inherited'])),
      baseUrl: 'http://gw',
    });
    for (const name of S2) expect(env[name], name).toBe('');
  });

  it("pins the trust store to PiLab's own CA, so a private-CA gateway works and a repository cannot swap it", () => {
    const { env } = buildPinnedSettingsEnv({
      inherited: { NODE_EXTRA_CA_CERTS: 'C:corpca.pem' },
      baseUrl: 'http://127.0.0.1:18932',
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe('C:corpca.pem');
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1');
  });

  it('lets the CLI inherit the trust store settings the DSH host inherits', () => {
    const env = buildCliEnvironment({
      inherited: { NODE_EXTRA_CA_CERTS: '/etc/corp/ca.pem', NODE_USE_SYSTEM_CA: '1' },
      configDir: '/state/claude-sdk-home',
      baseUrl: 'http://127.0.0.1:18932',
      apiKey: 'sk-injected',
      clientApp: 'pilab/0',
    });
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/corp/ca.pem');
    expect(env.NODE_USE_SYSTEM_CA).toBe('1');
  });

  it('carries no key: the SDK puts these settings on the command line', () => {
    const { env } = buildPinnedSettingsEnv({
      // Even an inherited key or token must not cross into the pins.
      inherited: {
        ANTHROPIC_API_KEY: KEY,
        ANTHROPIC_AUTH_TOKEN: KEY,
        AICLIENT_CLAUDE_SDK_API_KEY: KEY,
      },
      baseUrl: 'http://127.0.0.1:18950',
    });
    expect(Object.values(env)).not.toContain(KEY);
    expect(JSON.stringify(env)).not.toContain(KEY);
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    // A credential-named entry may only ever be pinned empty.
    for (const [name, value] of Object.entries(env)) {
      if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) expect(value).toBe('');
    }
  });

  it('pins proxies to what PiLab inherited, in both spellings, or to empty (unset)', () => {
    const { env, credentialedProxies } = buildPinnedSettingsEnv({
      inherited: { HTTPS_PROXY: 'http://proxy.corp:3128', no_proxy: 'localhost,127.0.0.1' },
      baseUrl: 'http://gw',
    });
    expect(credentialedProxies).toEqual([]);
    expect(env.HTTPS_PROXY).toBe('http://proxy.corp:3128');
    expect(env.https_proxy).toBe('http://proxy.corp:3128');
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1');
    expect(env.HTTP_PROXY).toBe('');
    expect(env.http_proxy).toBe('');
    expect(env.ALL_PROXY).toBe('');
    expect(env.all_proxy).toBe('');
  });

  it('prefers the lower-case spelling when both are inherited with different values', () => {
    const { env } = buildPinnedSettingsEnv({
      inherited: { HTTP_PROXY: 'http://upper:1', http_proxy: 'http://lower:2' },
      baseUrl: 'http://gw',
    });
    expect(env.HTTP_PROXY).toBe('http://lower:2');
    expect(env.http_proxy).toBe('http://lower:2');
  });

  it('leaves a proxy carrying credentials unpinned and names it', () => {
    const { env, credentialedProxies } = buildPinnedSettingsEnv({
      inherited: {
        HTTPS_PROXY: 'http://alice:s3cret@proxy.corp:3128',
        HTTP_PROXY: 'proxy.corp:80',
      },
      baseUrl: 'http://gw',
    });
    expect(credentialedProxies).toEqual(['HTTPS_PROXY']);
    expect(env).not.toHaveProperty('HTTPS_PROXY');
    expect(env).not.toHaveProperty('https_proxy');
    expect(JSON.stringify(env)).not.toContain('s3cret');
    expect(env.HTTP_PROXY).toBe('proxy.corp:80');
  });
});

describe('hasUrlCredentials', () => {
  it('tells a proxy URL with a user or password from one without', () => {
    expect(hasUrlCredentials('http://alice:pw@proxy:3128')).toBe(true);
    expect(hasUrlCredentials('http://alice@proxy:3128')).toBe(true);
    expect(hasUrlCredentials('alice:pw@proxy:3128')).toBe(true);
    expect(hasUrlCredentials('http://proxy:3128')).toBe(false);
    expect(hasUrlCredentials('proxy.corp:80')).toBe(false);
  });
});
