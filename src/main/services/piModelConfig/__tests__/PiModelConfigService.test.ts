import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PI_USER_AGENT_ENV, PI_USER_AGENT_HEADER } from '@shared/piModelConfig';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toPiModelsJson, validatePiManagedModelsConfig } from '../configValidation';
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
      inheritedBaseUrl: 'https://fallback.example/v1',
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
      inheritedBaseUrl: 'https://fallback.example/v1',
    });
    await service(fetchFn, 2000).sync({
      endpointUrl: 'https://admin.example/config',
      apiKey: 'key-2',
      inheritedBaseUrl: 'https://fallback.example/v1',
    });
    expect(calls).toBe(1);
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toContain('key-2');

    await service(fetchFn, 3000).sync({
      endpointUrl: 'https://admin.example/config',
      apiKey: 'key-3',
      inheritedBaseUrl: 'https://fallback.example/v1',
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
      inheritedBaseUrl: 'https://fallback.example/v1',
    });

    const failed = service(
      async () => ({ ok: false, status: 503, text: async () => 'down' }),
      2000
    );
    const result = await failed.sync({
      endpointUrl: 'https://admin.example/config',
      apiKey: 'new-key',
      inheritedBaseUrl: 'https://fallback.example/v1',
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

  // D03: the built-in three-model table is gone. A failed fetch with nothing
  // cached says so instead of handing out models nobody configured.
  it('reports the catalog as unavailable when neither remote nor cache exists', async () => {
    const result = await service(async () => {
      throw new Error('connection refused');
    }).sync({
      endpointUrl: 'https://onboard.example/api/v1/models-config',
      apiKey: 'company-key',
      inheritedBaseUrl: 'https://gateway.example.com/v1',
    });

    expect(result.source).toBe('unavailable');
    expect(result.ok).toBe(false);
    expect(result.modelCount).toBe(0);
    expect(existsSync(join(dir, 'models.json'))).toBe(false);
    expect(
      service(async () => ({ ok: false, status: 500, text: async () => '' })).readCatalog()
    ).toMatchObject({ source: 'unavailable', stale: true, models: [], error: 'http' });
  });

  // D01: the endpoint only answers a client that proves who it is, because the
  // answer may carry provider keys.
  it('presents the login key as a bearer token on every fetch', async () => {
    const seen: Array<Record<string, string>> = [];
    await service(async (_url, init) => {
      seen.push(init.headers);
      return { ok: true, status: 200, text: async () => JSON.stringify(REMOTE_CONFIG) };
    }).sync({
      endpointUrl: 'https://onboard.example/api/v1/models-config',
      apiKey: 'login-key-1',
      inheritedBaseUrl: 'https://fallback.example/v1',
    });

    expect(seen[0]?.Authorization).toBe('Bearer login-key-1');
    expect(seen[0]?.Accept).toBe('application/json');
  });

  // Wire topic §一: all four credential combinations have to work, and which
  // one applies must be stated rather than inferred from a missing field.
  it('writes each provider its own key and resolves inherited base URLs', async () => {
    const config = {
      version: 1,
      providers: {
        inherits: {
          api: 'openai-responses',
          credentials: { baseUrl: 'onboarding', apiKey: 'onboarding' },
          models: [{ id: 'a' }],
        },
        ownKeyOnly: {
          api: 'openai-responses',
          credentials: { baseUrl: 'onboarding', apiKey: 'managed' },
          apiKey: 'admin-key',
          models: [{ id: 'b' }],
        },
        ownUrlOnly: {
          api: 'openai-responses',
          credentials: { baseUrl: 'managed', apiKey: 'onboarding' },
          baseUrl: 'https://vendor.example/v1',
          models: [{ id: 'c' }],
        },
        ownBoth: {
          api: 'openai-responses',
          credentials: { baseUrl: 'managed', apiKey: 'managed' },
          baseUrl: 'https://other.example/v1',
          apiKey: 'other-key',
          models: [{ id: 'd' }],
        },
      },
    };

    await service(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(config),
    })).sync({
      endpointUrl: 'https://onboard.example/api/v1/models-config',
      apiKey: 'login-key',
      inheritedBaseUrl: 'https://login.example/v1/',
    });

    const auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
    expect(auth).toEqual({
      inherits: { type: 'api_key', key: 'login-key' },
      ownKeyOnly: { type: 'api_key', key: 'admin-key' },
      ownUrlOnly: { type: 'api_key', key: 'login-key' },
      ownBoth: { type: 'api_key', key: 'other-key' },
    });

    // pi needs an address, not a statement about where one comes from.
    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(models.providers.inherits.baseUrl).toBe('https://login.example/v1');
    expect(models.providers.ownUrlOnly.baseUrl).toBe('https://vendor.example/v1');
    expect(models.providers.ownBoth.baseUrl).toBe('https://other.example/v1');
    // Neither our vocabulary nor the keys belong in pi's file.
    const modelsText = readFileSync(join(dir, 'models.json'), 'utf8');
    expect(modelsText).not.toContain('credentials');
    expect(modelsText).not.toContain('admin-key');
    expect(modelsText).not.toContain('other-key');
  });

  it('rewrites an administrator key from cache after the login key rotates', async () => {
    const config = {
      version: 1,
      providers: {
        vendor: {
          api: 'openai-responses',
          credentials: { baseUrl: 'managed', apiKey: 'managed' },
          baseUrl: 'https://vendor.example/v1',
          apiKey: 'admin-key',
          models: [{ id: 'v1' }],
        },
      },
    };
    await service(
      async () => ({ ok: true, status: 200, text: async () => JSON.stringify(config) }),
      1000
    ).sync({
      endpointUrl: 'https://onboard.example/api/v1/models-config',
      apiKey: 'login-key-old',
      inheritedBaseUrl: 'https://login.example/v1',
    });

    const offline = service(async () => {
      throw new Error('offline');
    }, 2000);
    const result = await offline.sync({
      endpointUrl: 'https://onboard.example/api/v1/models-config',
      apiKey: 'login-key-new',
      inheritedBaseUrl: 'https://login.example/v1',
      force: true,
    });

    expect(result.source).toBe('stale-cache');
    // The administrator's key survives the rotation; only inherited ones move.
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))).toEqual({
      vendor: { type: 'api_key', key: 'admin-key' },
    });
  });

  // D03: an answered-but-empty catalog is a legal state, not a failure.
  it('accepts an empty catalog as a real answer', async () => {
    const empty = service(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: 1, providers: {} }),
    }));
    const result = await empty.sync({
      endpointUrl: 'https://onboard.example/api/v1/models-config',
      apiKey: 'login-key',
      inheritedBaseUrl: 'https://login.example/v1',
    });

    expect(result.source).toBe('remote');
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(0);
    expect(empty.readCatalog()).toMatchObject({ source: 'managed', stale: false, models: [] });
  });

  // F08: the User-Agent header must survive EVERY path that writes models.json,
  // because the failure is invisible — a request simply goes out identifying
  // itself as a pi CLI, and nothing in the app says so.
  it('writes the client User-Agent on all three models.json paths', async () => {
    const reference = `$${PI_USER_AGENT_ENV}`;
    const headerOf = () =>
      JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')).providers.dan.headers[
        PI_USER_AGENT_HEADER
      ];

    // 1. a fresh remote answer.
    const ok: PiModelConfigFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(REMOTE_CONFIG),
    });
    await service(ok, 1000).sync({
      endpointUrl: 'https://admin.example/config',
      apiKey: 'key-1',
      inheritedBaseUrl: 'https://fallback.example/v1',
    });
    expect(headerOf()).toBe(reference);

    // 2. the cheap rewrite of a still-fresh cache — no fetch happens at all,
    // and this path writes models.json anyway to keep auth.json in step.
    rmSync(join(dir, 'models.json'));
    await service(ok, 2000).sync({
      endpointUrl: 'https://admin.example/config',
      apiKey: 'key-2',
      inheritedBaseUrl: 'https://fallback.example/v1',
    });
    expect(headerOf()).toBe(reference);

    // 3. the stale-cache fallback after the endpoint fails.
    rmSync(join(dir, 'models.json'));
    await service(async () => ({ ok: false, status: 503, text: async () => 'down' }), 3000).sync({
      endpointUrl: 'https://admin.example/config',
      apiKey: 'key-3',
      inheritedBaseUrl: 'https://fallback.example/v1',
      force: true,
    });
    expect(headerOf()).toBe(reference);
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
      inheritedBaseUrl: 'https://fallback.example/v1',
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

  it('reads a provider with no credentials block as the legacy shape it is', () => {
    const validated = validatePiManagedModelsConfig(REMOTE_CONFIG);
    // An old management site always typed the base URL itself, and could never
    // supply a key — that is what the absence means, not "unspecified".
    expect(validated.providers.dan.credentials).toEqual({
      baseUrl: 'managed',
      apiKey: 'onboarding',
    });
    expect(validated.providers.dan.baseUrl).toBe('https://models.example.com/v1');
  });

  it('accepts a provider key only from an authenticated fetch', () => {
    const withKey = {
      version: 1,
      providers: {
        dan: {
          api: 'openai-responses',
          credentials: { baseUrl: 'onboarding', apiKey: 'managed' },
          apiKey: 'admin-key',
          models: [{ id: 'a' }],
        },
      },
    };
    expect(
      validatePiManagedModelsConfig(withKey, { credentialsAllowed: true }).providers.dan.apiKey
    ).toBe('admin-key');
    // Same bytes from an unauthenticated source stay refused: the degraded
    // direction has to be the safe one.
    expect(() => validatePiManagedModelsConfig(withKey)).toThrow(/credentials/);
  });

  it('refuses a stated source that contradicts what is present', () => {
    const managedWithoutValue = {
      version: 1,
      providers: {
        dan: {
          api: 'openai-responses',
          credentials: { baseUrl: 'managed', apiKey: 'onboarding' },
          models: [{ id: 'a' }],
        },
      },
    };
    expect(() => validatePiManagedModelsConfig(managedWithoutValue)).toThrow(/baseUrl is required/);

    const inheritedWithValue = {
      version: 1,
      providers: {
        dan: {
          api: 'openai-responses',
          credentials: { baseUrl: 'onboarding', apiKey: 'onboarding' },
          baseUrl: 'https://vendor.example/v1',
          models: [{ id: 'a' }],
        },
      },
    };
    expect(() => validatePiManagedModelsConfig(inheritedWithValue)).toThrow(/must be absent/);
  });

  // D03: rejecting these as malformed is what used to push the client onto the
  // stale cache or the built-in table.
  it('accepts zero providers and a provider with zero models', () => {
    expect(validatePiManagedModelsConfig({ version: 1, providers: {} }).providers).toEqual({});
    const emptyProvider = validatePiManagedModelsConfig({
      version: 1,
      providers: {
        dan: {
          api: 'openai-responses',
          credentials: { baseUrl: 'onboarding', apiKey: 'onboarding' },
          models: [],
        },
      },
    });
    expect(emptyProvider.providers.dan.models).toEqual([]);
  });
});

