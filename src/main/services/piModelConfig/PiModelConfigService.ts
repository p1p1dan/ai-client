import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  PI_AUTH_FILE_NAME,
  PI_MODEL_SOURCE_FILE_NAME,
  PI_MODEL_SYNC_STATE_FILE_NAME,
  PI_MODELS_FILE_NAME,
  PI_USER_AGENT_ENV,
  PI_USER_AGENT_HEADER,
  type PiManagedModelDefinition,
  type PiManagedModelsConfig,
  type PiModelSyncResult,
  type PiModelSyncState,
  piModelOption,
} from '@shared/piModelConfig';
import type { AgentModelCatalog, AgentModelCatalogError } from '@shared/types/agentCatalog';
import type { UserProvider } from '../auth/CredentialVault';
import { type BundledCatalogReader, createBundledCatalogReader } from './catalogSnapshot';
import {
  resolveProviderApiKey,
  toPiModelsJson,
  validatePiManagedModelsConfig,
} from './configValidation';

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface PiModelConfigFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type PiModelConfigFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }
) => Promise<PiModelConfigFetchResponse>;

export interface PiModelConfigServiceOptions {
  agentDir: string;
  fetchFn: PiModelConfigFetch;
  now?: () => number;
  timeoutMs?: number;
  log?: (...args: unknown[]) => void;
  /**
   * A3 — the catalog snapshot shipped in the release artifact, injectable so
   * tests can state one instead of writing into `resources/`. Defaults to the
   * real packaged/checked-in file.
   */
  readBundledCatalog?: BundledCatalogReader;
  /**
   * H/17 — the user's own services, read fresh on every write.
   *
   * A supplier on the constructor rather than a parameter on each write call:
   * a managed sync rebuilds `models.json` from the server response alone, so
   * any write path that forgot to pass them would delete every user service
   * from the file pi actually reads. There is no path here that can forget.
   */
  userProviders?: () => readonly UserProvider[];
  /**
   * import-catalog-03 — whether this installation is on the managed route.
   *
   * Injected rather than read from `auth/credentialMode` directly: that module
   * needs `electron`, and this service is constructed against a temp directory
   * in tests. Defaults to the managed route, which is what every caller that
   * does not state a mode has always behaved as.
   *
   * It exists so ONE function can decide what the managed half of the catalog
   * is — see {@link PiModelConfigService.managedHalf}.
   */
  managedCredentialsEnabled?: () => boolean;
}

/** No managed providers at all. Not an error: plan D03 makes it a legal answer. */
const EMPTY_CONFIG: PiManagedModelsConfig = { version: 1, providers: {} };

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function atomicWriteJson(path: string, value: unknown, mode: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  chmodSync(tmpPath, mode);
  renameSync(tmpPath, path);
  chmodSync(path, mode);
}

function modelCounts(config: PiManagedModelsConfig): { providerCount: number; modelCount: number } {
  const providers = Object.values(config.providers);
  return {
    providerCount: providers.length,
    modelCount: providers.reduce((sum, provider) => sum + provider.models.length, 0),
  };
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 240);
  return String(error).slice(0, 240);
}

/**
 * The last catalog this client fetched, in WIRE form.
 *
 * Kept beside `models.json` rather than parsed back out of it, because
 * `models.json` is pi's format: it carries a resolved base URL and no
 * credential sources at all, so it cannot answer "was this provider's key the
 * administrator's or the login one" — which is exactly what a re-write after a
 * key rotation has to know. Read with credentials allowed: this file is our own
 * copy of an authenticated response, written 0600 in the managed agent dir.
 */
function readCachedConfig(path: string): PiManagedModelsConfig | null {
  if (!existsSync(path)) return null;
  try {
    return validatePiManagedModelsConfig(readJson(path), { credentialsAllowed: true });
  } catch {
    return null;
  }
}

