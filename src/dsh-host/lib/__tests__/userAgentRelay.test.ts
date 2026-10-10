import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installUserAgentRelay, relayUserAgent } from '../userAgentRelay.ts';

/**
 * dsh-rebase decision 171 (GitHub issue #7): the host's fetch wrapper moves
 * the plan's relay header into User-Agent and never lets it reach a provider;
 * a request without one goes through untouched. The last group sends real
 * requests through Node's own fetch to a local server and reads the raw lines.
 */

const DSH_AGENT = 'deepseek-harness/0.1.7-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)';
const WANTED = 'claude-cli-pilab/1.1.0-dsh.8';

/** The headers `relayUserAgent` produced, as name -> value pairs. */
function sent(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

describe('relayUserAgent', () => {
  it.each([
    ['a plain object', { 'user-agent': DSH_AGENT, 'X-Aiclient-User-Agent': WANTED, 'x-a': '1' }],
    [
      'a Headers object',
      new Headers({ 'user-agent': DSH_AGENT, 'X-Aiclient-User-Agent': WANTED, 'x-a': '1' }),
    ],
    [
      'an array of pairs',
      [
        ['user-agent', DSH_AGENT],
        ['X-Aiclient-User-Agent', WANTED],
        ['x-a', '1'],
      ] as [string, string][],
    ],
  ])('moves the relay header into User-Agent, headers given as %s', (_shape, headers) => {
    const init: RequestInit = { method: 'POST', body: '{}', headers };
    const next = relayUserAgent('https://gw.example.test/v1/chat/completions', init);
    expect(next.outcome).toBe('relayed');
    expect(sent(next.init)).toEqual({ 'user-agent': WANTED, 'x-a': '1' });
    // Everything else of the call is the caller's.
    expect(next.init).toMatchObject({ method: 'POST', body: '{}' });
    // The caller's own headers are not modified in place.
    expect(new Headers(headers).get('x-aiclient-user-agent')).toBe(WANTED);
  });

  it("takes a Request's own headers when the call gives no init headers", () => {
    const request = new Request('https://gw.example.test/v1/messages', {
      method: 'POST',
      body: '{}',
      headers: { 'user-agent': DSH_AGENT, 'x-aiclient-user-agent': WANTED },
    });
    const next = relayUserAgent(request, undefined);
    expect(next.outcome).toBe('relayed');
    expect(sent(next.init)).toEqual({
      'user-agent': WANTED,
      'content-type': 'text/plain;charset=UTF-8',
    });
  });

  it('matches the relay header in any case, and the User-Agent it replaces in any case', () => {
    const next = relayUserAgent('https://gw.example.test', {
      headers: { 'User-Agent': DSH_AGENT, 'x-AICLIENT-user-AGENT': WANTED },
    });
    expect(sent(next.init)).toEqual({ 'user-agent': WANTED });
  });

  it('hands back the very same init when there is nothing to relay', () => {
    const init: RequestInit = { headers: { 'user-agent': DSH_AGENT, 'x-api-key': 'k' } };
    expect(relayUserAgent('https://gw.example.test', init)).toEqual({ init, outcome: 'none' });
    expect(relayUserAgent('https://gw.example.test', init).init).toBe(init);
    expect(relayUserAgent('https://gw.example.test', undefined)).toEqual({
      init: undefined,
      outcome: 'none',
    });
    const bare = new Request('https://gw.example.test');
    expect(relayUserAgent(bare, undefined).outcome).toBe('none');
  });

  it.each([
    ['a tab inside', 'claude\tcli/1'],
    ['a non-ASCII character', 'café/1'],
    ['over 256 characters', 'a'.repeat(257)],
  ])("refuses a value with %s: DSH's own User-Agent stays, the relay header still goes", (_why, value) => {
    // Values Fetch itself accepts, which the shared check refuses.
    const next = relayUserAgent('https://gw.example.test', {
      headers: { 'user-agent': DSH_AGENT, 'x-aiclient-user-agent': value },
    });
    expect(next.outcome).toBe('refused');
    expect(sent(next.init)).toEqual({ 'user-agent': DSH_AGENT });
  });

  it('leaves headers Fetch would refuse to the real call', () => {
    const init = { headers: { 'bad name': 'v' } };
    expect(relayUserAgent('https://gw.example.test', init)).toEqual({ init, outcome: 'none' });
  });
});

describe('installUserAgentRelay', () => {
  function fakeScope() {
    const calls: Array<[unknown, RequestInit | undefined]> = [];
    const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response('ok');
    });
    return { scope: { fetch: fetch as unknown as typeof globalThis.fetch }, calls, fetch };
  }

  it('passes a call with no relay header through with the same arguments', async () => {
    const { scope, calls } = fakeScope();
    expect(installUserAgentRelay(scope)).toBe(true);
    const init: RequestInit = { headers: { 'x-api-key': 'k' } };
    await scope.fetch('https://mcp.example.test/rpc', init);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('https://mcp.example.test/rpc');
    expect(calls[0]?.[1]).toBe(init);
  });

  it('sends the relayed User-Agent and reports a refusal once, without the value', async () => {
    const { scope, calls } = fakeScope();
    const onRefused = vi.fn();
    installUserAgentRelay(scope, { onRefused });
    await scope.fetch('https://gw.example.test', { headers: { 'x-aiclient-user-agent': WANTED } });
    expect(sent(calls[0]?.[1])).toEqual({ 'user-agent': WANTED });
    await scope.fetch('https://gw.example.test', { headers: { 'x-aiclient-user-agent': 'a\tb' } });
    await scope.fetch('https://gw.example.test', { headers: { 'x-aiclient-user-agent': 'c\td' } });
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(onRefused).toHaveBeenCalledWith();
    expect(sent(calls[2]?.[1])).toEqual({});
  });

  it('wraps once: a second install is refused, and a scope without fetch is left alone', () => {
    const { scope } = fakeScope();
    expect(installUserAgentRelay(scope)).toBe(true);
    const wrapped = scope.fetch;
    expect(installUserAgentRelay(scope)).toBe(false);
    expect(scope.fetch).toBe(wrapped);
    const empty = { fetch: undefined as unknown as typeof globalThis.fetch };
    expect(installUserAgentRelay(empty)).toBe(false);
  });
});

