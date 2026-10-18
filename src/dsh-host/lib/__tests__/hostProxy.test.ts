import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostProxySetting } from '../../../shared/hostProxy.ts';
import { startTestProxy, type TestProxy } from '../../tools/lib/testProxy.ts';
import {
  HostProxyInstaller,
  type InstallProxy,
  isHostProxyMessage,
  type ProxyEnvLookup,
  proxyLookupFor,
} from '../hostProxy.ts';

/**
 * Decision 195: the DSH host installs the product proxy Main hands it, with
 * DSH's own `installProxyFromEnvironment`, and swaps it on every change. The
 * first groups drive the installer with a recording stand-in; the last one
 * installs the real package and sends requests through a local test proxy.
 */

const HTTP: HostProxySetting = { url: 'http://proxy.corp:8080', noProxy: 'localhost,127.0.0.1' };
const OTHER: HostProxySetting = { url: 'http://other.corp:3128', noProxy: '.corp' };
const SOCKS: HostProxySetting = { url: 'socks5://127.0.0.1:1080', noProxy: '' };

function lookupValues(lookup: ProxyEnvLookup): Record<string, string | undefined> {
  const names = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'no_proxy'];
  return Object.fromEntries(names.map((name) => [name, lookup.get(name)?.value]));
}

function recordingInstaller(options: { failInstall?: boolean } = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  let installs = 0;
  const install: InstallProxy = async (lookup, report) => {
    if (options.failInstall) {
      throw Object.assign(new TypeError(`Invalid URL ${HTTP.url}`), { code: 'ERR_INVALID_URL' });
    }
    const id = ++installs;
    events.push(`install#${id} ${lookup.get('http_proxy')?.value}`);
    if (lookup.get('http_proxy')?.value?.startsWith('socks')) {
      report('http_proxy names a SOCKS proxy, which is not supported; connecting directly');
    }
    return async () => {
      events.push(`dispose#${id}`);
    };
  };
  const installer = new HostProxyInstaller({
    install: async () => install,
    inheritedNoProxy: '.intra',
    log: (line) => logs.push(line),
    warn: (line) => warnings.push(line),
  });
  return { installer, events, logs, warnings };
}

describe('proxyLookupFor', () => {
  it('names both schemes and the effective bypass list, nothing else', () => {
    expect(lookupValues(proxyLookupFor(HTTP, '.intra'))).toEqual({
      http_proxy: HTTP.url,
      HTTP_PROXY: undefined,
      https_proxy: HTTP.url,
      HTTPS_PROXY: undefined,
      all_proxy: undefined,
      no_proxy: 'localhost,127.0.0.1,.intra,::1,[::1]',
    });
  });

  it('recognises Main control message', () => {
    expect(isHostProxyMessage({ host: 'proxy', proxy: null })).toBe(true);
    expect(isHostProxyMessage({ host: 'configure' })).toBe(false);
    expect(isHostProxyMessage(null)).toBe(false);
  });
});

describe('HostProxyInstaller', () => {
  it('reports off at boot without installing anything', async () => {
    const { installer, events, logs } = recordingInstaller();
    await installer.update(null);
    expect(events).toEqual([]);
    expect(logs).toEqual(['outbound proxy: off']);
  });

  it('installs, keeps an unchanged setting, swaps a changed one and disposes on off', async () => {
    const { installer, events, logs } = recordingInstaller();
    await installer.update(HTTP);
    await installer.update({ ...HTTP });
    await installer.update(OTHER);
    await installer.update(null);
    expect(events).toEqual([
      `install#1 ${HTTP.url}`,
      'dispose#1',
      `install#2 ${OTHER.url}`,
      'dispose#2',
    ]);
    expect(logs).toEqual([
      'outbound proxy: on (http proxy; 5 bypass entries)',
      'outbound proxy: on (http proxy; 6 bypass entries)',
      'outbound proxy: off',
    ]);
  });

  it('applies a burst in order and ends on the last setting', async () => {
    const { installer, events } = recordingInstaller();
    void installer.update(HTTP);
    void installer.update(OTHER);
    void installer.update(HTTP);
    await installer.settled();
    expect(events.at(-1)).toBe(
      `install#${events.filter((e) => e.startsWith('install')).length} ${HTTP.url}`
    );
    expect(events.filter((e) => e.startsWith('install')).length).toBe(
      events.filter((e) => e.startsWith('dispose')).length + 1
    );
  });

  it('passes a SOCKS URL to DSH, which refuses it; the log says model requests go direct', async () => {
    const { installer, logs, warnings } = recordingInstaller();
    await installer.update(SOCKS);
    expect(warnings).toEqual([
      'outbound proxy: http_proxy names a SOCKS proxy, which is not supported; connecting directly',
    ]);
    expect(logs).toEqual([expect.stringMatching(/^outbound proxy: not used: .*SOCKS.*directly$/)]);
  });

  it('treats a malformed setting as off and says so', async () => {
    const { installer, events, warnings, logs } = recordingInstaller();
    await installer.update(HTTP);
    await installer.update({ url: 42 });
    expect(events).toEqual([`install#1 ${HTTP.url}`, 'dispose#1']);
    expect(warnings[0]).toMatch(/malformed outbound proxy setting/);
    expect(logs.at(-1)).toBe('outbound proxy: off');
  });

  it('a failed install leaves requests direct and logs no address', async () => {
    const { installer, warnings } = recordingInstaller({ failInstall: true });
    await installer.update(HTTP);
    expect(warnings).toEqual([
      'outbound proxy could not be applied; model requests connect directly (TypeError ERR_INVALID_URL)',
    ]);
  });
});