function readLocalModelOptions(path: string): Array<{
  providerId: string;
  model: Pick<
    PiManagedModelDefinition,
    'id' | 'name' | 'tags' | 'reasoning' | 'thinkingLevelMap' | 'contextWindow'
  >;
}> {
  if (!existsSync(path)) return [];
  try {
    const parsed = readJson(path);
    if (!parsed || typeof parsed !== 'object' || !('providers' in parsed)) return [];
    const providers = (parsed as { providers: unknown }).providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
    const out: Array<{
      providerId: string;
      model: Pick<
        PiManagedModelDefinition,
        'id' | 'name' | 'tags' | 'reasoning' | 'thinkingLevelMap' | 'contextWindow'
      >;
    }> = [];
    for (const [providerId, rawProvider] of Object.entries(providers)) {
      if (!rawProvider || typeof rawProvider !== 'object' || Array.isArray(rawProvider)) continue;
      const models = (rawProvider as { models?: unknown }).models;
      if (!Array.isArray(models)) continue;
      for (const rawModel of models) {
        if (!rawModel || typeof rawModel !== 'object' || Array.isArray(rawModel)) continue;
        const raw = rawModel as Record<string, unknown>;
        const id = raw.id;
        const name = raw.name;
        if (typeof id !== 'string' || !id.trim()) continue;
        const tags = Array.isArray(raw.tags)
          ? raw.tags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim()))
          : undefined;
        let thinkingLevelMap: PiManagedModelDefinition['thinkingLevelMap'];
        if (
          raw.thinkingLevelMap &&
          typeof raw.thinkingLevelMap === 'object' &&
          !Array.isArray(raw.thinkingLevelMap)
        ) {
          thinkingLevelMap = {};
          const rawMap = raw.thinkingLevelMap as Record<string, unknown>;
          for (const level of PI_THINKING_LEVELS) {
            const mapped = rawMap[level];
            if (typeof mapped === 'string' || mapped === null) thinkingLevelMap[level] = mapped;
          }
        }
        out.push({
          providerId,
          model: {
            id: id.trim(),
            ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
            ...(tags ? { tags: [...new Set(tags.map((tag) => tag.trim()))] } : {}),
            ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
            ...(thinkingLevelMap ? { thinkingLevelMap: { ...thinkingLevelMap } } : {}),
            // T38-b: `piModelOption` re-checks the range, so this reader only
            // has to establish that the field is a number at all.
            ...(typeof raw.contextWindow === 'number' && Number.isFinite(raw.contextWindow)
              ? { contextWindow: raw.contextWindow }
              : {}),
          },
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The snapshot's providers as menu options, in configuration order.
 *
 * Ordered exactly like every other route through `piModelOption`: T25 derives
 * the primary tag group from the first model carrying each tag, so sorting here
 * would replace the administrator's order with locale collation for this one
 * source only.
 */
function bundledCatalogOptions(config: PiManagedModelsConfig): AgentModelCatalog['models'] {
  return Object.entries(config.providers).flatMap(([providerId, provider]) =>
    provider.models.map((model) => piModelOption(providerId, model))
  );
}

export class PiModelConfigService {
  private readonly agentDir: string;
  private readonly fetchFn: PiModelConfigFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly log: (...args: unknown[]) => void;
  private readonly readBundledCatalog: BundledCatalogReader;
  private readonly userProviders: () => readonly UserProvider[];
  private readonly managedCredentialsEnabled: () => boolean;

  constructor(options: PiModelConfigServiceOptions) {
    this.userProviders = options.userProviders ?? (() => []);
    this.managedCredentialsEnabled = options.managedCredentialsEnabled ?? (() => true);
    this.agentDir = options.agentDir;
    this.fetchFn = options.fetchFn;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
    this.readBundledCatalog = options.readBundledCatalog ?? createBundledCatalogReader();
  }

  get modelsPath(): string {
    return join(this.agentDir, PI_MODELS_FILE_NAME);
  }

  get authPath(): string {
    return join(this.agentDir, PI_AUTH_FILE_NAME);
  }

  get statePath(): string {
    return join(this.agentDir, PI_MODEL_SYNC_STATE_FILE_NAME);
  }

  /** Wire-form copy of the last fetched catalog; see `readCachedConfig`. */
  get sourcePath(): string {
    return join(this.agentDir, PI_MODEL_SOURCE_FILE_NAME);
  }

  async sync(input: {
    endpointUrl: string;
    apiKey: string;
    /** Login credentials every provider that inherits will be given. */
    inheritedBaseUrl: string;
    force?: boolean;
  }): Promise<PiModelSyncResult> {
    const attemptedAt = this.now();
    let remoteError: string | undefined;
    const cached = readCachedConfig(this.sourcePath);
    const previous = this.readState();
    if (
      !input.force &&
      cached &&
      previous.source === 'remote' &&
      previous.endpointUrl === input.endpointUrl &&
      previous.syncedAt !== null &&
      attemptedAt - previous.syncedAt < 10 * 60 * 1000
    ) {
      // Still fresh, but the login key may have changed since; rewriting is
      // cheap and keeps auth.json in step with the vault.
      this.writeAll(cached, input.apiKey, input.inheritedBaseUrl);
      return { ...previous, ok: true };
    }
    try {
      const response = await this.fetchFn(input.endpointUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          // D01: the endpoint answers only for a client that proves who it is,
          // because the answer may carry provider API keys.
          Authorization: `Bearer ${input.apiKey}`,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`management endpoint returned HTTP ${response.status}`);
      if (Buffer.byteLength(body, 'utf8') > MAX_CONFIG_BYTES) {
        throw new Error('management response exceeds 2 MiB');
      }
      const config = validatePiManagedModelsConfig(JSON.parse(body) as unknown, {
        credentialsAllowed: true,
      });
      this.writeAll(config, input.apiKey, input.inheritedBaseUrl);
      const counts = modelCounts(config);
      const state: PiModelSyncState = {
        source: 'remote',
        endpointUrl: input.endpointUrl,
        agentDir: this.agentDir,
        ...counts,
        lastAttemptAt: attemptedAt,
        syncedAt: attemptedAt,
      };
      this.writeState(state);
      return { ...state, ok: true };
    } catch (error) {
      remoteError = safeError(error);
      this.log('[pi-models] remote sync failed', { error: remoteError });
    }

    if (cached) {
      this.writeAll(cached, input.apiKey, input.inheritedBaseUrl);
      const state: PiModelSyncState = {
        source: 'stale-cache',
        endpointUrl: input.endpointUrl,
        agentDir: this.agentDir,
        ...modelCounts(cached),
        lastAttemptAt: attemptedAt,
        syncedAt: previous.syncedAt,
        error: remoteError,
      };
      this.writeState(state);
      return { ...state, ok: true };
    }

    // A3: no live answer and no cache of this client's own, but the release
    // artifact may carry a snapshot of the same management endpoint. It is a
    // rung BELOW `stale-cache` (that cache was current for this machine once;
    // a shipped baseline never was) and above `unavailable`.
    //
    // Written to `models.json` / `auth.json` and deliberately NOT to
    // `managed-models-source.json`. Two reasons, in order: pi reads its models
    // off disk, so a snapshot that stayed in memory would populate the menu
    // and then fail every turn the user started from it; and the wire cache
    // means "the last catalog we fetched", so seeding it with the bundled copy
    // would make the NEXT failed sync report `stale-cache` and destroy the one
    // signal that lets the UI say "this is the baseline we shipped with"
    // (ADR 0134 §3 — the snapshot itself is never written by the runtime, in
    // the package or in user data).
    const bundled = this.readBundledCatalog();
    if (bundled) {
      this.writeRuntimeConfig(bundled, input.apiKey, input.inheritedBaseUrl);
      const state: PiModelSyncState = {
        source: 'bundled',
        endpointUrl: input.endpointUrl,
        agentDir: this.agentDir,
        ...modelCounts(bundled),
        lastAttemptAt: attemptedAt,
        // Never fetched, so there is no fetch time to report. The snapshot's
        // own `updatedAt` is when an administrator last changed the catalog,
        // which is a different fact and not ours to relabel.
        syncedAt: null,
        error: remoteError,
      };
      this.writeState(state);
      // `ok` asks whether the client came away with a usable catalog, not
      // whether the network worked; `error` still carries the failure.
      return { ...state, ok: true };
    }

    // D03: no built-in table to fall back to. Say the catalog is unavailable
    // instead of handing out models nobody configured — a fabricated list makes
    // a failed fetch look like a successful one, which is how a packaged build
    // pointing at the wrong URL stayed invisible for so long.
    const state: PiModelSyncState = {
      source: 'unavailable',
      endpointUrl: input.endpointUrl,
      agentDir: this.agentDir,
      providerCount: 0,
      modelCount: 0,
      lastAttemptAt: attemptedAt,
      syncedAt: null,
      error: remoteError,
    };
    this.writeState(state);
    return { ...state, ok: false };
  }

  /**
   * The sync state, with A3's bundled snapshot standing in wherever the stored
   * state would otherwise be `unavailable`.
   *
   * The substitution happens in ONE place rather than at each producer so that
   * every route into `unavailable` gets the same floor: the state a failed sync
   * wrote, a state file that is missing or corrupt, and a first launch with no
   * `models.json` at all. `endpointUrl`, `lastAttemptAt` and `error` are passed
   * through untouched — the snapshot changes which catalog the user gets, not
   * what happened on the wire.
   */
  readState(): PiModelSyncState {
    const stored = this.readStoredState();
    if (stored.source !== 'unavailable') return stored;
    const bundled = this.readBundledCatalog();
    if (!bundled) return stored;
    return { ...stored, source: 'bundled', ...modelCounts(bundled) };
  }

  private readStoredState(): PiModelSyncState {
    if (existsSync(this.statePath)) {
      try {
        const value = readJson(this.statePath) as Partial<PiModelSyncState>;
        if (
          value &&
          typeof value.source === 'string' &&
          typeof value.agentDir === 'string' &&
          typeof value.modelCount === 'number' &&
          typeof value.providerCount === 'number'
        ) {
          return {
            source: value.source as PiModelSyncState['source'],
            endpointUrl: typeof value.endpointUrl === 'string' ? value.endpointUrl : null,
            agentDir: value.agentDir,
            modelCount: value.modelCount,
            providerCount: value.providerCount,
            lastAttemptAt: typeof value.lastAttemptAt === 'number' ? value.lastAttemptAt : null,
            syncedAt: typeof value.syncedAt === 'number' ? value.syncedAt : null,
            ...(typeof value.error === 'string' ? { error: value.error } : {}),
          };
        }
      } catch {
        // Reconstruct below.
      }
    }
    // No state file: fall back to what is on disk. Models present means a
    // local pi installation configured them; nothing present means we have no
    // catalog at all, which is stated rather than filled in.
    const models = readLocalModelOptions(this.modelsPath);
    return {
      source: models.length > 0 ? 'local' : 'unavailable',
      endpointUrl: null,
      agentDir: this.agentDir,
      providerCount: new Set(models.map((entry) => entry.providerId)).size,
      modelCount: models.length,
      lastAttemptAt: null,
      syncedAt: null,
    };
  }

  readCatalog(sourceOverride?: 'local'): AgentModelCatalog {
    // One reader for both routes: `models.json` is pi's own format either way,
    // and the state file is what says whether we fetched it or found it.
    const entries = readLocalModelOptions(this.modelsPath);
    const state = this.readState();
    const source = sourceOverride ?? state.source;
    const catalogSource = source === 'remote' ? 'managed' : source === 'local' ? 'local' : source;

    if (catalogSource === 'bundled') {
      // Built from the snapshot rather than from `models.json`, because the
      // snapshot is what `'bundled'` names and it is readable before any sync
      // has written a thing — a cold first launch has its menu immediately.
      // `stale` and a null `fetchedAt` are both literal: this was never a
      // fetched answer, so there is no time at which it was current here.
      const bundled = this.readBundledCatalog();
      if (bundled) {
        return {
          models: bundledCatalogOptions(bundled),
          source: 'bundled',
          stale: true,
          fetchedAt: null,
          ...(state.error ? { error: 'http' as AgentModelCatalogError } : {}),
        };
      }
    }

    // `'bundled'` reaches here only if the snapshot went away between the two
    // reads — degrade to `unavailable` rather than to a menu built out of
    // whatever `models.json` happens to hold.
    if (catalogSource === 'unavailable' || catalogSource === 'bundled') {
      // D03: distinct from an answered-but-empty catalog. No models, and we say
      // why rather than rendering an empty menu as if it were the answer.
      return {
        models: [],
        source: 'unavailable',
        stale: true,
        fetchedAt: null,
        ...(state.error ? { error: 'http' as AgentModelCatalogError } : {}),
      };
    }

    // Preserve provider/model configuration order. T25 derives primary tag
    // group order from the first model carrying each tag; alphabetizing here
    // would silently replace cloud-managed order with locale collation.
    const models = entries.map(({ providerId, model }) => piModelOption(providerId, model));
    const stale = catalogSource === 'stale-cache';
    let error: AgentModelCatalogError | undefined;
    if (state.error) error = 'http';
    return {
      models,
      source: catalogSource,
      stale,
      fetchedAt: state.syncedAt ?? safeMtime(this.modelsPath),
      ...(error ? { error } : {}),
    };
  }

  clearCredential(): void {
    try {
      if (existsSync(this.authPath)) unlinkSync(this.authPath);
    } catch (error) {
      this.log('[pi-models] failed to remove managed auth.json', { error: safeError(error) });
    }
  }

  /**
   * Writes all three files from one catalog: the wire-form copy, the
   * `models.json` pi reads, and the per-provider `auth.json`.
   */
  private writeAll(
    config: PiManagedModelsConfig,
    inheritedApiKey: string,
    inheritedBaseUrl: string
  ): void {
    atomicWriteJson(this.sourcePath, config, 0o600);
    this.writeRuntimeConfig(config, inheritedApiKey, inheritedBaseUrl);
  }

  /**
   * H/17 — rewrite the two files pi reads from the cached managed catalog plus
   * the user's own services.
   *
   * The local route never syncs, so nothing else would ever write these files
   * there. Managed providers come from the wire-form cache rather than being
   * re-fetched: this call is triggered by the user editing THEIR service, and
   * a network round trip for the other group would make a local edit fail when
   * the gateway is down.
   *
   * The managed cache is left untouched on disk — this method never writes
   * `sourcePath`, so a user edit can never be mistaken for a fetched catalog.
   */
  writeUserProviderConfig(input: {
    userProviders: readonly UserProvider[];
    inheritedApiKey: string;
    inheritedBaseUrl: string;
  }): void {
    this.writeRuntimeConfig(
      this.managedHalf(),
      input.inheritedApiKey,
      input.inheritedBaseUrl,
      input.userProviders
    );
  }

  /**
   * import-catalog-03 — which catalog is the MANAGED half, for both assembly
   * paths.
   *
   * It has to be one function. The two callers used to answer differently when
   * there was no wire cache: the writer started from an empty catalog, the
   * in-memory build from the shipped snapshot. That is a difference in RULE, not
   * in timing, and it showed up as two concrete disagreements — a managed client
   * whose first launch was offline had A3's snapshot written into `models.json`,
   * and then the user's next service edit erased those providers from the file
   * while the native worker still had them; and a local-route installation,
   * which the on-disk side has always refused to lend the shipped baseline to,
   * got it anyway through the in-memory side.
   *
   * The snapshot, not an empty catalog, is the right no-cache answer: A3 has
   * already written it to `models.json` on a cold managed launch, so starting
   * from empty would make a routine user edit delete the only catalog that
   * client has. An empty catalog is only correct where there is no managed half
   * at all, which is the local route.
   *
   * The wire cache is kept in BOTH modes. It records a catalog this client
   * really fetched while it was managed, and dropping it when the mode flips
   * would silently rewrite `models.json` — a bigger claim than "do not lend the
   * baseline", and not one this fix makes.
   */
  private managedHalf(): PiManagedModelsConfig {
    const cached = readCachedConfig(this.sourcePath);
    if (cached) return cached;
    if (!this.managedCredentialsEnabled()) return EMPTY_CONFIG;
    return this.readBundledCatalog() ?? EMPTY_CONFIG;
  }

  /**
   * Just the two files pi itself reads.
   *
   * Split out of {@link writeAll} for A3: the bundled snapshot has to reach pi,
   * but it must not be filed as the wire-form cache of a catalog this client
   * fetched — see the comment at that call site.
   */
  private writeRuntimeConfig(
    config: PiManagedModelsConfig,
    inheritedApiKey: string,
    inheritedBaseUrl: string,
    userProviders: readonly UserProvider[] = this.userProviders()
  ): void {
    mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    chmodSync(this.agentDir, 0o700);
    const { models, auth } = buildRuntimeConfig(
      config,
      inheritedApiKey,
      inheritedBaseUrl,
      userProviders
    );
    atomicWriteJson(this.modelsPath, models, 0o600);
    atomicWriteJson(this.authPath, auth, 0o600);
  }

  /**
   * P5-5 — the same two documents, in memory, for a backend that does not need
   * them on disk.
   *
   * The same builder AND the same input selection as the on-disk write — both
   * take the managed half from {@link PiModelConfigService.managedHalf} — so
   * "what native runs on" and "what legacy reads" can only differ by when they
   * were assembled. Before import-catalog-03 that claim was written here but not
   * implemented: the two sides picked different inputs whenever the wire cache
   * was missing. The files stay because pi has no other way in; the native
   * worker is handed this instead, and the plaintext keys never have to exist
   * outside this process for it.
   *
   * `userProviders` may be supplied by the caller. The Main-side wiring reads
   * the vault itself (it has to distinguish "no services" from "could not be
   * read" — import-catalog-02) and passes the group it already has, rather than
   * making this method read the same vault a second time.
   */
  buildNativeModelCatalog(input: {
    inheritedApiKey: string;
    inheritedBaseUrl: string;
    userProviders?: readonly UserProvider[];
  }): {
    models: Record<string, unknown>;
    auth: Record<string, unknown>;
  } {
    return buildRuntimeConfig(
      this.managedHalf(),
      input.inheritedApiKey,
      input.inheritedBaseUrl,
      input.userProviders ?? this.userProviders()
    );
  }

  private writeState(state: PiModelSyncState): void {
    atomicWriteJson(this.statePath, state, 0o600);
  }
}

/**
 * The two documents a runtime needs, from one catalog plus the user's own
 * services.
 *
 * A pure function so P5-5's in-memory hand-over and the on-disk write for
 * legacy cannot diverge: there is exactly one place that decides which
 * providers exist, which address each is reached at and which key it presents.
 */
function buildRuntimeConfig(
  config: PiManagedModelsConfig,
  inheritedApiKey: string,
  inheritedBaseUrl: string,
  userProviders: readonly UserProvider[]
): { models: Record<string, unknown>; auth: Record<string, unknown> } {
  const models = toPiModelsJson(config, {
    inheritedBaseUrl: inheritedBaseUrl.trim().replace(/\/+$/, ''),
  }) as { providers: Record<string, unknown> };
  // One entry per provider, each with ITS key: the administrator's when that
  // provider says its key is managed, this client's login key otherwise.
  const auth: Record<string, { type: 'api_key'; key: string }> = {};
  for (const [providerId, provider] of Object.entries(config.providers)) {
    auth[providerId] = { type: 'api_key', key: resolveProviderApiKey(provider, inheritedApiKey) };
  }
  // Merged AFTER the managed providers, which is what makes "同名以用户组
  // 优先" true: a user service whose slug collides with a managed provider
  // id replaces it here rather than being dropped.
  for (const provider of userProviders) {
    if (!provider.enabled) continue;
    const id = userProviderId(provider);
    models.providers[id] = toPiUserProvider(provider);
    // A user service always carries its own key — inheriting the company one
    // would silently bill the gateway for a request the user aimed elsewhere.
    auth[id] = { type: 'api_key', key: provider.apiKey };
  }
  return { models, auth };
}

/**
 * The id a user service takes in `models.json`.
 *
 * A migrated service keeps the key its own `models.json` already used
 * (`configKey`), and that outranks everything else: sessions created before the
 * migration recorded `<thatKey>/<model>`, so re-deriving the id here renames
 * the provider out from under them and leaves every one of those sessions
 * failing with `Pi model not found` — after a migration that reported success.
 * That was H/21 point-check D1 (2026-09-11): `cx2` came back as `cx2-gpt-5-6`,
 * because the display name is "CX2 (GPT-5.6)".
 *
 * Otherwise the display name, slugified: this string is what the model picker
 * shows on the left of `provider/model`, and `user-3f2a…/gpt-4o` is not a thing
 * anyone can read. The uuid is the last resort, for a name that slugifies to
 * nothing (all punctuation, or a script this regex does not cover).
 */
function userProviderId(provider: UserProvider): string {
  const preserved = provider.configKey?.trim();
  if (preserved) return preserved;
  const slug = provider.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `user-${provider.id.slice(0, 8)}`;
}

/**
 * One user service in `models.json` form.
 *
 * `headers` keeps only `$`-prefixed values. `validateProvider` enforces that
 * rule on the managed side so a literal secret can never land in this file,
 * and a hand-typed header must not be the hole in it — the app's own
 * User-Agent reference is added the same way the managed writer adds it.
 */
function toPiUserProvider(provider: UserProvider): Record<string, unknown> {
  const headers: Record<string, string> = { [PI_USER_AGENT_HEADER]: `$${PI_USER_AGENT_ENV}` };
  for (const [name, value] of Object.entries(provider.headers ?? {})) {
    if (value.startsWith('$')) headers[name] = value;
  }
  return {
    baseUrl: provider.baseUrl,
    api: provider.api,
    headers,
    models: (provider.models ?? []).map((id) => ({ id })),
  };
}

function safeMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
