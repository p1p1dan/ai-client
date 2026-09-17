import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PI_USER_AGENT_ENV,
  PI_USER_AGENT_HEADER,
  type PiManagedModelsConfig,
} from '@shared/piModelConfig';
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

  /**
   * A service with NO bundled snapshot.
   *
   * Stated rather than left to the default, which reads the real checked-in
   * `resources/model-catalog/snapshot.json`: these arms are about the remote →
   * cache → nothing ladder, and letting a file in the repository decide their
   * outcome would make them pass or fail on whether someone last ran the
   * release refresh script. A3's own rungs get their own helper below.
   */
  function service(fetchFn: PiModelConfigFetch, now = 1234): PiModelConfigService {
    return new PiModelConfigService({
      agentDir: dir,
      fetchFn,
      now: () => now,
      readBundledCatalog: () => null,
    });
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

  /**
   * ARD D15. One login URL cannot be right for both model families at once:
   * the gateway answers Anthropic at the root and OpenAI only under `/v1`, and
   * it answers the wrong one with 503 `所有供应商暂时不可用` — which reads as
   * an outage, not as a misconfiguration. Both backends read this file, so the
   * derivation belongs here rather than in either runtime.
   */
  it('gives an inheriting provider the suffix its wire protocol needs (D15)', async () => {
    const config = {
      version: 1,
      providers: {
        claude: {
          api: 'anthropic-messages',
          credentials: { baseUrl: 'onboarding', apiKey: 'onboarding' },
          models: [{ id: 'claude-sonnet-5' }],
        },
        codex: {
          api: 'openai-responses',
          credentials: { baseUrl: 'onboarding', apiKey: 'onboarding' },
          models: [{ id: 'gpt-5.6' }],
        },
        pinned: {
          api: 'anthropic-messages',
          credentials: { baseUrl: 'managed', apiKey: 'onboarding' },
          baseUrl: 'https://exception.example/v1',
          models: [{ id: 'claude-opus-5' }],
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
      inheritedBaseUrl: 'https://cch.example/v1',
    });

    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(models.providers.claude.baseUrl).toBe('https://cch.example');
    expect(models.providers.codex.baseUrl).toBe('https://cch.example/v1');
    // The escape hatch D15 keeps: a provider that states an address is never
    // rewritten, however odd the address looks to us.
    expect(models.providers.pinned.baseUrl).toBe('https://exception.example/v1');
  });

  it('carries a single model’s own address all the way to models.json (D15 / MC02)', async () => {
    // import-catalog-06: the provider still gets the derived suffix, and the one
    // model that states an exception keeps it verbatim beside it. The runtime
    // reads `models.json` this way round too (`binding.ts`: the row's own
    // address wins over the provider's).
    const config = {
      version: 1,
      providers: {
        claude: {
          api: 'anthropic-messages',
          credentials: { baseUrl: 'onboarding', apiKey: 'onboarding' },
          models: [
            { id: 'claude-sonnet-5' },
            { id: 'claude-opus-5', baseUrl: 'https://exception.example/anthropic' },
          ],
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
      inheritedBaseUrl: 'https://cch.example/v1',
    });

    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(models.providers.claude.baseUrl).toBe('https://cch.example');
    expect(models.providers.claude.models).toEqual([
      { id: 'claude-sonnet-5' },
      { id: 'claude-opus-5', baseUrl: 'https://exception.example/anthropic' },
    ]);
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

  /**
   * T062 / D3 — the model menu and the worker must answer from one document.
   *
   * The 2026-09-17 point-check found a `vllmproxy` provider hand-written into
   * `models.json` and never stored in the credential vault. The picker listed
   * it (it reads the file); every worker was handed the in-memory assembly
   * built from the vault, which has never held it. Choosing it therefore failed
   * with `no model "vllmproxy/claude-sonnet-5" in the catalog (4 available)` —
   * and the next settings edit would have erased the row from the file anyway.
   */
  it('builds the menu from the document a worker is handed, not from models.json', () => {
    const glm = {
      baseUrl: 'https://glm.example/v1',
      api: 'openai-completions',
      models: [{ id: 'glm-5', name: 'GLM 5' }],
    };
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        providers: {
          glm,
          // The hand-edited shape from the point-check: a provider-level
          // `name` and sized model rows, neither of which the app's own writer
          // can produce — the tell that it never came from the vault.
          vllmproxy: {
            name: 'VLLM Proxy',
            baseUrl: 'https://api.vllmproxy.example',
            api: 'anthropic-messages',
            models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 200000 }],
          },
        },
      })
    );
    const logged: unknown[][] = [];
    const local = new PiModelConfigService({
      agentDir: dir,
      fetchFn: async () => ({ ok: false, status: 500, text: async () => '' }),
      now: () => 1234,
      readBundledCatalog: () => null,
      log: (...args) => logged.push(args),
    });
    // What a worker is handed this launch: the vault half only.
    const handedToWorker = { models: { providers: { glm } } };

    // No document to hand over (`resolveNativeModelCatalog` returned
    // `undefined`) is the case where the worker reads the directory itself, so
    // the file is the right answer for both sides and nothing is dropped.
    expect(local.readCatalog('local').models.map((model) => model.id)).toEqual([
      'glm/glm-5',
      'vllmproxy/claude-sonnet-5',
    ]);
    expect(logged).toEqual([]);

    // With one, the menu is exactly that document's providers — and the row
    // that is not in it says so somewhere rather than just vanishing.
    const menu = local.readCatalog('local', handedToWorker);
    expect(menu.models.map((model) => model.id)).toEqual(['glm/glm-5']);
    expect(new Set(menu.models.map((model) => model.id.split('/', 1)[0]))).toEqual(
      new Set(Object.keys(handedToWorker.models.providers))
    );
    expect(logged.flat()).toContainEqual(
      expect.objectContaining({ dropped: 'vllmproxy', reason: 'absent_from_runtime_catalog' })
    );
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

  /**
   * import-catalog-06 — D15 promises an override on every MODEL as well as on
   * every provider, and the runtime has always honoured it. The validator built
   * its result field by field, so the field an administrator wrote was dropped
   * without a word on its way to `models.json`.
   */
  it('keeps an address a single model states for itself (D15 / MC02)', () => {
    const config = validatePiManagedModelsConfig({
      version: 1,
      providers: {
        dan: {
          api: 'openai-responses',
          credentials: { baseUrl: 'onboarding', apiKey: 'onboarding' },
          models: [
            { id: 'normal' },
            { id: 'exception', baseUrl: 'https://other-gateway.example/v1' },
          ],
        },
      },
    });
    expect(config.providers.dan.models[0].baseUrl).toBeUndefined();
    expect(config.providers.dan.models[1].baseUrl).toBe('https://other-gateway.example/v1');
  });

  it('rejects a model address that is not an absolute http(s) URL', () => {
    // Loudly, because this value is used verbatim: nothing downstream derives
    // anything from it, so nothing downstream gets a chance to notice.
    const relative = {
      version: 1,
      providers: {
        dan: {
          api: 'openai-responses',
          credentials: { baseUrl: 'onboarding', apiKey: 'onboarding' },
          models: [{ id: 'exception', baseUrl: '/v1' }],
        },
      },
    };
    expect(() => validatePiManagedModelsConfig(relative)).toThrow(/must be an absolute URL/);
    const blank = {
      version: 1,
      providers: {
        dan: {
          api: 'openai-responses',
          credentials: { baseUrl: 'onboarding', apiKey: 'onboarding' },
          models: [{ id: 'exception', baseUrl: '   ' }],
        },
      },
    };
    expect(() => validatePiManagedModelsConfig(blank)).toThrow(/must be a non-empty string/);
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

/**
 * A3 — the release artifact's own catalog, as `catalogSnapshot.ts` returns it.
 * Injected rather than written into `resources/`, so these arms never depend on
 * what happens to be checked in.
 */
const BUNDLED_SNAPSHOT = {
  version: 1,
  updatedAt: '2026-09-01T00:00:00.000Z',
  providers: {
    baseline: {
      name: 'Shipped baseline',
      api: 'openai-completions',
      credentials: { baseUrl: 'onboarding', apiKey: 'onboarding' },
      models: [{ id: 'baseline-mini', name: 'Baseline Mini', contextWindow: 64000 }],
    },
  },
} as const;

describe('PiModelConfigService — bundled catalog snapshot (A3)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-model-bundled-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const failingFetch: PiModelConfigFetch = async () => ({
    ok: false,
    status: 503,
    text: async () => '',
  });

  function bundledService(
    fetchFn: PiModelConfigFetch,
    readBundledCatalog: () => PiManagedModelsConfig | null = () =>
      validatePiManagedModelsConfig(BUNDLED_SNAPSHOT, { credentialsAllowed: false })
  ): PiModelConfigService {
    return new PiModelConfigService({
      agentDir: dir,
      fetchFn,
      now: () => 1234,
      readBundledCatalog,
    });
  }

  it('falls back to the snapshot when the fetch fails and nothing is cached (arm 2)', async () => {
    const result = await bundledService(failingFetch).sync({
      endpointUrl: 'https://onboarding.example/api/v1/models-config',
      apiKey: 'login-key',
      inheritedBaseUrl: 'https://gateway.example/v1',
    });

    expect(result.source).toBe('bundled');
    expect(result.modelCount).toBe(1);
    expect(result.providerCount).toBe(1);
    // The endpoint is still reported as it is, and the failure is still carried:
    // the snapshot changes which catalog the user gets, not what happened.
    expect(result.endpointUrl).toBe('https://onboarding.example/api/v1/models-config');
    expect(result.error).toContain('503');
    // A usable catalog, so `ok` — same reading as the stale-cache rung.
    expect(result.ok).toBe(true);
    // `syncedAt` stays null: nothing was ever fetched. The snapshot's own
    // `updatedAt` is an administrator's edit time, not a fetch time.
    expect(result.syncedAt).toBeNull();
  });

  it('writes the snapshot where pi reads it, but never into the wire cache (arm 5)', async () => {
    await bundledService(failingFetch).sync({
      endpointUrl: 'https://onboarding.example/api/v1/models-config',
      apiKey: 'login-key',
      inheritedBaseUrl: 'https://gateway.example/v1',
    });

    // pi reads models off disk, so a snapshot that stayed in memory would fill
    // the menu and then fail every turn started from it.
    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(Object.keys(models.providers)).toEqual(['baseline']);
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))).toEqual({
      baseline: { type: 'api_key', key: 'login-key' },
    });

    // The wire cache means "the last catalog THIS client fetched". Seeding it
    // with the bundled copy would make the next failed sync report
    // `stale-cache` and destroy the signal that says "shipped baseline".
    expect(existsSync(join(dir, 'managed-models-source.json'))).toBe(false);

    const again = await bundledService(failingFetch).sync({
      endpointUrl: 'https://onboarding.example/api/v1/models-config',
      apiKey: 'login-key',
      inheritedBaseUrl: 'https://gateway.example/v1',
    });
    expect(again.source).toBe('bundled');
  });

  it('serves the snapshot as the catalog, labelled as the baseline it is', async () => {
    await bundledService(failingFetch).sync({
      endpointUrl: 'https://onboarding.example/api/v1/models-config',
      apiKey: 'login-key',
      inheritedBaseUrl: 'https://gateway.example/v1',
    });

    expect(bundledService(failingFetch).readCatalog()).toMatchObject({
      source: 'bundled',
      stale: true,
      // Never fetched here, so there is no time at which it was current.
      fetchedAt: null,
      models: [{ id: 'baseline/baseline-mini', label: 'Baseline Mini', contextWindow: 64000 }],
    });
  });

  it('has a catalog before any sync has run at all', () => {
    // The cold-launch case: no state file, no models.json, no network yet.
    const state = bundledService(failingFetch).readState();
    expect(state.source).toBe('bundled');
    expect(state.modelCount).toBe(1);
    expect(bundledService(failingFetch).readCatalog().models).toHaveLength(1);
  });

  it('stays unavailable when there is no snapshot to fall back to (arm 3)', async () => {
    const result = await bundledService(failingFetch, () => null).sync({
      endpointUrl: 'https://onboarding.example/api/v1/models-config',
      apiKey: 'login-key',
      inheritedBaseUrl: 'https://gateway.example/v1',
    });

    expect(result.source).toBe('unavailable');
    expect(result.ok).toBe(false);
    expect(result.modelCount).toBe(0);
    expect(bundledService(failingFetch, () => null).readCatalog()).toMatchObject({
      source: 'unavailable',
      models: [],
    });
    // Nothing was written for pi to read, because there was nothing to write.
    expect(existsSync(join(dir, 'models.json'))).toBe(false);
  });

  it('goes back to remote the moment a fetch succeeds (arm 4)', async () => {
    const fallback = bundledService(failingFetch);
    expect(
      (
        await fallback.sync({
          endpointUrl: 'https://e/x',
          apiKey: 'k',
          inheritedBaseUrl: 'https://g/v1',
        })
      ).source
    ).toBe('bundled');

    const live: PiModelConfigFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(REMOTE_CONFIG),
    });
    const refreshed = await bundledService(live).sync({
      endpointUrl: 'https://e/x',
      apiKey: 'k',
      inheritedBaseUrl: 'https://g/v1',
    });

    expect(refreshed.source).toBe('remote');
    expect(bundledService(live).readCatalog()).toMatchObject({
      source: 'managed',
      stale: false,
      models: [{ id: 'dan/deepseek-v4' }],
    });
    // The live answer becomes the wire cache; the snapshot never did.
    expect(existsSync(join(dir, 'managed-models-source.json'))).toBe(true);
  });

  it('prefers this client’s own stale cache over the shipped baseline', async () => {
    // A cache was current for this machine once; a baseline never was. Order
    // matters, so it gets an assertion rather than a comment.
    const live: PiModelConfigFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(REMOTE_CONFIG),
    });
    await bundledService(live).sync({
      endpointUrl: 'https://e/x',
      apiKey: 'k',
      inheritedBaseUrl: 'https://g/v1',
    });

    const degraded = await bundledService(failingFetch).sync({
      endpointUrl: 'https://e/x',
      apiKey: 'k',
      inheritedBaseUrl: 'https://g/v1',
      force: true,
    });
    expect(degraded.source).toBe('stale-cache');
    expect(bundledService(failingFetch).readCatalog().models).toEqual([
      expect.objectContaining({ id: 'dan/deepseek-v4' }),
    ]);
  });

  it('never lends the shipped baseline to a local pi installation', () => {
    // Local mode means the user's own `~/.pi/agent` configures the models. Our
    // managed baseline is not an answer to that question.
    expect(bundledService(failingFetch).readCatalog('local')).toMatchObject({
      source: 'local',
      models: [],
    });
  });
});

