import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkRequestUserAgent,
  DEFAULT_REQUEST_USER_AGENT_MODE,
  defaultRequestUserAgent,
  describeRequestUserAgent,
  isRequestUserAgentMode,
  PI_USER_AGENT_PRODUCT,
  REQUEST_USER_AGENT_CUSTOM_SETTING_KEY,
  REQUEST_USER_AGENT_MAX_LENGTH,
  REQUEST_USER_AGENT_MODE_SETTING_KEY,
  REQUEST_USER_AGENT_MODES,
  resolveRequestUserAgent,
  USER_AGENT_RELAY_HEADER,
} from '../types/requestUserAgent';

/**
 * dsh-rebase decision 171 (GitHub issue #7): the User-Agent setting, the one
 * check every reader applies, and how a stored choice resolves.
 */
describe('request User-Agent setting', () => {
  it('defaults to claude-cli-pilab/<app version> under its own keys', () => {
    expect(REQUEST_USER_AGENT_MODE_SETTING_KEY).toBe('requestUserAgentMode');
    expect(REQUEST_USER_AGENT_CUSTOM_SETTING_KEY).toBe('requestUserAgentCustom');
    expect(REQUEST_USER_AGENT_MODES).toEqual(['default', 'engine', 'custom']);
    expect(DEFAULT_REQUEST_USER_AGENT_MODE).toBe('default');
    expect(PI_USER_AGENT_PRODUCT).toBe('claude-cli-pilab');
    expect(defaultRequestUserAgent('1.1.0-dsh.8')).toBe('claude-cli-pilab/1.1.0-dsh.8');
    expect(defaultRequestUserAgent(' 1.1.0 ')).toBe('claude-cli-pilab/1.1.0');
    // No version, no trailing slash.
    expect(defaultRequestUserAgent('')).toBe('claude-cli-pilab');
    expect(USER_AGENT_RELAY_HEADER).toBe('X-Aiclient-User-Agent');
  });

  it('knows its three modes and nothing else', () => {
    for (const mode of REQUEST_USER_AGENT_MODES) expect(isRequestUserAgentMode(mode)).toBe(true);
    for (const value of ['Default', 'none', '', null, undefined, 1]) {
      expect(isRequestUserAgentMode(value)).toBe(false);
    }
  });
});

describe('checkRequestUserAgent', () => {
  it('trims, and takes 1-256 characters of visible ASCII and spaces', () => {
    expect(checkRequestUserAgent('  claude-cli-pilab/1.1.0  ')).toEqual({
      ok: true,
      value: 'claude-cli-pilab/1.1.0',
    });
    expect(checkRequestUserAgent('Mozilla/5.0 (X11; Linux) foo/1 ~!@#$%^&*()_+{}|:"<>?')).toEqual({
      ok: true,
      value: 'Mozilla/5.0 (X11; Linux) foo/1 ~!@#$%^&*()_+{}|:"<>?',
    });
    const longest = 'a'.repeat(REQUEST_USER_AGENT_MAX_LENGTH);
    expect(checkRequestUserAgent(` ${longest} `)).toEqual({ ok: true, value: longest });
    // A line break at either end is surrounding whitespace, trimmed like a space.
    expect(checkRequestUserAgent('foo/1\n')).toEqual({ ok: true, value: 'foo/1' });
  });

  it.each([
    [undefined, 'not_text'],
    [42, 'not_text'],
    ['', 'empty'],
    ['   \t ', 'empty'],
    ['a'.repeat(REQUEST_USER_AGENT_MAX_LENGTH + 1), 'too_long'],
    ['foo/1\r\nX-Injected: 1', 'invalid_character'],
    ['foo\tbar/1', 'invalid_character'],
    ['claude-cli-pilab/1.0 (测试)', 'invalid_character'],
    ['café/1', 'invalid_character'],
    ['foo/1\u0000', 'invalid_character'],
  ])('refuses %j as %s', (value, problem) => {
    expect(checkRequestUserAgent(value)).toEqual({ ok: false, problem });
  });
});

describe('resolveRequestUserAgent', () => {
  it('default (also when absent or unknown): claude-cli-pilab/<version>', () => {
    for (const mode of ['default', undefined, 'nonsense', 3]) {
      expect(resolveRequestUserAgent({ mode }, '1.1.0')).toEqual({
        mode: 'default',
        userAgent: 'claude-cli-pilab/1.1.0',
      });
    }
  });

  it("engine: nothing to send, DSH's own stays", () => {
    expect(resolveRequestUserAgent({ mode: 'engine', custom: 'foo/1' }, '1.1.0')).toEqual({
      mode: 'engine',
      userAgent: undefined,
    });
  });

  it('custom: the trimmed value', () => {
    expect(resolveRequestUserAgent({ mode: 'custom', custom: ' foo/1 (bar) ' }, '1.1.0')).toEqual({
      mode: 'custom',
      userAgent: 'foo/1 (bar)',
    });
  });

  it('custom with an unusable value: the default, and why', () => {
    expect(resolveRequestUserAgent({ mode: 'custom' }, '1.1.0')).toEqual({
      mode: 'custom',
      userAgent: 'claude-cli-pilab/1.1.0',
      problem: 'empty',
    });
    expect(resolveRequestUserAgent({ mode: 'custom', custom: 'a\tb' }, '1.1.0')).toEqual({
      mode: 'custom',
      userAgent: 'claude-cli-pilab/1.1.0',
      problem: 'invalid_character',
    });
  });

  it("a default the version makes unusable: DSH's own, and why", () => {
    expect(resolveRequestUserAgent({}, '1.1.0-测试')).toEqual({
      mode: 'default',
      userAgent: undefined,
      problem: 'invalid_character',
    });
  });

  it('states the outcome for the log', () => {
    expect(describeRequestUserAgent(resolveRequestUserAgent({}, '1.1.0'))).toBe(
      'user agent: default (claude-cli-pilab/1.1.0)'
    );
    expect(describeRequestUserAgent(resolveRequestUserAgent({ mode: 'engine' }, '1.1.0'))).toBe(
      'user agent: engine default'
    );
    expect(
      describeRequestUserAgent(resolveRequestUserAgent({ mode: 'custom', custom: 'foo/1' }, '1'))
    ).toBe('user agent: custom (foo/1)');
    expect(describeRequestUserAgent(resolveRequestUserAgent({ mode: 'custom' }, '1.1.0'))).toBe(
      'user agent: custom value unusable (empty), sending the default (claude-cli-pilab/1.1.0)'
    );
    expect(describeRequestUserAgent(resolveRequestUserAgent({}, '1.1.0-测试'))).toBe(
      'user agent: default unusable (invalid_character), sending the engine default'
    );
  });
});

describe('the module the host bundle takes in', () => {
  it('imports nothing, so the host bundle takes in nothing else with it', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'types', 'requestUserAgent.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/^\s*export\s+[^;]*\bfrom\s+['"]/m);
  });
});
