import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validatePiManagedModelsConfig } from '../configValidation';
import { type PiModelConfigFetch, PiModelConfigService } from '../PiModelConfigService';

const REMOTE_CONFIG = {
  version: 1,
  updatedAt: '2026-08-28T00:00:00.000Z',
  providers: {
    dan: {
      name: 'Company Dan',
      baseUrl: 'https://models.example.com/v1',
      api: 'openai-responses',
      authHeader: true,
      models: [
        {
          id: 'deepseek-v4',
          name: 'DeepSeek V4',
          tags: ['国产', 'reasoning'],
          reasoning: true,
          thinkingLevelMap: { low: 'low', high: 'high', max: null },
          contextWindow: 128000,
          maxTokens: 32000,
        },
      ],
    },
  },
};

describe('PiModelConfigService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-model-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function service(fetchFn: PiModelConfigFetch, now = 1234): PiModelConfigService {
    return new PiModelConfigService({ agentDir: dir, fetchFn, now: () => now });
  }

  it('writes validated metadata and provider-scoped auth separately', async () => {
    const apiKey = 'company-secret-never-in-models';
    const result = await service(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(REMOTE_CONFIG),
    })).sync({
      endpointUrl: 'http://127.0.0.1:3210/api/v1/models-config',
      apiKey,
      fallbackBaseUrl: 'https://fallback.example/v1',
    });

    expect(result.source).toBe('remote');
    expect(result.modelCount).toBe(1);
    const modelsText = readFileSync(join(dir, 'models.json'), 'utf8');
    const authText = readFileSync(join(dir, 'auth.json'), 'utf8');
    expect(modelsText).not.toContain(apiKey);
    expect(modelsText).not.toContain('apiKey');
    expect(authText).toContain(apiKey);
    expect(JSON.parse(authText)).toEqual({ dan: { type: 'api_key', key: apiKey } });
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'models.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'auth.json')).mode & 0o777).toBe(0o600);
    }
    expect(
      service(async () => ({ ok: false, status: 500, text: async () => '' })).readCatalog()
    ).toMatchObject({
      source: 'managed',
      stale: false,
      models: [
        {
          id: 'dan/deepseek-v4',
          label: 'DeepSeek V4',
          tags: ['国产', 'reasoning'],
          reasoning: true,
          thinkingLevelMap: { low: 'low', high: 'high', max: null },
        },
      ],
    });
  });

  it('reuses a fresh remote snapshot at startup but force refresh bypasses the TTL', async () => {
    let calls = 0;
    const fetchFn: PiModelConfigFetch = async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(REMOTE_CONFIG) };
    };
    await service(fetchFn, 1000).sync({
      endpointUrl: 'https://admin.example/config',
      apiKey: 'key-1',
      fallbackBaseUrl: 'https://fallback.example/v1',
    });
    await service(fetchFn, 2000).sync({
      endpointUrl: 'https://admin.example/config',
      apiKey: 'key-2',
      fallbackBaseUrl: 'https://fallback.example/v1',
    });
    expect(calls).toBe(1);
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toContain('key-2');

    await service(fetchFn, 3000).sync({
      endpointUrl: 'https://admin.example/config',
      apiKey: 'key-3',
      fallbackBaseUrl: 'https://fallback.example/v1',
      force: true,
    });
    expect(calls).toBe(2);
  });

  it('keeps a valid cache when the management endpoint fails and rotates auth', async () => {
    const good = service(
      async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(REMOTE_CONFIG),
      }),
      1000
    );
    await good.sync({
      endpointUrl: 'https://admin.example/config',
      apiKey: 'old-key',
      fallbackBaseUrl: 'https://fallback.example/v1',
    });

    const failed = service(
      async () => ({ ok: false, status: 503, text: async () => 'down' }),
      2000
    );
    const result = await failed.sync({
      endpointUrl: 'https://admin.example/config',
      apiKey: 'new-key',
      fallbackBaseUrl: 'https://fallback.example/v1',
      force: true,
    });

    expect(result.source).toBe('stale-cache');
    expect(result.ok).toBe(true);
    expect(result.syncedAt).toBe(1000);
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toContain('new-key');
    expect(failed.readCatalog()).toMatchObject({
      source: 'stale-cache',
      stale: true,
      error: 'http',
    });
  });

  it('creates the built-in managed fallback when neither remote nor cache exists', async () => {
    const result = await service(async () => {
      throw new Error('connection refused');
    }).sync({
      endpointUrl: 'http://127.0.0.1:3210/api/v1/models-config',
      apiKey: 'company-key',
      fallbackBaseUrl: 'https://gateway.example.com/v1',
    });

    expect(result.source).toBe('seed');
    expect(result.modelCount).toBe(3);
    expect(existsSync(join(dir, 'models.json'))).toBe(true);
    expect(
      service(async () => ({ ok: false, status: 500, text: async () => '' })).readCatalog().models
    ).toHaveLength(3);
  });

  it('reads a user-owned models.json without requiring the managed schema envelope', () => {
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        providers: {
          glm: {
            baseUrl: 'https://glm.example/v1',
            apiKey: '$GLM_KEY',
            models: [
              {
                id: 'glm-5',
                tags: ['国产', 'fast'],
                reasoning: true,
                thinkingLevelMap: { low: 'low', medium: 'medium', high: 42 },
              },
              { id: 'glm-5-air', name: 'GLM 5 Air' },
            ],
          },
        },
      })
    );
    expect(
      service(async () => ({ ok: false, status: 500, text: async () => '' })).readCatalog('local')
    ).toMatchObject({
      source: 'local',
      stale: false,
      models: [
        {
          id: 'glm/glm-5',
          label: 'glm-5',
          tags: ['国产', 'fast'],
          reasoning: true,
          thinkingLevelMap: { low: 'low', medium: 'medium' },
        },
        { id: 'glm/glm-5-air', label: 'GLM 5 Air' },
      ],
    });
  });

  // T38-b: the occupancy surfaces need the window the configuration declares.
  // It used to be parsed and then dropped by `piModelOption`.
  it('carries contextWindow through both the managed and the user-owned catalog', async () => {
    const managed = service(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(REMOTE_CONFIG),
    }));
    await managed.sync({
      endpointUrl: 'https://admin.example/config',
      apiKey: 'key-1',
      fallbackBaseUrl: 'https://fallback.example/v1',
    });
    expect(managed.readCatalog().models).toEqual([
      expect.objectContaining({ id: 'dan/deepseek-v4', contextWindow: 128000 }),
    ]);

    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        providers: {
          glm: {
            baseUrl: 'https://glm.example/v1',
            models: [
              { id: 'glm-5', contextWindow: 200000 },
              // Unstated, zero and non-numeric all mean "nobody said" — the
              // surface must show no denominator rather than guess one.
              { id: 'glm-5-air' },
              { id: 'glm-5-flash', contextWindow: 0 },
              { id: 'glm-5-lite', contextWindow: '128k' },
            ],
          },
        },
      })
    );
    const local = service(async () => ({ ok: false, status: 500, text: async () => '' }));
    expect(
      local.readCatalog('local').models.map((model) => [model.id, model.contextWindow])
    ).toEqual([
      ['glm/glm-5', 200000],
      ['glm/glm-5-air', undefined],
      ['glm/glm-5-flash', undefined],
      ['glm/glm-5-lite', undefined],
    ]);
  });
});