describe('F08 provider headers in models.json', () => {
  const base = {
    version: 1 as const,
    providers: {
      dan: { api: 'openai-responses' as const, models: [{ id: 'm1' }] },
    },
  };

  it('writes the User-Agent as an environment reference, never as a literal', () => {
    const providers = toPiModelsJson(validatePiManagedModelsConfig(base), {
      inheritedBaseUrl: 'https://fallback.example/v1',
    }).providers as Record<string, { headers: Record<string, string> }>;
    expect(providers.dan.headers).toEqual({ [PI_USER_AGENT_HEADER]: `$${PI_USER_AGENT_ENV}` });
    // Written as `$NAME` because that is the only shape `validateProvider`
    // accepts for a header — the injection must not be an exception to the
    // rule the rest of the config obeys.
    const roundTripped = validatePiManagedModelsConfig({
      version: 1,
      providers: { dan: { ...base.providers.dan, headers: providers.dan.headers } },
    });
    expect(roundTripped.providers.dan.headers).toEqual(providers.dan.headers);
  });

  it('keeps an administrator-configured header alongside ours', () => {
    const providers = toPiModelsJson(
      validatePiManagedModelsConfig({
        version: 1,
        providers: { dan: { ...base.providers.dan, headers: { 'X-Tenant': '$TENANT_ID' } } },
      }),
      { inheritedBaseUrl: 'https://fallback.example/v1' }
    ).providers as Record<string, { headers: Record<string, string> }>;
    expect(providers.dan.headers).toEqual({
      'X-Tenant': '$TENANT_ID',
      [PI_USER_AGENT_HEADER]: `$${PI_USER_AGENT_ENV}`,
    });
  });

  it('does not override a User-Agent the management site stated itself', () => {
    for (const name of ['User-Agent', 'user-agent']) {
      const providers = toPiModelsJson(
        validatePiManagedModelsConfig({
          version: 1,
          providers: { dan: { ...base.providers.dan, headers: { [name]: '$TENANT_UA' } } },
        }),
        { inheritedBaseUrl: 'https://fallback.example/v1' }
      ).providers as Record<string, { headers: Record<string, string> }>;
      // Case-insensitive: emitting both spellings would send the field twice.
      expect(providers.dan.headers).toEqual({ [name]: '$TENANT_UA' });
    }
  });
});