describe('PiModelConfigService — user-added services (H/17 L2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-user-provider-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const userProvider = {
    id: '3f2a9c11-0000-4000-8000-000000000000',
    name: 'My DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'pi-messages',
    apiKey: 'USER-KEY-NEVER-IN-MODELS',
    models: ['deepseek-chat'],
    enabled: true,
    createdAt: '2026-09-10T00:00:00.000Z',
  };

  function service(
    userProviders: (typeof userProvider)[],
    fetchFn: PiModelConfigFetch = async () => ({ ok: false, status: 500, text: async () => '' })
  ): PiModelConfigService {
    return new PiModelConfigService({
      agentDir: dir,
      fetchFn,
      now: () => 1234,
      readBundledCatalog: () => null,
      userProviders: () => userProviders,
    });
  }

  it('writes a user service pi can read, with the key only in auth.json', () => {
    service([userProvider]).writeUserProviderConfig({
      userProviders: [userProvider],
      inheritedApiKey: '',
      inheritedBaseUrl: '',
    });

    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    // Slugged from the display name, not the uuid: this string is the left
    // half of `provider/model` in the picker.
    expect(models.providers['my-deepseek']).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'pi-messages',
      headers: { [PI_USER_AGENT_HEADER]: `$${PI_USER_AGENT_ENV}` },
      models: [{ id: 'deepseek-chat' }],
    });
    expect(readFileSync(join(dir, 'models.json'), 'utf8')).not.toContain(userProvider.apiKey);
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))).toEqual({
      'my-deepseek': { type: 'api_key', key: userProvider.apiKey },
    });
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'auth.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('accepts an API style the managed allowlist does not contain', () => {
    // `pi-messages` is not in PI_MODEL_APIS. A user service must not be
    // limited by a list that describes what the company gateway sends.
    service([userProvider]).writeUserProviderConfig({
      userProviders: [userProvider],
      inheritedApiKey: '',
      inheritedBaseUrl: '',
    });
    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(models.providers['my-deepseek'].api).toBe('pi-messages');
  });

  it('a SUCCESSFUL managed sync keeps the user services in the files pi reads', async () => {
    // The whole reason `userProviders` is a constructor supplier rather than a
    // write-time argument: `sync` rebuilds models.json from the server response
    // alone, and nothing in that path knows about the user's own services.
    // Nothing below calls `writeUserProviderConfig` — the sync must do it.
    const result = await service([userProvider], async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(REMOTE_CONFIG),
    })).sync({
      endpointUrl: 'http://127.0.0.1:3210/api/v1/models-config',
      apiKey: 'company-key',
      inheritedBaseUrl: 'https://fallback.example/v1',
      force: true,
    });
    expect(result.source).toBe('remote');

    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    const auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
    // Both groups present, each with its own key.
    expect(Object.keys(models.providers).sort()).toEqual(['dan', 'my-deepseek']);
    expect(auth.dan).toEqual({ type: 'api_key', key: 'company-key' });
    expect(auth['my-deepseek']).toEqual({ type: 'api_key', key: userProvider.apiKey });
  });

  /**
   * H/21 point-check D1 (2026-09-11): a migrated service must keep the key its
   * own `models.json` used, or every session recorded under that key is still
   * unopenable after the migration that was supposed to fix it.
   */
  it('a migrated service keeps its original key instead of a slug of its name', () => {
    const migrated = { ...userProvider, name: 'CX2 (GPT-5.6)', configKey: 'cx2' };
    service([migrated]).writeUserProviderConfig({
      userProviders: [migrated],
      inheritedApiKey: '',
      inheritedBaseUrl: '',
    });

    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(Object.keys(models.providers)).toContain('cx2');
    // The slug of the display name is what the bug produced.
    expect(Object.keys(models.providers)).not.toContain('cx2-gpt-5-6');
    // auth.json is keyed the same way, or the key reaches a provider that is
    // no longer there.
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))).toHaveProperty('cx2');
  });

  it('a blank configKey falls back to the slug rather than an empty provider id', () => {
    const odd = { ...userProvider, configKey: '   ' };
    service([odd]).writeUserProviderConfig({
      userProviders: [odd],
      inheritedApiKey: '',
      inheritedBaseUrl: '',
    });

    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(Object.keys(models.providers)).toContain('my-deepseek');
    expect(Object.keys(models.providers)).not.toContain('');
  });

  it('a user service shadows a managed provider of the same slug', () => {
    const collides = { ...userProvider, name: 'dan' };
    service([collides]).writeUserProviderConfig({
      userProviders: [collides],
      inheritedApiKey: 'company-key',
      inheritedBaseUrl: 'https://fallback.example/v1',
    });
    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(models.providers.dan?.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('omits a disabled service from both files', () => {
    const disabled = { ...userProvider, enabled: false };
    service([disabled]).writeUserProviderConfig({
      userProviders: [disabled],
      inheritedApiKey: '',
      inheritedBaseUrl: '',
    });
    expect(JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')).providers).toEqual({});
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))).toEqual({});
  });

  it('keeps only $-prefixed custom headers so a literal secret cannot land in models.json', () => {
    const withHeaders = {
      ...userProvider,
      headers: { 'x-ref': '$SOME_ENV', 'x-literal': 'raw-secret-value' },
    };
    service([withHeaders]).writeUserProviderConfig({
      userProviders: [withHeaders],
      inheritedApiKey: '',
      inheritedBaseUrl: '',
    });
    const headers = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')).providers[
      'my-deepseek'
    ].headers;
    expect(headers['x-ref']).toBe('$SOME_ENV');
    expect(headers['x-literal']).toBeUndefined();
  });

  it('falls back to a uuid-derived id when the name slugifies to nothing', () => {
    const punctuation = { ...userProvider, name: '???' };
    service([punctuation]).writeUserProviderConfig({
      userProviders: [punctuation],
      inheritedApiKey: '',
      inheritedBaseUrl: '',
    });
    const providers = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')).providers;
    expect(Object.keys(providers)).toEqual(['user-3f2a9c11']);
  });
});

