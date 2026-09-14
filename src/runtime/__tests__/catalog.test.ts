/**
 * Reading the catalog the app writes.
 *
 * The cases that matter are the ones where a wrong reader would fail SILENTLY:
 * an unexpanded `$NAME` header reaching the gateway as a literal, a provider
 * whose key is missing being treated as configured, a model row with no context
 * window getting a zero-sized window. Each of those produces a request that
 * looks fine locally and is wrong on the wire.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from 'cordis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_PROVIDER_APIS } from '../../shared/userProviders.ts';
import { RuntimeConfigError } from '../contracts.ts';
import { standaloneHost } from '../host/config.ts';
import { ExecPlugin } from '../host/exec.ts';
import { HostIoPlugin } from '../host/io.ts';
import { buildModel, buildProviderModels } from '../plugins/model-adapter/binding.ts';
import {
  CATALOG_APIS,
  type CatalogApi,
  type CatalogModel,
  type CatalogProvider,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  expandHeaders,
  readPiCatalog,
} from '../plugins/model-adapter/catalog.ts';

const dirs: string[] = [];
let ctx: Context;
beforeEach(async () => {
  ctx = new Context();
  await ctx.plugin(ExecPlugin, standaloneHost({}));
  const fiber = await ctx.plugin(HostIoPlugin, standaloneHost({}));
  await fiber.await();
});

function fixture(files: { models?: unknown; auth?: unknown }): string {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-catalog-'));
  dirs.push(dir);
  if (files.models !== undefined) {
    writeFileSync(join(dir, 'models.json'), JSON.stringify(files.models));
  }
  if (files.auth !== undefined) {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(files.auth));
  }
  return dir;
}

afterEach(async () => {
  await ctx.fiber.dispose();
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe('expandHeaders', () => {
  it('resolves a $NAME reference from the environment', async () => {
    expect(expandHeaders({ 'User-Agent': '$UA' }, { UA: 'claude-cli-pilab/1.2.3' })).toEqual({
      'User-Agent': 'claude-cli-pilab/1.2.3',
    });
  });

  it('drops a reference that resolves to nothing rather than sending it empty', async () => {
    expect(expandHeaders({ 'User-Agent': '$UA' }, {})).toEqual({});
    expect(expandHeaders({ 'User-Agent': '$UA' }, { UA: '   ' })).toEqual({});
  });

  it('passes a literal value through, because refusing a hand-written config is not its call', async () => {
    expect(expandHeaders({ 'X-Trace': 'on' }, {})).toEqual({ 'X-Trace': 'on' });
  });
});

describe('readPiCatalog', () => {
  const models = {
    providers: {
      gateway: {
        api: 'anthropic-messages',
        baseUrl: 'https://gateway.example/v1',
        headers: { 'User-Agent': '$AICLIENT_PI_USER_AGENT' },
        models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', reasoning: true }],
      },
    },
  };

  it('joins models.json with the per-provider key from auth.json', async () => {
    const dir = fixture({
      models,
      auth: { gateway: { type: 'api_key', key: 'sk-test' } },
    });
    const catalog = await readPiCatalog(
      dir,
      { AICLIENT_PI_USER_AGENT: 'claude-cli-pilab/0.4.0' },
      ctx.runtimeHostIo
    );
    expect(catalog.providers).toHaveLength(1);
    const provider = catalog.providers[0];
    expect(provider.apiKey).toBe('sk-test');
    expect(provider.headers).toEqual({ 'User-Agent': 'claude-cli-pilab/0.4.0' });
    expect(provider.models[0]).toMatchObject({
      id: 'claude-sonnet-5',
      name: 'Sonnet 5',
      api: 'anthropic-messages',
      reasoning: true,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  });

  it('reports an empty key instead of failing, because a protocol may need none', async () => {
    // `bedrock-converse-stream` authenticates from the ambient AWS profile, so
    // no entry in `auth.json` is a working configuration for it — which is what
    // separates it from the key-requiring styles dropped below.
    const dir = fixture({
      models: {
        providers: {
          aws: {
            api: 'bedrock-converse-stream',
            baseUrl: 'https://bedrock.example',
            models: [{ id: 'claude-on-bedrock' }],
          },
        },
      },
    });
    const catalog = await readPiCatalog(dir, {}, ctx.runtimeHostIo);
    expect(catalog.providers[0].apiKey).toBe('');
    expect(catalog.dropped).toEqual([]);
  });

  it('drops a provider whose rows are all unusable rather than offering an empty choice', async () => {
    const dir = fixture({
      models: {
        providers: {
          broken: {
            api: 'openai-completions',
            baseUrl: 'https://x.example',
            models: [{ name: 'no id here' }],
          },
          fine: {
            api: 'openai-completions',
            baseUrl: 'https://x.example',
            models: [{ id: 'gpt-x' }],
          },
        },
      },
      auth: { broken: { type: 'api_key', key: 'k' }, fine: { type: 'api_key', key: 'k' } },
    });
    expect((await readPiCatalog(dir, {}, ctx.runtimeHostIo)).providers.map((p) => p.id)).toEqual([
      'fine',
    ]);
  });

  it('lets a model row override its provider api', async () => {
    const dir = fixture({
      models: {
        providers: {
          mixed: {
            api: 'openai-completions',
            baseUrl: 'https://x.example',
            models: [{ id: 'a' }, { id: 'b', api: 'openai-responses' }],
          },
        },
      },
      auth: { mixed: { type: 'api_key', key: 'k' } },
    });
    const provider = (await readPiCatalog(dir, {}, ctx.runtimeHostIo)).providers[0];
    expect(provider.models.map((m) => m.api)).toEqual(['openai-completions', 'openai-responses']);
  });

  it('names the missing file when models.json is absent', async () => {
    const dir = fixture({});
    await expect(readPiCatalog(dir, {}, ctx.runtimeHostIo)).rejects.toThrow(RuntimeConfigError);
    try {
      await readPiCatalog(dir, {}, ctx.runtimeHostIo);
    } catch (error) {
      expect((error as RuntimeConfigError).code).toBe('models_json_missing');
      expect((error as Error).message).toContain('models.json');
    }
  });

  it('rejects a models.json with no providers object', async () => {
    const dir = fixture({ models: { version: 1 } });
    try {
      await readPiCatalog(dir, {}, ctx.runtimeHostIo);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as RuntimeConfigError).code).toBe('models_json_shape');
    }
  });

  /**
   * P5-5. The regression these guard is not a crash: before this node, a user
   * service saved under one of the six styles the managed whitelist does not
   * name was read, found unrecognised, and dropped without a word. The service
   * was in the settings page and absent from the model picker, with nothing
   * anywhere saying why.
   */
  it('binds every API style the user-service form is allowed to offer', async () => {
    const providers = Object.fromEntries(
      USER_PROVIDER_APIS.map((api) => [
        api,
        { api, baseUrl: 'https://x.example', models: [{ id: `${api}-m` }] },
      ])
    );
    const auth = Object.fromEntries(
      USER_PROVIDER_APIS.map((api) => [api, { type: 'api_key', key: 'k' }])
    );
    const catalog = await readPiCatalog(
      fixture({ models: { providers }, auth }),
      {},
      ctx.runtimeHostIo
    );
    expect(catalog.providers.map((p) => p.id).sort()).toEqual([...USER_PROVIDER_APIS].sort());
    expect(catalog.dropped).toEqual([]);
  });

  it('has an adapter for every style the catalog accepts', () => {
    for (const api of CATALOG_APIS) {
      const provider = {
        id: api,
        baseUrl: 'https://x.example',
        headers: {},
        api,
        models: [
          {
            id: 'm',
            name: 'm',
            api,
            reasoning: false,
            input: ['text' as const],
            contextWindow: 1,
            maxTokens: 1,
          },
        ],
        apiKey: 'k',
      };
      expect(() => buildProviderModels(provider)).not.toThrow();
    }
  });

  it('reports a style it cannot speak instead of dropping it in silence', async () => {
    const dir = fixture({
      models: {
        providers: {
          'my-thing': { api: 'opencode_go', models: [{ id: 'a' }] },
          fine: {
            api: 'openai-completions',
            baseUrl: 'https://x.example',
            models: [{ id: 'gpt-x' }],
          },
        },
      },
      auth: { fine: { type: 'api_key', key: 'k' } },
    });
    const catalog = await readPiCatalog(dir, {}, ctx.runtimeHostIo);
    expect(catalog.providers.map((p) => p.id)).toEqual(['fine']);
    expect(catalog.dropped).toEqual([
      { id: 'my-thing', reason: 'unknown_api', detail: 'opencode_go' },
    ]);
  });

  it('records the reason for a provider with no usable row', async () => {
    const dir = fixture({
      models: {
        providers: {
          broken: {
            api: 'openai-completions',
            baseUrl: 'https://x.example',
            models: [{ name: 'no id' }],
          },
        },
      },
      auth: { broken: { type: 'api_key', key: 'k' } },
    });
    expect((await readPiCatalog(dir, {}, ctx.runtimeHostIo)).dropped).toEqual([
      { id: 'broken', reason: 'no_usable_model' },
    ]);
  });

  it("lets a model row state its own address, overriding the provider's (ARD D15)", async () => {
    const dir = fixture({
      models: {
        providers: {
          gw: {
            api: 'openai-completions',
            baseUrl: 'https://gw.example/v1',
            models: [{ id: 'shared' }, { id: 'special', baseUrl: 'https://other.example/v2' }],
          },
        },
      },
      auth: { gw: { type: 'api_key', key: 'k' } },
    });
    const provider = (await readPiCatalog(dir, {}, ctx.runtimeHostIo)).providers[0];
    expect(provider.models.map((m) => m.baseUrl)).toEqual([undefined, 'https://other.example/v2']);
    expect(provider.models.map((m) => buildModel(provider, m).baseUrl)).toEqual([
      'https://gw.example/v1',
      'https://other.example/v2',
    ]);
  });

  /**
   * loop-model-08. An empty `baseUrl` is not an error the SDK reports: the
   * OpenAI and Anthropic clients both read `baseURL || <vendor default>`, so
   * this provider would have taken an administrator's key to the vendor's
   * public endpoint. The address has to be judged here, where "no address" is
   * still distinguishable from "the wrong address".
   */
  it('drops a row with no address instead of letting the SDK use its vendor default', async () => {
    const dir = fixture({
      models: { providers: { gw: { api: 'openai-completions', models: [{ id: 'gpt-x' }] } } },
      auth: { gw: { type: 'api_key', key: 'sk-managed' } },
    });
    const catalog = await readPiCatalog(dir, {}, ctx.runtimeHostIo);
    expect(catalog.providers).toEqual([]);
    expect(catalog.dropped).toEqual([{ id: 'gw', reason: 'no_base_url', detail: 'gpt-x' }]);
  });

  it('keeps the rows that state their own address when the provider has none', async () => {
    const dir = fixture({
      models: {
        providers: {
          gw: {
            api: 'openai-completions',
            models: [{ id: 'homeless' }, { id: 'housed', baseUrl: 'https://other.example/v2' }],
          },
        },
      },
      auth: { gw: { type: 'api_key', key: 'k' } },
    });
    const catalog = await readPiCatalog(dir, {}, ctx.runtimeHostIo);
    expect(catalog.providers[0].models.map((m) => m.id)).toEqual(['housed']);
    expect(catalog.dropped).toEqual([{ id: 'gw', reason: 'no_base_url', detail: 'homeless' }]);
  });

  /**
   * loop-model-04. pi-ai throws `No API key for provider: <id>` at the top of
   * `streamSimple`, before a request exists — a failure the retry layer cannot
   * tell from a transient fault, so the user waited 3+10+30 seconds for it.
   * Deciding it here costs nothing and says which provider.
   */
  it('drops a key-requiring provider that auth.json has no key for', async () => {
    const dir = fixture({
      models: {
        providers: {
          gw: {
            api: 'anthropic-messages',
            baseUrl: 'https://gw.example',
            models: [{ id: 'claude-sonnet-5' }],
          },
        },
      },
    });
    const catalog = await readPiCatalog(dir, {}, ctx.runtimeHostIo);
    expect(catalog.providers).toEqual([]);
    expect(catalog.dropped).toEqual([
      { id: 'gw', reason: 'no_api_key', detail: 'claude-sonnet-5' },
    ]);
  });

  it('treats an Authorization header as the key pi-ai will accept in its place', async () => {
    const dir = fixture({
      models: {
        providers: {
          gw: {
            api: 'openai-completions',
            baseUrl: 'https://gw.example/v1',
            headers: { Authorization: '$GW_TOKEN' },
            models: [{ id: 'gpt-x' }],
          },
        },
      },
    });
    const catalog = await readPiCatalog(dir, { GW_TOKEN: 'Bearer t' }, ctx.runtimeHostIo);
    expect(catalog.providers.map((p) => p.id)).toEqual(['gw']);
    expect(catalog.dropped).toEqual([]);
  });

  /**
   * loop-model-07. `models.json` has always named itself when it cannot be
   * parsed; `auth.json` used to return null, which is indistinguishable from
   * "the file is not there yet" and leaves every provider keyless with nothing
   * anywhere saying why.
   */
  it('names auth.json when it exists and cannot be parsed', async () => {
    const dir = fixture({ models });
    writeFileSync(join(dir, 'auth.json'), '{ "gateway": ');
    try {
      await readPiCatalog(dir, {}, ctx.runtimeHostIo);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as RuntimeConfigError).code).toBe('auth_json_unparsable');
      expect((error as Error).message).toContain('auth.json');
    }
  });

  it('names auth.json when it parses to something that is not an object', async () => {
    const dir = fixture({ models, auth: ['not', 'a', 'map'] });
    try {
      await readPiCatalog(dir, {}, ctx.runtimeHostIo);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as RuntimeConfigError).code).toBe('auth_json_unparsable');
    }
  });
});

