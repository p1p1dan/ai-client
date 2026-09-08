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
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeConfigError } from '../contracts.ts';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  expandHeaders,
  readPiCatalog,
} from '../plugins/model-adapter/catalog.ts';

const dirs: string[] = [];

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

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe('expandHeaders', () => {
  it('resolves a $NAME reference from the environment', () => {
    expect(expandHeaders({ 'User-Agent': '$UA' }, { UA: 'claude-cli-pilab/1.2.3' })).toEqual({
      'User-Agent': 'claude-cli-pilab/1.2.3',
    });
  });

  it('drops a reference that resolves to nothing rather than sending it empty', () => {
    expect(expandHeaders({ 'User-Agent': '$UA' }, {})).toEqual({});
    expect(expandHeaders({ 'User-Agent': '$UA' }, { UA: '   ' })).toEqual({});
  });

  it('passes a literal value through, because refusing a hand-written config is not its call', () => {
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

  it('joins models.json with the per-provider key from auth.json', () => {
    const dir = fixture({
      models,
      auth: { gateway: { type: 'api_key', key: 'sk-test' } },
    });
    const catalog = readPiCatalog(dir, { AICLIENT_PI_USER_AGENT: 'claude-cli-pilab/0.4.0' });
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

  it('reports an empty key instead of failing, because a provider may need none', () => {
    const dir = fixture({ models });
    expect(readPiCatalog(dir, {}).providers[0].apiKey).toBe('');
  });

  it('drops a provider whose rows are all unusable rather than offering an empty choice', () => {
    const dir = fixture({
      models: {
        providers: {
          broken: { api: 'openai-completions', models: [{ name: 'no id here' }] },
          fine: { api: 'openai-completions', models: [{ id: 'gpt-x' }] },
        },
      },
    });
    expect(readPiCatalog(dir, {}).providers.map((p) => p.id)).toEqual(['fine']);
  });

  it('lets a model row override its provider api', () => {
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
    const provider = readPiCatalog(dir, {}).providers[0];
    expect(provider.models.map((m) => m.api)).toEqual(['openai-completions', 'openai-responses']);
  });

  it('names the missing file when models.json is absent', () => {
    const dir = fixture({});
    expect(() => readPiCatalog(dir, {})).toThrow(RuntimeConfigError);
    try {
      readPiCatalog(dir, {});
    } catch (error) {
      expect((error as RuntimeConfigError).code).toBe('models_json_missing');
      expect((error as Error).message).toContain('models.json');
    }
  });

  it('rejects a models.json with no providers object', () => {
    const dir = fixture({ models: { version: 1 } });
    try {
      readPiCatalog(dir, {});
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as RuntimeConfigError).code).toBe('models_json_shape');
    }
  });
});
