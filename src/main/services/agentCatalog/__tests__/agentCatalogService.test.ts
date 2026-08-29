import type { AgentWireName } from '@shared/types/agentWire';
import { describe, expect, it } from 'vitest';
import {
  AGENT_CATALOG_TTL_MS,
  type AgentCatalogCredentials,
  type AgentCatalogFetch,
  AgentCatalogService,
  parseModelListResponse,
  resolveModelsUrl,
} from '../AgentCatalogService';

/**
 * D48 S2 §4.8 — B1 (four-level fallback), B2 (single flight), B3 (cache keying)
 * and B4 (request contract + secret containment).
 *
 * Everything runs against the pure service with a fake `fetch`, a fake clock and
 * a fake vault, so no network is touched and no credential is read from this
 * machine. The one thing NOT faked is the digest: B4's secret scan is worthless
 * if the test supplies a digest that cannot leak.
 */

const CLAUDE_SECRET = 'sk-claude-live-DO-NOT-LEAK';
const CODEX_SECRET = 'sk-codex-live-DO-NOT-LEAK';
const CLAUDE_BASE = 'https://gateway.example.com/v1';
const CODEX_BASE = 'https://gateway.example.com/v1';

/** [实测 04-cch-live-probe §1], trimmed to what the filter has to decide about. */
const CLAUDE_BODY = JSON.stringify({
  data: [
    { id: 'claude-fable-5', type: 'model' },
    { id: 'claude-haiku-4-5', type: 'model' },
    { id: 'claude-opus-4-8', type: 'model' },
    { id: 'claude-opus-5', type: 'model' },
    { id: 'claude-sonnet-5', type: 'model' },
  ],
  has_more: false,
});

const CODEX_BODY = JSON.stringify({
  object: 'list',
  data: [
    { id: 'codex-auto-review', object: 'model' },
    { id: 'gpt-5.5', object: 'model' },
    { id: 'gpt-5.6-luna', object: 'model' },
    { id: 'gpt-5.6-sol', object: 'model' },
    { id: 'gpt-5.6-terra', object: 'model' },
    { id: 'gpt-image-2', object: 'model' },
  ],
});

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

interface Reply {
  ok?: boolean;
  status?: number;
  body?: string;
  throws?: Error;
}

interface Harness {
  service: AgentCatalogService;
  calls: FetchCall[];
  logs: string[];
  /** The reply the NEXT fetch gets; defaults to a 200 with the axis's body. */
  reply: { claude: Reply; codex: Reply };
  credentials: { value: AgentCatalogCredentials };
  advance(ms: number): void;
}

function makeHarness(options: { ttlMs?: number } = {}): Harness {
  const calls: FetchCall[] = [];
  const logs: string[] = [];
  let clock = 1_700_000_000_000;

  const reply: Harness['reply'] = { claude: {}, codex: {} };
  const credentials: Harness['credentials'] = {
    value: {
      status: 'ok',
      vault: {
        claude: { baseUrl: CLAUDE_BASE, authToken: CLAUDE_SECRET },
        codex: { baseUrl: CODEX_BASE, apiKey: CODEX_SECRET },
      },
    },
  };

  const fetchFn: AgentCatalogFetch = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    const axis = 'x-api-key' in init.headers ? 'claude' : 'codex';
    const configured = reply[axis];
    if (configured.throws) throw configured.throws;
    const body = configured.body ?? (axis === 'claude' ? CLAUDE_BODY : CODEX_BODY);
    const status = configured.status ?? 200;
    return { ok: configured.ok ?? status < 400, status, text: async () => body };
  };

  const service = new AgentCatalogService({
    fetchFn,
    readCredentials: () => credentials.value,
    now: () => clock,
    ttlMs: options.ttlMs,
    log: (...args) =>
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')),
  });

  return {
    service,
    calls,
    logs,
    reply,
    credentials,
    advance: (ms) => {
      clock += ms;
    },
  };
}

function idsOf(catalog: { models: Array<{ id: string }> }): string[] {
  return catalog.models.map((option) => option.id);
}