describe("on the wire, through Node's own fetch", () => {
  const seen: Array<{ url: string; agents: string[]; relay: boolean }> = [];
  let base = '';
  const server = createServer((req: IncomingMessage, res) => {
    const agents: string[] = [];
    let relay = false;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = String(req.rawHeaders[i]).toLowerCase();
      if (name === 'user-agent') agents.push(String(req.rawHeaders[i + 1]));
      if (name === 'x-aiclient-user-agent') relay = true;
    }
    seen.push({ url: String(req.url), agents, relay });
    res.end('ok');
  });

  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('one User-Agent line with the relayed value; none of the relay header', async () => {
    const scope = { fetch: globalThis.fetch.bind(globalThis) as typeof globalThis.fetch };
    installUserAgentRelay(scope);
    // The shape pi-ai's SDKs and dsh-llm-pi-ai hand fetch: both spellings at once.
    await (
      await scope.fetch(`${base}/relayed`, {
        method: 'POST',
        body: '{}',
        headers: {
          'User-Agent': 'pi (linux)',
          'user-agent': DSH_AGENT,
          'X-Aiclient-User-Agent': WANTED,
        },
      })
    ).text();
    await (await scope.fetch(`${base}/untouched`, { headers: { 'user-agent': DSH_AGENT } })).text();
    expect(seen).toEqual([
      { url: '/relayed', agents: [WANTED], relay: false },
      { url: '/untouched', agents: [DSH_AGENT], relay: false },
    ]);
  });
});
