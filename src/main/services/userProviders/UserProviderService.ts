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
  type ProviderModelListAuth,
  providerModelListAttempts,
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
  /** Save over a group that reads `invalid`, keeping a copy of the old file first. */
  replaceUnreadableUserProviders(providers: readonly UserProvider[]): Promise<VaultSaveResult>;
  encryptionAvailable(): boolean;
}

type UserProviderRead = ReturnType<UserProviderStore['readUserProviders']>;

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
    const read = this.store.readUserProviders();
    // Adding is the one mutation allowed past an `invalid` group: the settings
    // page offers "adding one again will replace the record" as the way out,
    // and without it nothing could ever be added on that machine again. The
    // list starts empty because nothing in the old group is readable; the
    // vault keeps a copy of the file before overwriting it. `locked` still
    // refuses — it is temporary, and saving then would lose a group that
    // opens fine once the keyring does.
    const replacesUnreadable = !draft.id && read.status === 'invalid';
    const providers = replacesUnreadable ? [] : this.requireList(read);
    const existing = draft.id ? providers.find((row) => row.id === draft.id) : undefined;
    if (draft.id && !existing) throw new Error('No such AI service');

    const name = draft.name.trim();
    if (!name) throw new Error('AI service needs a name');
    if (!isUserProviderApi(draft.api)) throw new Error('Unsupported API style');

    const baseUrl = normalizeProviderBaseUrl(draft.baseUrl, draft.api);
    const issue = checkProviderBaseUrl(baseUrl);
    if (issue) throw new Error(`Service URL is not usable: ${issue}`);

    // Absent means "keep the stored key"; present-but-blank is a mistake worth
    // refusing, because a keyless provider fails only when a turn is already
    // in flight.
    const apiKey = draft.apiKey === undefined ? existing?.apiKey : draft.apiKey.trim();
    if (!apiKey) throw new Error('AI service needs an API key');

    // Absent modelMeta means "keep whatever is stored", not "clear it": a
    // save that did not open the metadata section (or a non-form path like
    // setEnabled) must not silently drop metadata the user already typed. An
    // explicit empty map is how the form clears it (decision 165), and an
    // empty map is not stored.
    const modelMeta = draft.modelMeta ?? existing?.modelMeta;
    const keepsMeta = modelMeta !== undefined && Object.keys(modelMeta).length > 0;
    const next: UserProvider = {
      id: existing?.id ?? randomUUID(),
      name,
      baseUrl,
      api: draft.api,
      apiKey,
      ...(existing?.headers ? { headers: existing.headers } : {}),
      models: draft.models ?? existing?.models ?? [],
      ...(keepsMeta ? { modelMeta } : {}),
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
    await this.commit(merged, replacesUnreadable);
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
    const baseUrl = normalizeProviderBaseUrl(request.baseUrl, request.api);
    const issue = checkProviderBaseUrl(baseUrl);
    if (issue) return { ok: false, error: `Service URL is not usable: ${issue}` };

    const apiKey = request.apiKey?.trim() || this.storedKey(request.id);
    if (!apiKey) return { ok: false, error: 'AI service needs an API key' };

    // Decision 165: more than one path for some styles, tried in order. A
    // transport failure ends the loop at once — another path on the same host
    // cannot help — while any answer from the service moves on to the next.
    const failures: ModelListFailure[] = [];
    let previousRefused = false;
    for (const attempt of providerModelListAttempts(baseUrl, request.api)) {
      if (attempt.onlyAfterRefusal && !previousRefused) continue;
      let response: ModelListResponse;
      try {
        response = await this.fetchFn(attempt.url, { headers: authHeaders(attempt.auth, apiKey) });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const outcome = await readModelList(response);
      if (outcome.ok) return { ok: true, models: outcome.models.slice(0, MAX_MODEL_IDS) };
      failures.push({ ...outcome, path: attempt.path });
      previousRefused = isRefusal(outcome.status);
    }
    return { ok: false, error: describeModelListFailures(failures) };
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
   *
   * The vault's reason rides along in the message: it is the only field note
   * a user can paste back from the error, and each reason has a different fix.
   */
  private requireList(read: UserProviderRead = this.store.readUserProviders()): UserProvider[] {
    if (read.status === 'ok') return read.providers;
    if (read.status === 'absent') return [];
    if (read.status === 'locked') {
      throw new Error('Unlock the system keyring before changing AI services');
    }
    const reason = read.status === 'invalid' ? read.reason : read.status;
    throw new Error(`Stored AI services could not be read (${reason})`);
  }

  private async commit(
    providers: readonly UserProvider[],
    replacesUnreadable = false
  ): Promise<void> {
    const result = replacesUnreadable
      ? await this.store.replaceUnreadableUserProviders(providers)
      : await this.store.saveUserProviders(providers);
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
    ...(provider.modelMeta ? { modelMeta: provider.modelMeta } : {}),
    enabled: provider.enabled,
    createdAt: provider.createdAt,
  };
}

type ModelListResponse = Awaited<ReturnType<UserProviderServiceOptions['fetchFn']>>;

interface ModelListFailure {
  path: string;
  /** The HTTP status, when the service answered with a non-2xx one. */
  status?: number;
  detail: string;
}

function isRefusal(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/** One answer read as a model list, or as the reason it is not one. */
async function readModelList(
  response: ModelListResponse
): Promise<{ ok: true; models: string[] } | { ok: false; status?: number; detail: string }> {
  if (!response.ok) {
    discardBody(response);
    return {
      ok: false,
      status: response.status,
      detail: `the service answered ${response.status}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, detail: 'the service did not answer with JSON' };
  }
  const models = extractModelIds(body);
  if (models.length === 0) return { ok: false, detail: 'the service listed no models' };
  return { ok: true, models };
}

/**
 * Read an unwanted body to its end in the background, so the connection is
 * released rather than left open behind a response nobody reads.
 */
function discardBody(response: ModelListResponse): void {
  try {
    void response.text().catch(() => undefined);
  } catch {
    // Nothing to release.
  }
}

/**
 * The one sentence a failed fetch shows. A refused key anywhere is the answer
 * worth naming: it is the one people misread as "the URL is wrong" and then
 * spend ten minutes on. Otherwise the first status the service answered (the
 * first failure when none had one), plus the paths tried when there were
 * several, so "404" is not read as "the only path is wrong".
 */
function describeModelListFailures(failures: readonly ModelListFailure[]): string {
  if (failures.some((failure) => isRefusal(failure.status))) {
    return 'the service refused this API key';
  }
  const first = failures.find((failure) => failure.status !== undefined) ?? failures[0];
  if (!first) return 'the service listed no models';
  const paths = [...new Set(failures.map((failure) => failure.path))];
  return paths.length > 1 ? `${first.detail} (tried ${paths.join(', ')})` : first.detail;
}

/** The headers that present the key the way `auth` says; never two at once. */
function authHeaders(auth: ProviderModelListAuth, apiKey: string): Record<string, string> {
  switch (auth) {
    case 'anthropic':
      return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    case 'google':
      return { 'x-goog-api-key': apiKey };
    case 'bearer':
      return { authorization: `Bearer ${apiKey}` };
  }
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