describe('B1 — the four-level fallback, one rung per case', () => {
  it('Pi bypasses vault/network/family filtering and returns provider/model ids', async () => {
    const calls: string[] = [];
    const service = new AgentCatalogService({
      fetchFn: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, text: async () => CLAUDE_BODY };
      },
      readCredentials: () => {
        throw new Error('Pi must not read Claude/Codex credentials');
      },
      readPiCatalog: () => ({
        agent: 'pi',
        models: [{ id: 'glm/glm-5', label: 'GLM 5' }],
        source: 'local',
        stale: false,
        fetchedAt: 1,
      }),
    });

    await expect(service.list({ agent: 'pi' })).resolves.toMatchObject({
      source: 'local',
      models: [{ id: 'glm/glm-5', label: 'GLM 5' }],
    });
    expect(calls).toEqual([]);
  });

  it('① a live answer is proxy/fresh, family-filtered', async () => {
    const h = makeHarness();
    const catalog = await h.service.list({ agent: 'claude-code' });

    expect(catalog.source).toBe('proxy');
    expect(catalog.stale).toBe(false);
    expect(catalog.fetchedAt).toBe(1_700_000_000_000);
    expect(catalog.error).toBeUndefined();
    // The renderer receives the FILTERED list — it never learns filtering exists.
    expect(idsOf(catalog)).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  });

  it('② a failed refresh falls back to the last success, marked stale', async () => {
    const h = makeHarness();
    await h.service.list({ agent: 'codex' });
    h.advance(AGENT_CATALOG_TTL_MS + 1);
    h.reply.codex = { status: 503 };

    const catalog = await h.service.list({ agent: 'codex' });
    expect(catalog.source).toBe('stale-cache');
    expect(catalog.stale).toBe(true);
    expect(catalog.error).toBe('http');
    // The models still work — the user can keep sending.
    expect(idsOf(catalog)).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  it('③ a first-ever failure falls back to the seed table, never to an empty menu', async () => {
    const h = makeHarness();
    h.reply.claude = { status: 500 };

    const catalog = await h.service.list({ agent: 'claude-code' });
    expect(catalog.source).toBe('seed');
    expect(catalog.stale).toBe(true);
    expect(catalog.fetchedAt).toBeNull();
    expect(catalog.error).toBe('http');
    expect(idsOf(catalog)).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  });

  it('④ credentials unavailable → seed, and the network is never touched', async () => {
    const h = makeHarness();
    h.credentials.value = { status: 'unavailable' };

    const catalog = await h.service.list({ agent: 'codex' });
    expect(catalog.source).toBe('seed');
    expect(catalog.error).toBe('credentials-unavailable');
    // The load-bearing half: a locked vault (E6, safeStorage before the first window)
    // must not throw and must not queue a request that would fail anyway.
    expect(h.calls).toHaveLength(0);
  });

  it('④ a blank base URL or a blank secret is the same narrow exit, still zero calls', async () => {
    const h = makeHarness();
    h.credentials.value = {
      status: 'ok',
      vault: {
        claude: { baseUrl: '', authToken: CLAUDE_SECRET },
        codex: { baseUrl: CODEX_BASE, apiKey: '   ' },
      },
    };

    expect((await h.service.list({ agent: 'claude-code' })).error).toBe('credentials-unavailable');
    expect((await h.service.list({ agent: 'codex' })).error).toBe('credentials-unavailable');
    expect(h.calls).toHaveLength(0);
  });

  it('a body that is not a model list is invalid-response, not a silent empty menu', async () => {
    const h = makeHarness();
    h.reply.claude = { body: '<html>502 Bad Gateway</html>' };

    const catalog = await h.service.list({ agent: 'claude-code' });
    expect(catalog.source).toBe('seed');
    expect(catalog.error).toBe('invalid-response');
  });

  it('a thrown request (DNS, abort) degrades the same way a 5xx does', async () => {
    const h = makeHarness();
    h.reply.codex = { throws: new Error('getaddrinfo ENOTFOUND gateway.example.com') };

    const catalog = await h.service.list({ agent: 'codex' });
    expect(catalog.source).toBe('seed');
    expect(catalog.error).toBe('http');
  });
});

