/**
 * H/17 L2 — CRUD over the vault's user-added service group, plus the model
 * listing that populates the add/edit form.
 *
 * Pure module in the same sense as `CredentialVault`: no `electron` import,
 * every capability injected. The wiring that reaches for the real vault and
 * `net.fetch` lives in `index.ts`.
 *
 * ## The key never leaves this process
 *
 * Everything handed back to the renderer is a {@link UserProviderView}, which
 * carries `hasApiKey` and not the key. An edit that does not retype the key
 * sends no key at all and this service reuses the stored one. That is why
 * `fetchModels` accepts an `id` instead of making the form round-trip a secret
 * it already has.
 */

import { randomUUID } from 'node:crypto';
import {
  checkProviderBaseUrl,
  type FetchProviderModelsResult,
  isUserProviderApi,
  normalizeProviderBaseUrl,
  PROVIDER_MODELS_PATH,
  type UserProviderApi,
  type UserProviderDraft,
  type UserProviderState,
  type UserProviderView,
} from '@shared/userProviders';
import type { UserProvider, VaultSaveResult } from '../auth/CredentialVault';

/** The subset of `CredentialVault` this service needs, so tests need no vault file. */
export interface UserProviderStore {
  readUserProviders():
    | { status: 'ok'; providers: UserProvider[] }
    | { status: 'absent' }
    | { status: 'locked' }
    | { status: 'unsupported' }
    | { status: 'invalid'; reason: string };
  saveUserProviders(providers: readonly UserProvider[]): Promise<VaultSaveResult>;
  encryptionAvailable(): boolean;
}

export interface UserProviderServiceOptions {
  store: UserProviderStore;
  fetchFn: (
    url: string,
    init: { headers: Record<string, string> }
  ) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
  /** Called after any successful mutation so the derived pi files are rewritten. */
  onChange?: (providers: readonly UserProvider[]) => void;
  now?: () => Date;
}

/** Size guard on the model-list response — a service that answers with megabytes is not one. */
const MAX_MODEL_IDS = 2000;

export class UserProviderService {
  private readonly store: UserProviderStore;
  private readonly fetchFn: UserProviderServiceOptions['fetchFn'];
  private readonly onChange: (providers: readonly UserProvider[]) => void;
  private readonly now: () => Date;

