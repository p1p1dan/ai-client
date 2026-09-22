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
}

function fakeStore(initial: UserProvider[] = []): FakeStore {
  const store: FakeStore = {
    rows: [...initial],
    readStatus: 'ok',
    saved: [],
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
