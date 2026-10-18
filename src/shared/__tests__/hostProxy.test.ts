import { describe, expect, it } from 'vitest';
import {
  childProxyOverlay,
  describeHostProxy,
  effectiveNoProxy,
  type HostProxySetting,
  hostProxyKind,
  hostProxySecrets,
  inheritedNoProxy,
  mergeNoProxy,
  readHostProxySetting,
  sameHostProxy,
  upstreamProxyEnv,
} from '../hostProxy';

/** Decision 195: the product proxy rules Main and both engine hosts share. */

const HTTP: HostProxySetting = { url: 'http://proxy.corp:8080', noProxy: 'localhost,127.0.0.1' };
const WITH_CREDENTIALS: HostProxySetting = {
  url: 'http://us%40er:p%3Assw0rd-long@proxy.corp:8080',
  noProxy: 'localhost,127.0.0.1,.corp',
};
const SOCKS: HostProxySetting = { url: 'socks5://127.0.0.1:1080', noProxy: '' };

describe('reading the setting Main sends', () => {
  it('takes a setting, null for off, and refuses anything else', () => {
    expect(readHostProxySetting(HTTP)).toEqual(HTTP);
    expect(readHostProxySetting({ url: ' http://p:1 ', noProxy: '' })).toEqual({
      url: 'http://p:1',
      noProxy: '',
    });
    expect(readHostProxySetting(null)).toBeNull();
    expect(readHostProxySetting(undefined)).toBeUndefined();
    expect(readHostProxySetting({ url: '', noProxy: '' })).toBeUndefined();
    expect(readHostProxySetting({ url: 'http://p:1' })).toBeUndefined();
    expect(readHostProxySetting('http://p:1')).toBeUndefined();
  });

  it('sorts URLs into the ones a host can route through and the rest', () => {
    expect(hostProxyKind('http://proxy:8080')).toBe('http');
    expect(hostProxyKind('https://proxy:443')).toBe('http');
    expect(hostProxyKind(WITH_CREDENTIALS.url)).toBe('http');
    for (const socks of ['socks5://p:1080', 'socks5h://p:1080', 'socks4://p:1080', 'socks://p:1']) {
      expect(hostProxyKind(socks)).toBe('socks');
    }
    expect(hostProxyKind('ftp://p:21')).toBe('invalid');
    expect(hostProxyKind('not a url')).toBe('invalid');
  });

  it('compares settings by what they route', () => {
    expect(sameHostProxy(null, null)).toBe(true);
    expect(sameHostProxy(undefined, null)).toBe(true);
    expect(sameHostProxy(HTTP, { ...HTTP })).toBe(true);
    expect(sameHostProxy(HTTP, null)).toBe(false);
    expect(sameHostProxy(HTTP, { ...HTTP, noProxy: 'localhost' })).toBe(false);
  });
});

describe('the bypass list (rule 8)', () => {
  it('merges the settings list, the launch environment and loopback, without repeats', () => {
    expect(mergeNoProxy(' a.com, ,B.com', 'b.com,c.com', ['a.com'])).toBe('a.com,B.com,c.com');
    expect(effectiveNoProxy(WITH_CREDENTIALS, '.example.com,LOCALHOST')).toBe(
      'localhost,127.0.0.1,.corp,.example.com,::1,[::1]'
    );
    expect(effectiveNoProxy({ url: HTTP.url, noProxy: '' })).toBe('localhost,127.0.0.1,::1,[::1]');
  });

  it('reads the launch environment NO_PROXY in either case, blank as unset', () => {
    expect(inheritedNoProxy({ no_proxy: 'a', NO_PROXY: 'b' })).toBe('a');
    expect(inheritedNoProxy({ NO_PROXY: 'b' })).toBe('b');
    expect(inheritedNoProxy({ No_Proxy: 'c' })).toBe('c');
    expect(inheritedNoProxy({ no_proxy: ' ', NO_PROXY: 'b' })).toBe('b');
    expect(inheritedNoProxy({})).toBeUndefined();
  });
});