/**
 * P5-5 — the catalog handed to a native worker.
 *
 * The whole point of the node is that the two plaintext files stop being
 * load-bearing for the backend that outlives pi. What must NOT happen is the
 * two paths drifting: one builder, so "what native runs on" and "what legacy
 * reads" can differ only by when they were assembled.
 */
describe('PiModelConfigService — native model catalog (P5-5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-model-native-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const userProvider = {
    id: '3f2a9c11-0000-4000-8000-000000000000',
    name: 'My Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    api: 'mistral-conversations',
    apiKey: 'USER-KEY',
    models: ['mistral-large'],
    enabled: true,
    createdAt: '2026-09-10T00:00:00.000Z',
  };

  function service(options: {
    userProviders?: (typeof userProvider)[];
    bundled?: PiManagedModelsConfig | null;
    fetchFn?: PiModelConfigFetch;
    managedCredentialsEnabled?: boolean;
  }): PiModelConfigService {
    return new PiModelConfigService({
      agentDir: dir,
      fetchFn: options.fetchFn ?? (async () => ({ ok: false, status: 500, text: async () => '' })),
      now: () => 1234,
      readBundledCatalog: () => options.bundled ?? null,
      userProviders: () => options.userProviders ?? [],
      managedCredentialsEnabled: () => options.managedCredentialsEnabled ?? true,
    });
  }

  const shippedBaseline = () =>
    validatePiManagedModelsConfig(BUNDLED_SNAPSHOT, { credentialsAllowed: false });

  it('assembles byte-identical documents to the ones written for legacy', async () => {
    const built = service({
      userProviders: [userProvider],
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(REMOTE_CONFIG),
      }),
    });
    await built.sync({
      endpointUrl: 'https://onboard.example/api/v1/models-config',
      apiKey: 'login-key',
      inheritedBaseUrl: 'https://cch.example/v1',
    });

    const catalog = built.buildNativeModelCatalog({
      inheritedApiKey: 'login-key',
      inheritedBaseUrl: 'https://cch.example/v1',
    });
    expect(catalog.models).toEqual(JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')));
    expect(catalog.auth).toEqual(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')));
  });

  it('carries the user service and its key without either touching disk', () => {
    const catalog = service({ userProviders: [userProvider] }).buildNativeModelCatalog({
      inheritedApiKey: '',
      inheritedBaseUrl: '',
    });
    const providers = catalog.models.providers as Record<string, { api: string }>;
    expect(providers['my-mistral'].api).toBe('mistral-conversations');
    expect(catalog.auth['my-mistral']).toEqual({ type: 'api_key', key: 'USER-KEY' });
    // Nothing was written: the sync never ran, and assembling is a read.
    expect(existsSync(join(dir, 'models.json'))).toBe(false);
    expect(existsSync(join(dir, 'auth.json'))).toBe(false);
  });

  it('falls back to the bundled snapshot, so a cold launch has a catalog (A3/MC05)', () => {
    const bundled = validatePiManagedModelsConfig(
      {
        version: 1,
        providers: {
          shipped: {
            name: 'Shipped',
            api: 'anthropic-messages',
            models: [{ id: 'claude-sonnet-5' }],
          },
        },
      },
      { credentialsAllowed: false }
    );
    const catalog = service({ bundled }).buildNativeModelCatalog({
      inheritedApiKey: 'k',
      inheritedBaseUrl: 'https://cch.example/v1',
    });
    const providers = catalog.models.providers as Record<string, { baseUrl: string }>;
    // D15 applies here too: the snapshot states no address of its own.
    expect(providers.shipped.baseUrl).toBe('https://cch.example');
  });

  /**
   * import-catalog-03 — the "same builder" claim used to be tested only on the
   * one input where the two paths happened to agree (a client that had just
   * synced). With no wire cache they picked DIFFERENT managed halves: the
   * writer an empty catalog, the in-memory build the shipped snapshot.
   */
  it('assembles the same documents as the file when there is no wire cache', () => {
    const built = service({ userProviders: [userProvider], bundled: shippedBaseline() });
    built.writeUserProviderConfig({
      userProviders: [userProvider],
      inheritedApiKey: 'login-key',
      inheritedBaseUrl: 'https://cch.example/v1',
    });

    const catalog = built.buildNativeModelCatalog({
      inheritedApiKey: 'login-key',
      inheritedBaseUrl: 'https://cch.example/v1',
    });
    expect(catalog.models).toEqual(JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')));
    expect(catalog.auth).toEqual(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')));
    // Both halves are really there — an equality of two empty catalogs would
    // pass this test while proving nothing.
    expect(Object.keys(catalog.models.providers as object).sort()).toEqual([
      'baseline',
      'my-mistral',
    ]);
  });

  it('a user service edit does not erase the snapshot the offline first launch wrote', async () => {
    // The concrete report: managed mode, first launch offline, A3 writes the
    // shipped baseline into `models.json`; the user then adds a service and the
    // rewrite started from an empty catalog, deleting every shipped provider
    // from the file the embedded pi CLI reads — while the native worker still
    // had them in memory.
    const offline = service({ userProviders: [userProvider], bundled: shippedBaseline() });
    const synced = await offline.sync({
      endpointUrl: 'https://onboard.example/api/v1/models-config',
      apiKey: 'login-key',
      inheritedBaseUrl: 'https://cch.example/v1',
    });
    expect(synced.source).toBe('bundled');
    expect(existsSync(join(dir, 'managed-models-source.json'))).toBe(false);

    offline.writeUserProviderConfig({
      userProviders: [userProvider],
      inheritedApiKey: 'login-key',
      inheritedBaseUrl: 'https://cch.example/v1',
    });

    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(Object.keys(models.providers).sort()).toEqual(['baseline', 'my-mistral']);
  });

  it('never lends the shipped baseline to a local installation, in memory either', () => {
    // `readCatalog('local')` has always refused this. The in-memory path had no
    // such door, so a user who turned managed credentials off still got the
    // company catalog handed to their worker — and, because managed providers
    // are written first, its first provider was the default model.
    const catalog = service({
      userProviders: [userProvider],
      bundled: shippedBaseline(),
      managedCredentialsEnabled: false,
    }).buildNativeModelCatalog({ inheritedApiKey: '', inheritedBaseUrl: '' });
    expect(Object.keys(catalog.models.providers as object)).toEqual(['my-mistral']);
  });
});