describe('validatePiManagedModelsConfig', () => {
  it('accepts ordered tags and remains compatible when tags are absent', () => {
    const validated = validatePiManagedModelsConfig(REMOTE_CONFIG);
    expect(validated.providers.dan.models[0]?.tags).toEqual(['国产', 'reasoning']);
    const withoutTags = validatePiManagedModelsConfig({
      ...REMOTE_CONFIG,
      providers: {
        dan: {
          ...REMOTE_CONFIG.providers.dan,
          models: [{ id: 'plain', reasoning: false }],
        },
      },
    });
    expect(withoutTags.providers.dan.models[0]?.tags).toBeUndefined();
  });

  it('rejects malformed tags', () => {
    expect(() =>
      validatePiManagedModelsConfig({
        ...REMOTE_CONFIG,
        providers: {
          dan: {
            ...REMOTE_CONFIG.providers.dan,
            models: [{ id: 'bad', tags: ['ok', ''] }],
          },
        },
      })
    ).toThrow(/tags\[1\]/);
  });

  it('rejects credentials in provider or model metadata', () => {
    expect(() =>
      validatePiManagedModelsConfig({
        ...REMOTE_CONFIG,
        providers: { dan: { ...REMOTE_CONFIG.providers.dan, apiKey: 'secret' } },
      })
    ).toThrow(/credentials/);
    expect(() =>
      validatePiManagedModelsConfig({
        ...REMOTE_CONFIG,
        providers: {
          dan: {
            ...REMOTE_CONFIG.providers.dan,
            models: [{ ...REMOTE_CONFIG.providers.dan.models[0], token: 'secret' }],
          },
        },
      })
    ).toThrow(/credentials/);
  });
});
