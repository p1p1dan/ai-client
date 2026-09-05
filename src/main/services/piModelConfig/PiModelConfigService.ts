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
  type PiManagedModelDefinition,
  type PiManagedModelsConfig,
  type PiModelSyncResult,
  type PiModelSyncState,
  piModelOption,
} from '@shared/piModelConfig';
import type { AgentModelCatalog, AgentModelCatalogError } from '@shared/types/agentCatalog';
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
}

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

export class PiModelConfigService {
  private readonly agentDir: string;
  private readonly fetchFn: PiModelConfigFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly log: (...args: unknown[]) => void;

  constructor(options: PiModelConfigServiceOptions) {
    this.agentDir = options.agentDir;
    this.fetchFn = options.fetchFn;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
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

  readState(): PiModelSyncState {
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

    if (catalogSource === 'unavailable') {
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
    mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    chmodSync(this.agentDir, 0o700);
    atomicWriteJson(this.sourcePath, config, 0o600);
    atomicWriteJson(
      this.modelsPath,
      toPiModelsJson(config, { inheritedBaseUrl: inheritedBaseUrl.trim().replace(/\/+$/, '') }),
      0o600
    );
    this.writeAuth(config, inheritedApiKey);
  }

  /**
   * One entry per provider, each with ITS key: the administrator's when that
   * provider says its key is managed, this client's login key otherwise. The
   * previous version wrote the login key for every provider, which silently
   * ignored an administrator-supplied one.
   */
  private writeAuth(config: PiManagedModelsConfig, inheritedApiKey: string): void {
    const auth: Record<string, { type: 'api_key'; key: string }> = {};
    for (const [providerId, provider] of Object.entries(config.providers)) {
      auth[providerId] = { type: 'api_key', key: resolveProviderApiKey(provider, inheritedApiKey) };
    }
    atomicWriteJson(this.authPath, auth, 0o600);
  }

  private writeState(state: PiModelSyncState): void {
    atomicWriteJson(this.statePath, state, 0o600);
  }
}

function safeMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