  constructor(options: UserProviderServiceOptions) {
    this.store = options.store;
    this.fetchFn = options.fetchFn;
    this.onChange = options.onChange ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  /** Everything the settings page renders, with no secret in it. */
  state(): UserProviderState {
    const encrypted = this.store.encryptionAvailable();
    const read = this.store.readUserProviders();
    if (read.status === 'ok') {
      return { providers: read.providers.map(toView), encrypted };
    }
    // `absent` is not a failure — it is a vault nobody has added a service to.
    if (read.status === 'absent') {
      return { providers: [], encrypted };
    }
    return {
      providers: [],
      encrypted,
      unavailable: read.status === 'invalid' ? 'invalid' : read.status,
    };
  }

  async upsert(draft: UserProviderDraft): Promise<UserProviderView> {
    const providers = this.requireList();
    const existing = draft.id ? providers.find((row) => row.id === draft.id) : undefined;
    if (draft.id && !existing) throw new Error('No such AI service');

    const name = draft.name.trim();
    if (!name) throw new Error('AI service needs a name');
    if (!isUserProviderApi(draft.api)) throw new Error('Unsupported API style');

    const baseUrl = normalizeProviderBaseUrl(draft.baseUrl);
    const issue = checkProviderBaseUrl(baseUrl);
    if (issue) throw new Error(`Service URL is not usable: ${issue}`);

    // Absent means "keep the stored key"; present-but-blank is a mistake worth
    // refusing, because a keyless provider fails only when a turn is already
    // in flight.
    const apiKey = draft.apiKey === undefined ? existing?.apiKey : draft.apiKey.trim();
    if (!apiKey) throw new Error('AI service needs an API key');

    const next: UserProvider = {
      id: existing?.id ?? randomUUID(),
      name,
      baseUrl,
      api: draft.api,
      apiKey,
      ...(existing?.headers ? { headers: existing.headers } : {}),
      models: draft.models ?? existing?.models ?? [],
      enabled: draft.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? this.now().toISOString(),
      // Carried, never editable. It is the key older sessions recorded, so
      // losing it on a rename would break exactly the sessions the migration
      // just repaired — and renaming is the most likely reason to open this
      // form at all (H/21 point-check D1).
      ...(existing?.configKey ? { configKey: existing.configKey } : {}),
    };

    const merged = existing
      ? providers.map((row) => (row.id === next.id ? next : row))
      : [...providers, next];
    await this.commit(merged);
    return toView(next);
  }

  async remove(id: string): Promise<void> {
    const providers = this.requireList();
    const next = providers.filter((row) => row.id !== id);
    if (next.length === providers.length) throw new Error('No such AI service');
    await this.commit(next);
  }

  async setEnabled(id: string, enabled: boolean): Promise<UserProviderView> {
    const providers = this.requireList();
    const target = providers.find((row) => row.id === id);
    if (!target) throw new Error('No such AI service');
    const next = { ...target, enabled };
    await this.commit(providers.map((row) => (row.id === id ? next : row)));
    return toView(next);
  }

  /**
   * Ask the service what models it has. Doubles as the connectivity test: a
   * wrong URL, a refused key and an unreachable host are three different
   * answers here, and the form shows which one happened.
   */
  async fetchModels(request: {
    baseUrl: string;
    api: UserProviderApi;
    apiKey?: string;
    id?: string;
  }): Promise<FetchProviderModelsResult> {
    const baseUrl = normalizeProviderBaseUrl(request.baseUrl);
    const issue = checkProviderBaseUrl(baseUrl);
    if (issue) return { ok: false, error: `Service URL is not usable: ${issue}` };

    const apiKey = request.apiKey?.trim() || this.storedKey(request.id);
    if (!apiKey) return { ok: false, error: 'AI service needs an API key' };

    let response: Awaited<ReturnType<UserProviderServiceOptions['fetchFn']>>;
    try {
      response = await this.fetchFn(`${baseUrl}${PROVIDER_MODELS_PATH}`, {
        headers: authHeaders(request.api, apiKey),
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    if (!response.ok) {
      // 401/403 is the one worth naming: it is the answer people misread as
      // "the URL is wrong" and then spend ten minutes on.
      const detail =
        response.status === 401 || response.status === 403
          ? 'the service refused this API key'
          : `the service answered ${response.status}`;
      return { ok: false, error: detail };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: 'the service did not answer with JSON' };
    }
    const models = extractModelIds(body);
    if (models.length === 0) {
      return { ok: false, error: 'the service listed no models' };
    }
    return { ok: true, models: models.slice(0, MAX_MODEL_IDS) };
  }

  private storedKey(id: string | undefined): string | undefined {
    if (!id) return undefined;
    const read = this.store.readUserProviders();
    return read.status === 'ok' ? read.providers.find((row) => row.id === id)?.apiKey : undefined;
  }

  /**
   * The current list, or a thrown error.
   *
   * A mutation must never start from an empty list it inferred from a failed
   * read — saving that would delete every service the user has. `absent` is
   * the one non-failure: there is genuinely nothing stored yet.
   */
  private requireList(): UserProvider[] {
    const read = this.store.readUserProviders();
    if (read.status === 'ok') return read.providers;
    if (read.status === 'absent') return [];
    throw new Error(
      read.status === 'locked'
        ? 'Unlock the system keyring before changing AI services'
        : 'Stored AI services could not be read'
    );
  }

  private async commit(providers: readonly UserProvider[]): Promise<void> {
    const result = await this.store.saveUserProviders(providers);
    if (!result.ok) throw new Error(`Could not save AI services: ${result.reason}`);
    this.onChange(providers);
  }
}

function toView(provider: UserProvider): UserProviderView {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.api as UserProviderApi,
    hasApiKey: provider.apiKey.length > 0,
    models: provider.models ?? [],
    enabled: provider.enabled,
    createdAt: provider.createdAt,
  };
}

/** How each API style expects the key to be presented. */
function authHeaders(api: UserProviderApi, apiKey: string): Record<string, string> {
  if (api === 'anthropic-messages' || api === 'pi-messages') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  if (api === 'google-generative-ai') {
    return { 'x-goog-api-key': apiKey };
  }
  return { authorization: `Bearer ${apiKey}` };
}

/**
 * Pull model ids out of a listing response.
 *
 * Three shapes in the wild: OpenAI's `{data:[{id}]}`, Anthropic's
 * `{data:[{id}]}` (same), and Google's `{models:[{name}]}`. A bare array is
 * accepted too. Anything else yields nothing rather than a guess.
 */
function extractModelIds(body: unknown): string[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? ((body as Record<string, unknown>).data ?? (body as Record<string, unknown>).models)
      : undefined;
  if (!Array.isArray(rows)) return [];
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      ids.push(row);
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : record.name;
    if (typeof id !== 'string' || !id) continue;
    // Google returns `models/gemini-2.0-flash`; the id pi needs is the tail.
    ids.push(id.startsWith('models/') ? id.slice('models/'.length) : id);
  }
  return [...new Set(ids)];
}
