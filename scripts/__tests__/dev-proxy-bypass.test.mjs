import { describe, expect, it } from 'vitest';
import { withLoopbackProxyBypass } from '../dev-proxy-bypass.mjs';

describe('withLoopbackProxyBypass', () => {
  it('is a no-op when no proxy is configured', () => {
    const env = { PATH: '/usr/bin' };
    const result = withLoopbackProxyBypass(env);
    expect(result.env).toBe(env);
    expect(result.added).toEqual([]);
    expect(result.proxyVars).toEqual([]);
  });

  it('writes the bypass in BOTH cases when a proxy is set', () => {
    const result = withLoopbackProxyBypass({ HTTP_PROXY: 'http://127.0.0.1:7890' });
    // Lower case is the one Chromium reads — the whole point of the fix.
    expect(result.env.no_proxy).toBe('localhost,127.0.0.1,::1');
    expect(result.env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(result.proxyVars).toEqual(['HTTP_PROXY']);
  });

  it('keeps the developer own bypass entries and appends only what is missing', () => {
    const result = withLoopbackProxyBypass({
      https_proxy: 'http://proxy:3128',
      no_proxy: 'example.com,127.0.0.1',
    });
    expect(result.env.no_proxy).toBe('example.com,127.0.0.1,localhost,::1');
    // NO_PROXY was unset here, so it gets all three; `added` is the union over
    // both spellings, which is what the log line reports.
    expect(result.env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(result.added.sort()).toEqual(['127.0.0.1', '::1', 'localhost']);
  });

  it('reports nothing added when loopback is already fully bypassed', () => {
    const result = withLoopbackProxyBypass({
      ALL_PROXY: 'socks5://127.0.0.1:1080',
      no_proxy: 'localhost,127.0.0.1,::1',
      NO_PROXY: 'LOCALHOST,127.0.0.1,::1',
    });
    expect(result.added).toEqual([]);
    expect(result.env.NO_PROXY).toBe('LOCALHOST,127.0.0.1,::1');
  });

  it('treats an empty proxy value as unset', () => {
    const result = withLoopbackProxyBypass({ HTTP_PROXY: '   ' });
    expect(result.added).toEqual([]);
    expect(result.proxyVars).toEqual([]);
  });

  it('never mutates the input env', () => {
    const env = { HTTP_PROXY: 'http://127.0.0.1:7890' };
    withLoopbackProxyBypass(env);
    expect(env.no_proxy).toBeUndefined();
  });
});