describe('with DSH installProxyFromEnvironment', () => {
  const PASSWORD = 'pr0xy-secret-word';
  /** The developer's own proxy variables are set aside: children must see only the test's. */
  const AMBIENT = [
    'http_proxy',
    'HTTP_PROXY',
    'https_proxy',
    'HTTPS_PROXY',
    'no_proxy',
    'NO_PROXY',
  ];
  const saved = new Map<string, string | undefined>();
  let proxy: TestProxy;
  let target: ReturnType<typeof createServer>;
  let targetPort = 0;
  let install: InstallProxy;
  let childEnv: () => Readonly<Record<string, string | undefined>>;

  beforeAll(async () => {
    for (const name of AMBIENT) saved.set(name, process.env[name]);
    for (const name of AMBIENT) delete process.env[name];
    proxy = await startTestProxy({ credentials: { username: 'pi lab', password: PASSWORD } });
    target = createServer((_req, res) => res.end('gateway'));
    await new Promise<void>((done) => target.listen(0, '127.0.0.1', done));
    targetPort = (target.address() as AddressInfo).port;
    const dshProxy = await import('@deepseek-ai/dsh-http-proxy');
    install = dshProxy.installProxyFromEnvironment;
    childEnv = dshProxy.proxyEnvironmentForChild;
  });

  afterAll(async () => {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
    await proxy.close();
    await new Promise<void>((done) => target.close(() => done()));
  });

  /** A gateway named `.invalid`: only the test proxy can reach it. */
  async function ask(): Promise<string> {
    try {
      const answer = await fetch(`http://gateway.invalid:${targetPort}/v1/messages`, {
        signal: AbortSignal.timeout(4_000),
      });
      return `${answer.status} ${await answer.text()}`;
    } catch (error) {
      return `failed ${(error as Error).name}`;
    }
  }

  it('routes fetch through the proxy with its credentials, publishes it to children, and goes direct when off', async () => {
    const warnings: string[] = [];
    const installer = new HostProxyInstaller({
      install: async () => install,
      inheritedNoProxy: undefined,
      log: () => undefined,
      warn: (line) => warnings.push(line),
    });
    const setting: HostProxySetting = { url: proxy.urlWithCredentials, noProxy: 'localhost' };
    try {
      await installer.update(setting);
      expect(await ask()).toBe('200 gateway');
      expect(proxy.records).toEqual([
        { kind: 'forward', target: `gateway.invalid:${targetPort}`, authorized: true, status: 200 },
      ]);
      // DSH publishes the policy to every child dsh-subprocess spawns.
      const env = childEnv();
      expect(env.HTTPS_PROXY).toBe(setting.url);
      expect(env.http_proxy).toBe(setting.url);
      expect(env.NO_PROXY?.split(',')).toEqual(expect.arrayContaining(['localhost', '127.0.0.1']));
      expect(env.NODE_USE_ENV_PROXY).toBe('1');

      await installer.update(null);
      expect(childEnv()).toEqual({});
      await ask();
      expect(proxy.records).toHaveLength(1);

      // A scheme the launch environment named keeps the user's value for children
      // (rule 7); the host's own requests still go through the product proxy.
      process.env.HTTPS_PROXY = 'http://own.example:3128';
      await installer.update(setting);
      expect(childEnv().HTTPS_PROXY).toBe('http://own.example:3128');
      expect(childEnv().HTTP_PROXY).toBe(setting.url);
      expect(await ask()).toBe('200 gateway');
      expect(proxy.records).toHaveLength(2);
      await installer.update(null);
      expect(process.env.HTTPS_PROXY).toBe('http://own.example:3128');
      delete process.env.HTTPS_PROXY;

      // SOCKS: refused by DSH, so requests stay direct and children get nothing.
      await installer.update({ url: 'socks5://127.0.0.1:1', noProxy: '' });
      expect(warnings.join('\n')).toMatch(/SOCKS/);
      await ask();
      expect(proxy.records).toHaveLength(2);
      expect(childEnv()).toEqual({});
    } finally {
      await installer.update(null);
    }
    expect(warnings.join('\n')).not.toContain(PASSWORD);
  }, 30_000);
});
