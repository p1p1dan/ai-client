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

  it('reports an empty key instead of failing, because a provider may need none', async () => {
    const dir = fixture({ models });
    expect((await readPiCatalog(dir, {}, ctx.runtimeHostIo)).providers[0].apiKey).toBe('');
  });

  it('drops a provider whose rows are all unusable rather than offering an empty choice', async () => {
    const dir = fixture({
      models: {
        providers: {
          broken: { api: 'openai-completions', models: [{ name: 'no id here' }] },
          fine: { api: 'openai-completions', models: [{ id: 'gpt-x' }] },
        },
      },
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
            models: [{ id: 'a' }, { id: 'b', api: 'openai-responses' }],
          },
        },
      },
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
    const catalog = await readPiCatalog(fixture({ models: { providers } }), {}, ctx.runtimeHostIo);
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
          fine: { api: 'openai-completions', models: [{ id: 'gpt-x' }] },
        },
      },
    });
    const catalog = await readPiCatalog(dir, {}, ctx.runtimeHostIo);
    expect(catalog.providers.map((p) => p.id)).toEqual(['fine']);
    expect(catalog.dropped).toEqual([
      { id: 'my-thing', reason: 'unknown_api', detail: 'opencode_go' },
    ]);
  });

  it('records the reason for a provider with no usable row', async () => {
    const dir = fixture({
      models: { providers: { broken: { api: 'openai-completions', models: [{ name: 'no id' }] } } },
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
    });
    const provider = (await readPiCatalog(dir, {}, ctx.runtimeHostIo)).providers[0];
    expect(provider.models.map((m) => m.baseUrl)).toEqual([undefined, 'https://other.example/v2']);
    expect(provider.models.map((m) => buildModel(provider, m).baseUrl)).toEqual([
      'https://gw.example/v1',
      'https://other.example/v2',
    ]);
  });
});