/**
 * loop-model-01 / loop-model-02 — what leaves the process, not what the objects
 * hold.
 *
 * Both defects were invisible to an assertion on the catalog or the pi-ai
 * objects: the expanded headers WERE on the provider object, and the overriding
 * `api` WAS on the model. Neither reached a request. These drive a real
 * `streamSimple` through a fetch that records what it was asked to send.
 */
describe('what the bound provider puts on the wire', () => {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(
      (init?.headers ?? undefined) as ConstructorParameters<typeof Headers>[0]
    );
    sent.push({
      url: input instanceof Request ? input.url : String(input),
      headers: Object.fromEntries(headers.entries()),
    });
    // 400 rather than a throw or a 5xx: the vendor SDKs retry the retriable
    // ones, and this test wants exactly one request per call.
    return new Response('{"error":{"message":"recorded"}}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  };

  beforeEach(() => {
    sent.length = 0;
  });

  function catalogProvider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
    return {
      id: 'gateway',
      baseUrl: 'https://gateway.example/v1',
      headers: {},
      api: 'openai-completions',
      models: [row('gpt-x', 'openai-completions')],
      apiKey: 'sk-test',
      ...overrides,
    };
  }

  function row(id: string, api: CatalogApi): CatalogModel {
    return {
      id,
      name: id,
      api,
      reasoning: false,
      input: ['text'],
      contextWindow: 128_000,
      maxTokens: 4_096,
    };
  }

  async function request(provider: CatalogProvider, modelId: string): Promise<void> {
    const models = buildProviderModels(provider);
    const model = models.getModel(provider.id, modelId);
    if (!model) throw new Error(`no model ${modelId}`);
    await models
      .streamSimple(
        model,
        { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
        { fetch: recordingFetch, maxRetries: 0 }
      )
      .result();
  }

  it('sends the expanded provider header on the request itself', async () => {
    await request(
      catalogProvider({ headers: { 'User-Agent': 'claude-cli-pilab/0.4.0', 'X-Tenant': 'lab' } }),
      'gpt-x'
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['user-agent']).toBe('claude-cli-pilab/0.4.0');
    expect(sent[0].headers['x-tenant']).toBe('lab');
  });

  it("sends pi-ai's own User-Agent when the catalog states no header", async () => {
    await request(catalogProvider(), 'gpt-x');
    expect(sent).toHaveLength(1);
    expect(sent[0].headers['user-agent']).toBeDefined();
    expect(sent[0].headers['user-agent']).not.toBe('claude-cli-pilab/0.4.0');
  });

  it('dispatches a row that overrides its api through that row’s adapter', async () => {
    const provider = catalogProvider({
      models: [row('gpt-x', 'openai-completions'), row('o-next', 'openai-responses')],
    });
    await request(provider, 'gpt-x');
    await request(provider, 'o-next');
    // Two protocols, two endpoints. Before the api map both rows went to
    // /chat/completions, because a single adapter streams every row.
    expect(sent.map((entry) => new URL(entry.url).pathname)).toEqual([
      '/v1/chat/completions',
      '/v1/responses',
    ]);
  });
});
