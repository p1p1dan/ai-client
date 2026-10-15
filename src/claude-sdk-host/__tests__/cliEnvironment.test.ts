import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCliEnvironment, findGitBash, withPathPrefix } from '../cliEnvironment.ts';

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