describe('B1/B3 — the TTL decides freshness, and a failure never renews it', () => {
  it('serves from cache inside the window without a second call', async () => {
    const h = makeHarness();
    await h.service.list({ agent: 'claude-code' });
    h.advance(AGENT_CATALOG_TTL_MS - 1);
    const again = await h.service.list({ agent: 'claude-code' });

    expect(h.calls).toHaveLength(1);
    expect(again.source).toBe('proxy');
    expect(again.stale).toBe(false);
    expect(again.fetchedAt).toBe(1_700_000_000_000);
  });

  it('refetches once the window has passed', async () => {
    const h = makeHarness();
    await h.service.list({ agent: 'claude-code' });
    h.advance(AGENT_CATALOG_TTL_MS);
    const again = await h.service.list({ agent: 'claude-code' });

    expect(h.calls).toHaveLength(2);
    expect(again.fetchedAt).toBe(1_700_000_000_000 + AGENT_CATALOG_TTL_MS);
  });

  it('force refetches inside the window', async () => {
    const h = makeHarness();
    await h.service.list({ agent: 'claude-code' });
    await h.service.list({ agent: 'claude-code', force: true });

    expect(h.calls).toHaveLength(2);
  });

  it('a non-2xx overwrites neither the models nor fetchedAt', async () => {
    const h = makeHarness();
    const first = await h.service.list({ agent: 'codex' });
    h.advance(AGENT_CATALOG_TTL_MS + 5000);
    h.reply.codex = { status: 429, body: JSON.stringify({ data: [] }) };
    const failed = await h.service.list({ agent: 'codex' });

    expect(failed.fetchedAt).toBe(first.fetchedAt);
    expect(idsOf(failed)).toEqual(idsOf(first));

    // And the failure did not refresh the clock either: the very next call still
    // sees an expired entry and tries again.
    h.reply.codex = {};
    const recovered = await h.service.list({ agent: 'codex' });
    expect(h.calls).toHaveLength(3);
    expect(recovered.source).toBe('proxy');
  });
});

describe('B2 — one in-flight request per cache key', () => {
  it('three concurrent asks make exactly one call, and all three get the answer', async () => {
    const h = makeHarness();
    const [a, b, c] = await Promise.all([
      h.service.list({ agent: 'codex' }),
      h.service.list({ agent: 'codex' }),
      h.service.list({ agent: 'codex' }),
    ]);

    expect(h.calls).toHaveLength(1);
    for (const catalog of [a, b, c]) {
      expect(catalog.source).toBe('proxy');
      expect(idsOf(catalog)).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
    }
  });

  it('two different agents are two different keys, so both are fetched', async () => {
    const h = makeHarness();
    await Promise.all([
      h.service.list({ agent: 'codex' }),
      h.service.list({ agent: 'claude-code' }),
    ]);

    expect(h.calls).toHaveLength(2);
  });

  it('a later ask after the flight settled starts a new flight', async () => {
    const h = makeHarness();
    await h.service.list({ agent: 'codex', force: true });
    await h.service.list({ agent: 'codex', force: true });

    expect(h.calls).toHaveLength(2);
  });
});