describe('what the SDK host upstream leg reads (rule 1)', () => {
  it('on: both schemes through the proxy, credentials kept, loopback bypassed', () => {
    expect(upstreamProxyEnv(WITH_CREDENTIALS, '.example.com')).toEqual({
      HTTP_PROXY: WITH_CREDENTIALS.url,
      HTTPS_PROXY: WITH_CREDENTIALS.url,
      NO_PROXY: 'localhost,127.0.0.1,.corp,.example.com,::1,[::1]',
    });
  });

  it('off, SOCKS or unusable: direct', () => {
    expect(upstreamProxyEnv(null)).toBeUndefined();
    expect(upstreamProxyEnv(SOCKS)).toBeUndefined();
    expect(upstreamProxyEnv({ url: 'ftp://p:21', noProxy: '' })).toBeUndefined();
  });
});

describe('what a child the host builds the environment of sees (rule 7)', () => {
  it('on: the schemes the launch environment did not name get the product proxy', () => {
    expect(childProxyOverlay({ PATH: '/bin' }, HTTP)).toEqual({
      http_proxy: HTTP.url,
      HTTP_PROXY: HTTP.url,
      https_proxy: HTTP.url,
      HTTPS_PROXY: HTTP.url,
      no_proxy: 'localhost,127.0.0.1,::1,[::1]',
      NO_PROXY: 'localhost,127.0.0.1,::1,[::1]',
      NODE_USE_ENV_PROXY: '1',
    });
  });

  it('keeps a scheme the user named themselves, and their NO_PROXY entries', () => {
    const overlay = childProxyOverlay({ HTTPS_PROXY: 'http://own:3128', no_proxy: '.intra' }, HTTP);
    expect(overlay.https_proxy).toBe('http://own:3128');
    expect(overlay.HTTPS_PROXY).toBe('http://own:3128');
    expect(overlay.http_proxy).toBe(HTTP.url);
    expect(overlay.NO_PROXY).toBe('localhost,127.0.0.1,.intra,::1,[::1]');
    expect(overlay.NODE_USE_ENV_PROXY).toBe('1');
  });

  it('withholds NODE_USE_ENV_PROXY when the user kept a SOCKS value Node refuses', () => {
    const overlay = childProxyOverlay({ https_proxy: 'socks5://own:1080' }, HTTP);
    expect(overlay.https_proxy).toBe('socks5://own:1080');
    expect(overlay).not.toHaveProperty('NODE_USE_ENV_PROXY');
  });

  it('off, SOCKS or unusable: nothing changes', () => {
    expect(childProxyOverlay({ HTTPS_PROXY: 'http://own:3128' }, null)).toEqual({});
    expect(childProxyOverlay({}, SOCKS)).toEqual({});
  });
});

describe('logs never carry the address', () => {
  it('describes a setting by state, scheme and bypass count only', () => {
    expect(describeHostProxy(null)).toBe('off');
    expect(describeHostProxy(HTTP)).toBe('on (http proxy; 4 bypass entries)');
    expect(describeHostProxy({ url: 'https://proxy:443', noProxy: '' })).toBe(
      'on (https proxy; 4 bypass entries)'
    );
    expect(describeHostProxy(SOCKS)).toMatch(/^not used: .*SOCKS.*connect directly$/);
    expect(describeHostProxy({ url: 'ftp://p:21', noProxy: '' })).toMatch(/^not used: /);
    const line = describeHostProxy(WITH_CREDENTIALS, '.example.com');
    expect(line).toBe('on (http proxy; 6 bypass entries)');
    for (const leak of ['proxy.corp', 'us%40er', 'p%3Assw0rd', 'ssw0rd-long', '8080']) {
      expect(line).not.toContain(leak);
    }
  });

  it('lists what a host must blank out of its lines for a credentialed proxy', () => {
    expect(hostProxySecrets(null)).toEqual([]);
    expect(hostProxySecrets(HTTP)).toEqual([]);
    expect(hostProxySecrets(WITH_CREDENTIALS)).toEqual([
      WITH_CREDENTIALS.url,
      'p%3Assw0rd-long',
      'p:ssw0rd-long',
    ]);
    // A short password would blank out ordinary words; the URL rule still covers it.
    expect(hostProxySecrets({ url: 'http://u:pw@p:1', noProxy: '' })).toEqual(['http://u:pw@p:1']);
  });
});
