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
  PI_MODEL_SYNC_STATE_FILE_NAME,
  PI_MODELS_FILE_NAME,
  type PiManagedModelDefinition,
  type PiManagedModelsConfig,
  type PiModelSyncResult,
  type PiModelSyncState,
  piModelOption,
} from '@shared/piModelConfig';
import type { AgentModelCatalog, AgentModelCatalogError } from '@shared/types/agentCatalog';
import { PI_AGENT } from '@shared/types/agentWire';
import { toPiModelsJson, validatePiManagedModelsConfig } from './configValidation';

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

function readValidatedModels(path: string): PiManagedModelsConfig | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = readJson(path);
    return validatePiManagedModelsConfig({
      version: 1,
      providers:
        parsed && typeof parsed === 'object' && 'providers' in parsed
          ? (parsed as { providers: unknown }).providers
          : undefined,
    });
  } catch {
    return null;
  }
}

function readLocalModelOptions(path: string): Array<{
  providerId: string;
  model: Pick<PiManagedModelDefinition, 'id' | 'name' | 'tags' | 'reasoning' | 'thinkingLevelMap'>;
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
        'id' | 'name' | 'tags' | 'reasoning' | 'thinkingLevelMap'
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

  async sync(input: {
    endpointUrl: string;
    apiKey: string;
    fallbackBaseUrl: string;
    force?: boolean;
  }): Promise<PiModelSyncResult> {
    const attemptedAt = this.now();
    let remoteError: string | undefined;
    const cached = readValidatedModels(this.modelsPath);
    const previous = this.readState();
    if (
      !input.force &&
      cached &&
      previous.source === 'remote' &&
      previous.endpointUrl === input.endpointUrl &&
      previous.syncedAt !== null &&
      attemptedAt - previous.syncedAt < 10 * 60 * 1000
    ) {
      this.writeAuth(cached, input.apiKey);
      return { ...previous, ok: true };
    }
    try {
      const response = await this.fetchFn(input.endpointUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`management endpoint returned HTTP ${response.status}`);
      if (Buffer.byteLength(body, 'utf8') > MAX_CONFIG_BYTES) {
        throw new Error('management response exceeds 2 MiB');
      }
      const config = validatePiManagedModelsConfig(JSON.parse(body) as unknown);
      this.writeConfigAndAuth(config, input.apiKey);
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
      this.writeAuth(cached, input.apiKey);
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

    const fallback = createDefaultManagedConfig(input.fallbackBaseUrl);
    this.writeConfigAndAuth(fallback, input.apiKey);
    const state: PiModelSyncState = {
      source: 'seed',
      endpointUrl: input.endpointUrl,
      agentDir: this.agentDir,
      ...modelCounts(fallback),
      lastAttemptAt: attemptedAt,
      syncedAt: null,
      error: remoteError,
    };
    this.writeState(state);
    return { ...state, ok: true };
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
    const config = readValidatedModels(this.modelsPath);
    const counts = config ? modelCounts(config) : { providerCount: 0, modelCount: 0 };
    return {
      source: config ? 'local' : 'seed',
      endpointUrl: null,
      agentDir: this.agentDir,
      ...counts,
      lastAttemptAt: null,
      syncedAt: null,
    };
  }

  readCatalog(sourceOverride?: 'local'): AgentModelCatalog {
    const config = sourceOverride ? null : readValidatedModels(this.modelsPath);
    const localModels = sourceOverride ? readLocalModelOptions(this.modelsPath) : [];
    if (!config && localModels.length === 0) {
      return sourceOverride
        ? {
            agent: PI_AGENT,
            models: [],
            source: 'local',
            stale: false,
            fetchedAt: safeMtime(this.modelsPath),
          }
        : {
            agent: PI_AGENT,
            models: [],
            source: 'seed',
            stale: true,
            fetchedAt: null,
            error: 'invalid-response',
          };
    }
    // Preserve provider/model configuration order. T25 derives primary tag
    // group order from the first model carrying each tag; alphabetizing here
    // would silently replace cloud-managed order with locale collation.
    const models = config
      ? Object.entries(config.providers).flatMap(([providerId, provider]) =>
          provider.models.map((model) => piModelOption(providerId, model))
        )
      : localModels.map(({ providerId, model }) => piModelOption(providerId, model));
    const state = this.readState();
    const source = sourceOverride ?? state.source;
    const catalogSource = source === 'remote' ? 'managed' : source === 'local' ? 'local' : source;
    const stale = catalogSource === 'stale-cache' || catalogSource === 'seed';
    let error: AgentModelCatalogError | undefined;
    if (state.error) error = 'http';
    return {
      agent: PI_AGENT,
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

  private writeConfigAndAuth(config: PiManagedModelsConfig, apiKey: string): void {
    mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    chmodSync(this.agentDir, 0o700);
    atomicWriteJson(this.modelsPath, toPiModelsJson(config), 0o600);
    this.writeAuth(config, apiKey);
  }

  private writeAuth(config: PiManagedModelsConfig, apiKey: string): void {
    const auth: Record<string, { type: 'api_key'; key: string }> = {};
    for (const providerId of Object.keys(config.providers)) {
      auth[providerId] = { type: 'api_key', key: apiKey };
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

export function createDefaultManagedConfig(baseUrl: string): PiManagedModelsConfig {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('managed Pi fallback requires a gateway base URL');
  return validatePiManagedModelsConfig({
    version: 1,
    providers: {
      pilab: {
        name: 'PILAB',
        baseUrl: normalized,
        api: 'openai-responses',
        authHeader: true,
        models: [
          { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', reasoning: true, contextWindow: 272000 },
          { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', reasoning: true, contextWindow: 272000 },
          { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', reasoning: true, contextWindow: 272000 },
        ],
      },
    },
  });
}
