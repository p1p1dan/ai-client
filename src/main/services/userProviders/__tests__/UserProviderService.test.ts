import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProvider } from '../../auth/CredentialVault';
import { UserProviderService, type UserProviderStore } from '../UserProviderService';

/** H/17 L2 — pure service, fake store and fake fetch, zero electron import. */

function makeProvider(overrides?: Partial<UserProvider>): UserProvider {
  return {
    id: 'svc-1',
    name: 'My DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
    apiKey: 'STORED-KEY',
    models: ['deepseek-chat'],
    enabled: true,
    createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

interface FakeStore extends UserProviderStore {
  rows: UserProvider[];
  readStatus: 'ok' | 'absent' | 'locked' | 'unsupported' | 'invalid';
  saved: UserProvider[][];
  /** Saves that went through the replace-unreadable path. */
  replaced: UserProvider[][];
}

function fakeStore(initial: UserProvider[] = []): FakeStore {
  const store: FakeStore = {
    rows: [...initial],
    readStatus: 'ok',
    saved: [],
    replaced: [],
    encryptionAvailable: () => true,
    readUserProviders: () =>
      store.readStatus === 'ok'
        ? { status: 'ok', providers: store.rows }
        : store.readStatus === 'invalid'
          ? { status: 'invalid', reason: 'decrypt_failed' }
          : { status: store.readStatus },
    saveUserProviders: async (providers) => {
      store.saved.push([...providers]);
      store.rows = [...providers];
      return { ok: true };
    },
    replaceUnreadableUserProviders: async (providers) => {
      store.replaced.push([...providers]);
      store.rows = [...providers];
      store.readStatus = 'ok';
      return { ok: true };
    },
  };
  return store;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let store: FakeStore;
let fetchFn: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store = fakeStore();
  fetchFn = vi.fn();
});

function service(options: { onChange?: (rows: readonly UserProvider[]) => void } = {}) {
  return new UserProviderService({
    store,
    fetchFn: fetchFn as never,
    now: () => new Date('2026-09-10T00:00:00.000Z'),
    ...options,
  });
}

describe('UserProviderService — state', () => {
  it('never hands the stored key to the renderer', () => {
    store.rows = [makeProvider()];
    const [view] = service().state().providers;
    expect(view).toEqual({
      id: 'svc-1',
      name: 'My DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
      hasApiKey: true,
      models: ['deepseek-chat'],
      enabled: true,
      createdAt: '2026-09-10T00:00:00.000Z',
    });
    expect(JSON.stringify(view)).not.toContain('STORED-KEY');
  });

  it('reports an empty vault as no services, not as a failure', () => {
    store.readStatus = 'absent';
    expect(service().state()).toEqual({ providers: [], encrypted: true });
  });

  it('reports a locked keyring so the page can say why the list is empty', () => {
    store.readStatus = 'locked';
    expect(service().state()).toEqual({ providers: [], encrypted: true, unavailable: 'locked' });
  });

  it('surfaces an unencrypted vault rather than implying the key is protected', () => {
    store.encryptionAvailable = () => false;
    expect(service().state().encrypted).toBe(false);
  });
});

describe('UserProviderService — upsert', () => {
  it('creates a service, normalizing a pasted operation URL to the service root', async () => {
    const view = await service().upsert({
      name: '  My DeepSeek  ',
      baseUrl: 'https://api.deepseek.com/v1/chat/completions',
      api: 'openai-completions',
      apiKey: 'NEW-KEY',
    });

    expect(view.name).toBe('My DeepSeek');
    expect(view.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(store.rows[0].apiKey).toBe('NEW-KEY');
    expect(store.rows[0].enabled).toBe(true);
  });

  it('keeps the stored key when an edit omits it', async () => {
    store.rows = [makeProvider()];
    await service().upsert({
      id: 'svc-1',
      name: 'Renamed',
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
    });

    expect(store.rows[0].apiKey).toBe('STORED-KEY');
    expect(store.rows[0].name).toBe('Renamed');
    expect(store.rows[0].createdAt).toBe('2026-09-10T00:00:00.000Z');
  });

  it('a migrated service keeps its original config key across a rename', async () => {
    // H/21 point-check D1: `configKey` is the id older sessions recorded.
    // Renaming is the most likely reason to open this form, and dropping the
    // key there would re-break the sessions the migration just repaired.
    store.rows = [{ ...makeProvider(), configKey: 'cx2' }];
    await service().upsert({
      id: 'svc-1',
      name: 'Something Else Entirely',
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
    });

    expect(store.rows[0].configKey).toBe('cx2');
  });

  it('a service created here gets no config key at all', async () => {
    // It was never referenced by an older session under another id, so the
    // readable slug of its name is the better key.
    await service().upsert({
      name: 'My DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
      apiKey: 'K',
    });

    expect(store.rows[0].configKey).toBeUndefined();
  });

  it('refuses an explicitly blank key instead of saving a provider that cannot answer', async () => {
    store.rows = [makeProvider()];
    await expect(
      service().upsert({
        id: 'svc-1',
        name: 'My DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        api: 'openai-completions',
        apiKey: '   ',
      })
    ).rejects.toThrow('API key');
    expect(store.saved).toHaveLength(0);
  });

  it('rejects a URL carrying credentials rather than silently stripping them', async () => {
    await expect(
      service().upsert({
        name: 'Sneaky',
        baseUrl: 'https://user:pass@example.com/v1',
        api: 'openai-completions',
        apiKey: 'K',
      })
    ).rejects.toThrow('not usable');
  });

  it('refuses to start from an empty list when the group could not be read', async () => {
    store.readStatus = 'locked';
    await expect(
      service().upsert({
        name: 'X',
        baseUrl: 'https://example.com/v1',
        api: 'openai-completions',
        apiKey: 'K',
      })
    ).rejects.toThrow('keyring');
    // The real damage this guards: saving [] would delete every stored service.
    expect(store.saved).toHaveLength(0);
    expect(store.replaced).toHaveLength(0);
  });

  it('lets a new service replace a group that reads invalid, through the backup path', async () => {
    // The field report: a vault whose group no key opens any more refused
    // every add with "could not be read", while the page said adding again
    // would replace the record.
    store.readStatus = 'invalid';
    await expect(
      service().upsert({
        name: 'Fresh',
        baseUrl: 'https://example.com/v1',
        api: 'openai-completions',
        apiKey: 'K',
      })
    ).resolves.toMatchObject({ name: 'Fresh' });
    expect(store.saved).toHaveLength(0);
    expect(store.replaced).toHaveLength(1);
    expect(store.replaced[0].map((row) => row.name)).toEqual(['Fresh']);
  });

  it('still refuses to edit, remove or toggle while the group reads invalid', async () => {
    store.readStatus = 'invalid';
    await expect(
      service().upsert({
        id: 'svc-1',
        name: 'X',
        baseUrl: 'https://example.com/v1',
        api: 'openai-completions',
      })
    ).rejects.toThrow('could not be read (decrypt_failed)');
    await expect(service().remove('svc-1')).rejects.toThrow('decrypt_failed');
    await expect(service().setEnabled('svc-1', false)).rejects.toThrow('decrypt_failed');
    expect(store.saved).toHaveLength(0);
    expect(store.replaced).toHaveLength(0);
  });

  it('validates a replacing add before touching the unreadable group', async () => {
    store.readStatus = 'invalid';
    await expect(
      service().upsert({
        name: 'X',
        baseUrl: 'https://example.com/v1',
        api: 'openai-completions',
        apiKey: '  ',
      })
    ).rejects.toThrow('API key');
    expect(store.replaced).toHaveLength(0);
  });

  it('names the newer schema instead of replacing a vault it cannot interpret', async () => {
    store.readStatus = 'unsupported';
    await expect(
      service().upsert({
        name: 'X',
        baseUrl: 'https://example.com/v1',
        api: 'openai-completions',
        apiKey: 'K',
      })
    ).rejects.toThrow('could not be read (unsupported)');
    expect(store.replaced).toHaveLength(0);
  });

  it('notifies the derived-config writer after a successful save', async () => {
    const onChange = vi.fn();
    await service({ onChange }).upsert({
      name: 'X',
      baseUrl: 'https://example.com/v1',
      api: 'pi-messages',
      apiKey: 'K',
    });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('accepts every API style pi-ai implements, not just the managed four', async () => {
    for (const api of [
      'pi-messages',
      'openai-codex-responses',
      'bedrock-converse-stream',
    ] as const) {
      await expect(
        service().upsert({ name: api, baseUrl: 'https://example.com/v1', api, apiKey: 'K' })
      ).resolves.toMatchObject({ api });
    }
  });

  it('keeps stored modelMeta when an edit omits it (P1-b)', async () => {
    // A save that did not open the metadata section, or a non-form path like
    // setEnabled, must not silently drop metadata the user already typed.
    store.rows = [
      makeProvider({
        modelMeta: { 'deepseek-chat': { contextWindow: 65536, reasoning: true } },
      }),
    ];
    await service().upsert({
      id: 'svc-1',
      name: 'Renamed',
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
    });
    expect(store.rows[0].modelMeta).toEqual({
      'deepseek-chat': { contextWindow: 65536, reasoning: true },
    });
  });

  it('clears stored modelMeta when an edit sends an empty map (decision 165)', async () => {
    // The form's way to say "everything was unticked"; absent still keeps.
    store.rows = [
      makeProvider({
        api: 'anthropic-messages',
        baseUrl: 'https://proxy.example',
        modelMeta: { 'claude-opus-5-5': { reasoning: true, adaptiveThinking: true } },
      }),
    ];
    const view = await service().upsert({
      id: 'svc-1',
      name: 'My DeepSeek',
      baseUrl: 'https://proxy.example',
      api: 'anthropic-messages',
      modelMeta: {},
    });
    expect(store.rows[0]).not.toHaveProperty('modelMeta');
    expect(view).not.toHaveProperty('modelMeta');
  });

  it('stores the adaptive thinking switch as sent', async () => {
    await service().upsert({
      name: 'Claude proxy',
      baseUrl: 'https://proxy.example/v1/messages',
      api: 'anthropic-messages',
      apiKey: 'K',
      models: ['claude-opus-5-5'],
      modelMeta: { 'claude-opus-5-5': { reasoning: true, adaptiveThinking: true } },
    });
    expect(store.rows[0]).toMatchObject({
      baseUrl: 'https://proxy.example',
      modelMeta: { 'claude-opus-5-5': { reasoning: true, adaptiveThinking: true } },
    });
  });
});

describe('UserProviderService — remove / setEnabled', () => {
  it('removes by id and rejects an unknown id', async () => {
    store.rows = [makeProvider(), makeProvider({ id: 'svc-2', name: 'Other' })];
    await service().remove('svc-1');
    expect(store.rows.map((row) => row.id)).toEqual(['svc-2']);
    await expect(service().remove('nope')).rejects.toThrow('No such');
  });

  it('toggles enabled without touching the key', async () => {
    store.rows = [makeProvider()];
    const view = await service().setEnabled('svc-1', false);
    expect(view.enabled).toBe(false);
    expect(store.rows[0].apiKey).toBe('STORED-KEY');
  });
});

describe('UserProviderService — fetchModels', () => {
  it('lists OpenAI-shaped models and dedupes', async () => {
    fetchFn.mockResolvedValue(
      jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o' }, { id: 'o3' }] })
    );
    const result = await service().fetchModels({
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      apiKey: 'K',
    });
    expect(result).toEqual({ ok: true, models: ['gpt-4o', 'o3'] });
    expect(fetchFn).toHaveBeenCalledWith('https://api.example.com/v1/models', {
      headers: { authorization: 'Bearer K' },
    });
  });

  it('strips the models/ prefix Google returns', async () => {
    fetchFn.mockResolvedValue(jsonResponse({ models: [{ name: 'models/gemini-2.0-flash' }] }));
    const result = await service().fetchModels({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      api: 'google-generative-ai',
      apiKey: 'K',
    });
    expect(result).toEqual({ ok: true, models: ['gemini-2.0-flash'] });
    expect(fetchFn.mock.calls[0][1]).toEqual({ headers: { 'x-goog-api-key': 'K' } });
  });

  it('sends the anthropic key header shape, not a bearer token', async () => {
    fetchFn.mockResolvedValue(jsonResponse({ data: [{ id: 'claude-x' }] }));
    await service().fetchModels({
      baseUrl: 'https://api.anthropic.com/v1',
      api: 'anthropic-messages',
      apiKey: 'K',
    });
    expect(fetchFn.mock.calls[0][1].headers['x-api-key']).toBe('K');
  });

  it('reuses the stored key so editing never round-trips a secret', async () => {
    store.rows = [makeProvider()];
    fetchFn.mockResolvedValue(jsonResponse({ data: [{ id: 'deepseek-chat' }] }));
    const result = await service().fetchModels({
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
      id: 'svc-1',
    });
    expect(result).toEqual({ ok: true, models: ['deepseek-chat'] });
    expect(fetchFn.mock.calls[0][1].headers.authorization).toBe('Bearer STORED-KEY');
  });

  it('names a refused key instead of reporting a generic failure', async () => {
    fetchFn.mockResolvedValue(jsonResponse({ error: 'nope' }, 401));
    await expect(
      service().fetchModels({
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        apiKey: 'K',
      })
    ).resolves.toEqual({ ok: false, error: 'the service refused this API key' });
  });

  it('reports an unreachable host with the transport message', async () => {
    fetchFn.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.example.com'));
    await expect(
      service().fetchModels({
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        apiKey: 'K',
      })
    ).resolves.toEqual({ ok: false, error: 'getaddrinfo ENOTFOUND api.example.com' });
  });

  it('distinguishes "answered, but with no models" from a transport failure', async () => {
    fetchFn.mockResolvedValue(jsonResponse({ data: [] }));
    await expect(
      service().fetchModels({
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        apiKey: 'K',
      })
    ).resolves.toEqual({ ok: false, error: 'the service listed no models' });
  });
});

/**
 * Decision 165 — an anthropic-messages base is stored without `/v1`, so its
 * models are asked for at `/v1/models` first, with a bearer retry when that is
 * refused and the old `/models` as the last resort.
 */
describe('UserProviderService — fetchModels for anthropic-messages', () => {
  const ROOT = 'https://proxy.example';
  const V1 = `${ROOT}/v1/models?limit=1000`;
  const LEGACY = `${ROOT}/models`;
  const ANTHROPIC = { 'x-api-key': 'K', 'anthropic-version': '2023-06-01' };
  const BEARER = { authorization: 'Bearer K' };

  function htmlResponse(status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
      text: vi.fn(async () => '<html>not here</html>'),
    };
  }

  function fetchAnthropic(baseUrl = ROOT) {
    return service().fetchModels({ baseUrl, api: 'anthropic-messages', apiKey: 'K' });
  }

  it('lists the official shape from /v1/models with the anthropic headers alone', async () => {
    fetchFn.mockResolvedValue(
      jsonResponse({
        data: [
          { id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5' },
          { id: 'claude-haiku-4-5', type: 'model' },
        ],
        has_more: false,
        last_id: 'claude-haiku-4-5',
      })
    );
    await expect(fetchAnthropic()).resolves.toEqual({
      ok: true,
      models: ['claude-opus-5-5', 'claude-haiku-4-5'],
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(V1, { headers: ANTHROPIC });
    expect(fetchFn.mock.calls[0][1].headers).not.toHaveProperty('authorization');
  });

  it('keeps a subpath and reduces a pasted /v1/messages before asking', async () => {
    fetchFn.mockResolvedValue(jsonResponse({ data: [{ id: 'claude-sonnet-5' }] }));
    await fetchAnthropic('https://gw.example/anthropic');
    await fetchAnthropic('https://gw.example/v1/messages');
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      'https://gw.example/anthropic/v1/models?limit=1000',
      'https://gw.example/v1/models?limit=1000',
    ]);
  });

  it('retries a refused /v1/models with a bearer token, never with both headers', async () => {
    fetchFn
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid x-api-key' }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'claude-opus-5-5' }] }));
    await expect(fetchAnthropic()).resolves.toEqual({ ok: true, models: ['claude-opus-5-5'] });
    expect(fetchFn.mock.calls).toEqual([
      [V1, { headers: ANTHROPIC }],
      [V1, { headers: BEARER }],
    ]);
  });

  it.each([
    400, 404, 500,
  ])('falls back to the old /models after /v1/models answered %i', async (status) => {
    const failed = jsonResponse({ error: 'no' }, status);
    const drain = vi.spyOn(failed, 'text');
    fetchFn
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'claude-sonnet-5' }] }));
    await expect(fetchAnthropic()).resolves.toEqual({ ok: true, models: ['claude-sonnet-5'] });
    // No bearer retry: the first answer was not a refusal.
    expect(fetchFn.mock.calls).toEqual([
      [V1, { headers: ANTHROPIC }],
      [LEGACY, { headers: ANTHROPIC }],
    ]);
    // The unread error body is drained so the connection is released.
    expect(drain).toHaveBeenCalledOnce();
  });

  it('falls through an HTML page and an empty list on /v1/models', async () => {
    fetchFn
      .mockResolvedValueOnce(htmlResponse(200))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'claude-opus-5' }] }));
    await expect(fetchAnthropic()).resolves.toEqual({ ok: true, models: ['claude-opus-5'] });

    fetchFn.mockReset();
    fetchFn
      .mockResolvedValueOnce(jsonResponse({ data: [], has_more: false }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'claude-opus-5' }] }));
    await expect(fetchAnthropic()).resolves.toEqual({ ok: true, models: ['claude-opus-5'] });
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([V1, LEGACY]);
  });

  it('names a refused key when any attempt was refused, after trying all three', async () => {
    fetchFn
      .mockResolvedValueOnce(jsonResponse({ error: 'no' }, 403))
      .mockResolvedValueOnce(jsonResponse({ error: 'no' }, 404))
      .mockResolvedValueOnce(htmlResponse(404));
    await expect(fetchAnthropic()).resolves.toEqual({
      ok: false,
      error: 'the service refused this API key',
    });
    expect(fetchFn.mock.calls).toEqual([
      [V1, { headers: ANTHROPIC }],
      [V1, { headers: BEARER }],
      [LEGACY, { headers: ANTHROPIC }],
    ]);
  });

  it('otherwise reports the first status and the paths it tried', async () => {
    fetchFn.mockResolvedValueOnce(htmlResponse(404)).mockResolvedValueOnce(htmlResponse(502));
    await expect(fetchAnthropic()).resolves.toEqual({
      ok: false,
      error: 'the service answered 404 (tried /v1/models, /models)',
    });

    fetchFn.mockReset();
    fetchFn.mockResolvedValueOnce(htmlResponse(200)).mockResolvedValueOnce(htmlResponse(200));
    await expect(fetchAnthropic()).resolves.toEqual({
      ok: false,
      error: 'the service did not answer with JSON (tried /v1/models, /models)',
    });
  });

  it('stops at the first transport failure instead of trying another path', async () => {
    fetchFn.mockRejectedValue(new Error('getaddrinfo ENOTFOUND proxy.example'));
    await expect(fetchAnthropic()).resolves.toEqual({
      ok: false,
      error: 'getaddrinfo ENOTFOUND proxy.example',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('leaves the other styles on a single request', async () => {
    fetchFn.mockResolvedValue(jsonResponse({ error: 'no' }, 404));
    await expect(
      service().fetchModels({
        baseUrl: 'https://api.example.com/v1',
        api: 'openai-completions',
        apiKey: 'K',
      })
    ).resolves.toEqual({ ok: false, error: 'the service answered 404' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
