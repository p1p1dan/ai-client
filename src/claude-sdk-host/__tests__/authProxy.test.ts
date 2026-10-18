import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestProxy } from '../../dsh-host/tools/lib/testProxy.ts';
import { mintSessionToken, proxiedRoute, startAuthProxy } from '../authProxy.ts';

/**
 * Route B S-3 (topic s3-project-config.md §3.1 item 1): the loopback auth proxy.
 * The upstream is a local server; nothing leaves the machine.
 */

const KEY = 'sk-fake-real-gateway-key';
interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  closed: boolean;
}
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A stand-in gateway; `handler` answers, `seen` records what reached it. */
async function gateway(handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const entry: Seen = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: '',
      closed: false,
    };
    seen.push(entry);
    req.on('data', (chunk) => {
      entry.body += chunk;
    });
    res.on('close', () => {
      entry.closed = !res.writableFinished;
    });
    req.on('end', () => {
      if (handler) handler(req, res);
      else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function proxyTo(upstream: string) {
  const proxy = await startAuthProxy({ upstream, apiKey: KEY });
  closers.unshift(() => proxy.close());
  return proxy;
}

function call(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) {
  return fetch(url, { method: init.method ?? 'POST', ...init });
}

describe('the auth proxy (S-3 K-1, K-2)', () => {
  it('refuses a request without the session token, and sends nothing on', async () => {
    const gw = await gateway();
    const proxy = await proxyTo(gw.url);
    const answer = await call(`${proxy.url}/v1/messages`, {
      headers: { 'x-api-key': 'sk-something-else' },
      body: '{}',
    });
    expect(answer.status).toBe(401);
    expect(answer.headers.get('x-should-retry')).toBe('false');
    expect(await answer.json()).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' },
    });
    expect(gw.seen).toEqual([]);
  });

  it('forwards only the paths the CLI uses', async () => {
    const gw = await gateway();
    const proxy = await proxyTo(gw.url);
    const headers = { 'x-api-key': proxy.token };
    expect((await call(`${proxy.url}/v1/files`, { headers, body: '{}' })).status).toBe(404);
    expect((await call(`${proxy.url}/v1/messages/batches`, { headers, body: '{}' })).status).toBe(
      404
    );
    expect((await call(`${proxy.url}/v1/messages`, { method: 'GET', headers })).status).toBe(404);
    expect(gw.seen).toEqual([]);
    expect(proxiedRoute('POST', '/v1/messages?beta=true')).toBe(true);
    expect(proxiedRoute('POST', '/v1/messages/count_tokens?beta=true')).toBe(true);
    expect(proxiedRoute('GET', '/v1/models/claude-opus-5-5')).toBe(true);
    expect(proxiedRoute('GET', '/v1/models')).toBe(true);
    expect(proxiedRoute('DELETE', '/v1/models/x')).toBe(false);
  });

  it('swaps the token for the real key, keeps the rest, and joins the route path prefix', async () => {
    const gw = await gateway();
    const proxy = await proxyTo(`${gw.url}/anthropic/`);
    const body = JSON.stringify({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const answer = await call(`${proxy.url}/v1/messages?beta=true`, {
      headers: {
        'x-api-key': proxy.token,
        'anthropic-beta': 'claude-code-20250219',
        'user-agent': 'claude-cli/2.1.300',
        'content-type': 'application/json',
      },
      body,
    });
    expect(answer.status).toBe(200);
    const [seen] = gw.seen;
    expect(seen?.url).toBe('/anthropic/v1/messages?beta=true');
    expect(seen?.headers['x-api-key']).toBe(KEY);
    expect(JSON.stringify(seen?.headers)).not.toContain(proxy.token);
    expect(seen?.headers['anthropic-beta']).toBe('claude-code-20250219');
    expect(seen?.headers['user-agent']).toBe('claude-cli/2.1.300');
    expect(seen?.body).toBe(body);
  });

  it('takes a Bearer token as well', async () => {
    const gw = await gateway();
    const proxy = await proxyTo(gw.url);
    const answer = await call(`${proxy.url}/v1/models/claude-opus-5-5`, {
      method: 'GET',
      headers: { authorization: `Bearer ${proxy.token}` },
    });
    expect(answer.status).toBe(200);
    expect(gw.seen[0]?.headers['x-api-key']).toBe(KEY);
    expect(gw.seen[0]?.headers.authorization).toBeUndefined();
  });

  it('streams the answer as it comes', async () => {
    let release: () => void = () => undefined;
    const gw = await gateway((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {}\n\n');
      release = () => res.end('event: message_stop\ndata: {}\n\n');
    });
    const proxy = await proxyTo(gw.url);
    const answer = await call(`${proxy.url}/v1/messages`, {
      headers: { 'x-api-key': proxy.token },
      body: '{}',
    });
    const reader = (answer.body as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    // The first event arrives while the gateway is still answering.
    expect(first).toContain('message_start');
    release();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('message_stop');
  });

  it('ends the gateway request when the CLI hangs up', async () => {
    const gw = await gateway((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ping\ndata: {}\n\n');
    });
    const proxy = await proxyTo(gw.url);
    const abort = new AbortController();
    const answer = await call(`${proxy.url}/v1/messages`, {
      headers: { 'x-api-key': proxy.token },
      body: '{}',
      signal: abort.signal,
    });
    await (answer.body as ReadableStream<Uint8Array>).getReader().read();
    abort.abort();
    for (let i = 0; i < 100 && !gw.seen[0]?.closed; i += 1)
      await new Promise((r) => setTimeout(r, 10));
    expect(gw.seen[0]?.closed).toBe(true);
  });

  it('answers 502 in the Anthropic error shape when the gateway cannot be reached', async () => {
    const proxy = await proxyTo('http://127.0.0.1:1');
    const answer = await call(`${proxy.url}/v1/messages`, {
      headers: { 'x-api-key': proxy.token },
      body: '{}',
    });
    expect(answer.status).toBe(502);
    const error = (await answer.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(error).toMatchObject({ type: 'error', error: { type: 'api_error' } });
    expect(error.error.message).not.toContain(KEY);
  });

  it('mints a fresh token each time, recognisable and never the key', () => {
    const a = mintSessionToken();
    const b = mintSessionToken();
    expect(a).toMatch(/^sk-pilab-session-[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});

/**
 * Dsh-rebase decision 195: the leg to the gateway goes through the product
 * proxy Main hands over, directly when it is off, and follows a change at
 * once. The gateway is named `gateway.invalid`, which only the test proxy
 * resolves (to loopback): a request that reaches it was proxied.
 */
describe('the leg to the gateway follows the product proxy (decision 195)', () => {
  const PASSWORD = 'pr0xy-secret-word';
  const AMBIENT = [
    'http_proxy',
    'HTTP_PROXY',
    'https_proxy',
    'HTTPS_PROXY',
    'no_proxy',
    'NO_PROXY',
  ];
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const name of AMBIENT) saved.set(name, process.env[name]);
    for (const name of AMBIENT) delete process.env[name];
  });
  afterEach(() => {
    for (const name of AMBIENT) delete process.env[name];
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  });

  async function testProxy(credentials = true) {
    const proxy = await startTestProxy(
      credentials ? { credentials: { username: 'pi lab', password: PASSWORD } } : {}
    );
    closers.push(() => proxy.close());
    return proxy;
  }

  /** The auth proxy in front of `upstream`, with its log lines. */
  async function authProxy(
    upstream: string,
    options: Partial<Parameters<typeof startAuthProxy>[0]>
  ) {
    const lines: string[] = [];
    const proxy = await startAuthProxy({
      upstream,
      apiKey: KEY,
      log: (...args) => lines.push(args.map(String).join(' ')),
      ...options,
    });
    closers.unshift(() => proxy.close());
    return { proxy, lines };
  }

  async function ask(proxy: { url: string; token: string }): Promise<number | string> {
    try {
      const answer = await call(`${proxy.url}/v1/messages`, {
        headers: { 'x-api-key': proxy.token },
        body: '{}',
        signal: AbortSignal.timeout(5_000),
      });
      await answer.text();
      return answer.status;
    } catch (error) {
      return (error as Error).name;
    }
  }

  function invalidName(url: string): string {
    return url.replace('127.0.0.1', 'gateway.invalid');
  }

  it('on: through the proxy with its credentials; off: direct; on again: through it', async () => {
    const gw = await gateway();
    const outbound = await testProxy();
    const setting = { url: outbound.urlWithCredentials, noProxy: 'localhost,127.0.0.1' };
    const { proxy, lines } = await authProxy(invalidName(gw.url), { proxy: setting });

    expect(await ask(proxy)).toBe(200);
    expect(outbound.records).toEqual([
      expect.objectContaining({ kind: 'forward', authorized: true, status: 200 }),
    ]);
    expect(gw.seen[0]?.headers['x-api-key']).toBe(KEY);
    expect(gw.seen[0]?.headers).not.toHaveProperty('proxy-authorization');

    proxy.setProxy(null);
    await ask(proxy);
    expect(outbound.records).toHaveLength(1);

    proxy.setProxy(setting);
    expect(await ask(proxy)).toBe(200);
    expect(outbound.records).toHaveLength(2);

    // Between the two switches, the direct attempt at `gateway.invalid` fails (logged).
    const switches = lines.filter((line) => line.startsWith('auth proxy: outbound proxy'));
    expect(switches).toEqual([
      'auth proxy: outbound proxy off',
      'auth proxy: outbound proxy on (http proxy; 4 bypass entries)',
    ]);
    expect(lines.join('\n')).not.toContain(PASSWORD);
  }, 30_000);

  it('a wrong password: the proxy refuses it, the CLI gets a final error naming the proxy', async () => {
    const gw = await gateway();
    const outbound = await testProxy();
    const { proxy, lines } = await authProxy(invalidName(gw.url), {
      proxy: { url: outbound.urlWithCredentials.replace(PASSWORD, 'wrong-password'), noProxy: '' },
    });
    const answer = await call(`${proxy.url}/v1/messages`, {
      headers: { 'x-api-key': proxy.token },
      body: '{}',
    });
    // A bare 407 is a network error to fetch, which the CLI would retry.
    expect(answer.status).toBe(502);
    expect(answer.headers.get('x-should-retry')).toBe('false');
    expect(await answer.json()).toMatchObject({
      type: 'error',
      error: { type: 'api_error', message: expect.stringContaining('407') },
    });
    expect(outbound.records).toEqual([expect.objectContaining({ authorized: false, status: 407 })]);
    expect(gw.seen).toEqual([]);
    expect(lines.join('\n')).not.toContain('wrong-password');
  });

  it('a SOCKS proxy is not used: direct, and the log says so', async () => {
    const gw = await gateway();
    const outbound = await testProxy(false);
    const { proxy, lines } = await authProxy(gw.url, {
      proxy: { url: 'socks5://127.0.0.1:1', noProxy: '' },
    });
    // The constructor logs nothing; the first switch does.
    proxy.setProxy({ url: `socks5://127.0.0.1:${outbound.port}`, noProxy: '' });
    expect(await ask(proxy)).toBe(200);
    expect(outbound.records).toEqual([]);
    expect(lines[0]).toMatch(/^auth proxy: outbound proxy not used: .*SOCKS/);
  });

  it('a gateway on loopback is never sent to the proxy, whatever the bypass list says', async () => {
    const gw = await gateway();
    const outbound = await testProxy(false);
    const { proxy } = await authProxy(gw.url, { proxy: { url: outbound.url, noProxy: '' } });
    expect(await ask(proxy)).toBe(200);
    expect(outbound.records).toEqual([]);
  });

  it("keeps the launch environment's NO_PROXY as a bypass", async () => {
    const gw = await gateway();
    const outbound = await testProxy(false);
    const { proxy } = await authProxy(invalidName(gw.url), {
      proxy: { url: outbound.url, noProxy: '' },
      inheritedNoProxy: '.invalid',
    });
    await ask(proxy);
    expect(outbound.records).toEqual([]);
  }, 15_000);

  it('Main keeping the engines off it (no setting at all): the launch environment, as S-3 K-3 had it', async () => {
    const gw = await gateway();
    const outbound = await testProxy(false);
    process.env.HTTP_PROXY = outbound.url;
    const { proxy } = await authProxy(invalidName(gw.url), {});
    expect(await ask(proxy)).toBe(200);
    expect(outbound.records).toHaveLength(1);
  });
});