describe('B3 — the cache key is agent + host + credential digest', () => {
  it('fetching one agent never answers for the other', async () => {
    const h = makeHarness();
    const claude = await h.service.list({ agent: 'claude-code' });
    const codex = await h.service.list({ agent: 'codex' });

    expect(h.calls).toHaveLength(2);
    expect(idsOf(claude)).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
    expect(idsOf(codex)).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
    expect(claude.agent).toBe('claude-code' satisfies AgentWireName);
    expect(codex.agent).toBe('codex' satisfies AgentWireName);
  });

  it('separates the axes even when BOTH share one gateway and one key', async () => {
    // The deployment that makes `agent` load-bearing in the key: a single cch
    // credential on a single host. Without the agent component the Codex ask is
    // answered out of the Claude entry — same host, same digest, same key — and
    // the user is offered `claude-opus-5` on a Codex session.
    const h = makeHarness();
    h.credentials.value = {
      status: 'ok',
      vault: {
        claude: { baseUrl: CLAUDE_BASE, authToken: 'one-key-for-both' },
        codex: { baseUrl: CLAUDE_BASE, apiKey: 'one-key-for-both' },
      },
    };

    const claude = await h.service.list({ agent: 'claude-code' });
    const codex = await h.service.list({ agent: 'codex' });

    expect(h.calls).toHaveLength(2);
    expect(idsOf(claude)).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
    expect(idsOf(codex)).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  it('a rotated credential misses the cache AND retires the old entry', async () => {
    const h = makeHarness();
    await h.service.list({ agent: 'codex' });
    expect(h.calls).toHaveLength(1);

    h.credentials.value = {
      status: 'ok',
      vault: {
        claude: { baseUrl: CLAUDE_BASE, authToken: CLAUDE_SECRET },
        codex: { baseUrl: CODEX_BASE, apiKey: 'sk-codex-ROTATED' },
      },
    };
    h.reply.codex = { body: JSON.stringify({ data: [{ id: 'gpt-5.7-nova' }] }) };
    const rotated = await h.service.list({ agent: 'codex' });
    expect(h.calls).toHaveLength(2);
    expect(idsOf(rotated)).toEqual(['gpt-5.7-nova']);

    // Rotate BACK and fail: the pre-rotation catalog must not come back to life
    // as a "stale" answer — it was evicted when the key changed.
    h.credentials.value = {
      status: 'ok',
      vault: {
        claude: { baseUrl: CLAUDE_BASE, authToken: CLAUDE_SECRET },
        codex: { baseUrl: CODEX_BASE, apiKey: CODEX_SECRET },
      },
    };
    h.reply.codex = { status: 401 };
    const back = await h.service.list({ agent: 'codex' });
    expect(back.source).toBe('seed');
  });

  it('a different gateway host is a different entry', async () => {
    const h = makeHarness();
    await h.service.list({ agent: 'codex' });
    h.credentials.value = {
      status: 'ok',
      vault: {
        claude: { baseUrl: CLAUDE_BASE, authToken: CLAUDE_SECRET },
        codex: { baseUrl: 'https://other.example.com/v1', apiKey: CODEX_SECRET },
      },
    };
    await h.service.list({ agent: 'codex' });

    expect(h.calls.map((call) => call.url)).toEqual([
      'https://gateway.example.com/v1/models',
      'https://other.example.com/v1/models',
    ]);
  });
});

describe('B4 — the request contract, per axis', () => {
  it('Claude authenticates with x-api-key, taken from vault claude.authToken', async () => {
    const h = makeHarness();
    await h.service.list({ agent: 'claude-code' });

    // Field name → header name, pinned together: `authToken` is a D47 name from
    // the ANTHROPIC_AUTH_TOKEN lineage and does NOT mean bearer.
    expect(h.calls[0].headers['x-api-key']).toBe(CLAUDE_SECRET);
    expect(h.calls[0].headers.Authorization).toBeUndefined();
  });

  it('Codex authenticates with a Bearer token, taken from vault codex.apiKey', async () => {
    const h = makeHarness();
    await h.service.list({ agent: 'codex' });

    expect(h.calls[0].headers.Authorization).toBe(`Bearer ${CODEX_SECRET}`);
    expect(h.calls[0].headers['x-api-key']).toBeUndefined();
  });

  it('normalizes the base URL without ever producing /v1/v1', () => {
    expect(resolveModelsUrl('https://g.example.com/v1')).toBe('https://g.example.com/v1/models');
    expect(resolveModelsUrl('https://g.example.com/v1/')).toBe('https://g.example.com/v1/models');
    expect(resolveModelsUrl('https://g.example.com')).toBe('https://g.example.com/v1/models');
    expect(resolveModelsUrl('  https://g.example.com//  ')).toBe('https://g.example.com/v1/models');
  });

  it('reads {data:[{id}]} on both dialects and refuses everything else', () => {
    expect(parseModelListResponse(CODEX_BODY)).toContain('gpt-5.6-sol');
    expect(parseModelListResponse(CLAUDE_BODY)).toContain('claude-opus-5');
    expect(parseModelListResponse('not json')).toBeNull();
    expect(parseModelListResponse(JSON.stringify({ models: ['a'] }))).toBeNull();
    expect(parseModelListResponse(JSON.stringify({ data: [{ id: 1 }, { id: '  ' }] }))).toEqual([]);
  });

  it('leaks no secret into the log or into the renderer payload — success and failure', async () => {
    const h = makeHarness();
    h.reply.claude = { status: 401, body: JSON.stringify({ error: { key: CLAUDE_SECRET } }) };
    const failed = await h.service.list({ agent: 'claude-code' });
    const ok = await h.service.list({ agent: 'codex' });

    const surface = [...h.logs, JSON.stringify(failed), JSON.stringify(ok)].join('\n');
    for (const secret of [CLAUDE_SECRET, CODEX_SECRET, 'Bearer ']) {
      expect(surface).not.toContain(secret);
    }
    // The response body of a failed auth call routinely echoes the key back —
    // so no body, whole or in part, may reach the log either.
    expect(surface).not.toContain('502 Bad Gateway');
    expect(surface).not.toContain('"error":{');
    // What IS logged: enough to debug a gateway problem.
    expect(h.logs.join('\n')).toContain('gateway.example.com');
    expect(h.logs.join('\n')).toContain('401');
  });

  it('keeps URL userinfo out of the log, even when the vault carries some', async () => {
    const h = makeHarness();
    h.credentials.value = {
      status: 'ok',
      vault: {
        claude: { baseUrl: 'https://user:hunter2@gateway.example.com/v1', authToken: 'tok' },
        codex: { baseUrl: CODEX_BASE, apiKey: CODEX_SECRET },
      },
    };
    h.reply.claude = { status: 500 };
    const result = await h.service.list({ agent: 'claude-code' });

    const surface = [...h.logs, JSON.stringify(result)].join('\n');
    expect(surface).not.toContain('hunter2');
    expect(surface).not.toContain('user:');
  });
});
