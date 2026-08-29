import type { AgentModelOption } from './types/agentCatalog';

export const PI_MANAGED_AGENT_DIR_NAME = 'pi-agent';
export const PI_MODELS_FILE_NAME = 'models.json';
export const PI_AUTH_FILE_NAME = 'auth.json';
export const PI_MODEL_SYNC_STATE_FILE_NAME = 'managed-models-state.json';
export const PI_MODEL_MANAGEMENT_URL_SETTING_KEY = 'piModelManagementUrl';
export const PI_MODEL_MANAGEMENT_URL_ENV = 'PILAB_MODEL_CONFIG_URL';
export const DEFAULT_PI_MODEL_MANAGEMENT_URL = 'http://127.0.0.1:3210/api/v1/models-config';

export const PI_MODEL_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const;

export type PiModelApi = (typeof PI_MODEL_APIS)[number];

export interface PiManagedModelDefinition {
  id: string;
  name?: string;
  api?: PiModelApi;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Partial<
    Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>
  >;
  samplingParams?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

export interface PiManagedProviderDefinition {
  name?: string;
  baseUrl: string;
  api: PiModelApi;
  authHeader?: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models: PiManagedModelDefinition[];
}

export interface PiManagedModelsConfig {
  version: 1;
  updatedAt?: string;
  providers: Record<string, PiManagedProviderDefinition>;
}

export type PiModelSyncSource = 'remote' | 'stale-cache' | 'seed' | 'local';

export interface PiModelSyncState {
  source: PiModelSyncSource;
  endpointUrl: string | null;
  agentDir: string;
  modelCount: number;
  providerCount: number;
  lastAttemptAt: number | null;
  syncedAt: number | null;
  error?: string;
}

export interface PiModelSyncResult extends PiModelSyncState {
  ok: boolean;
}

export interface SyncPiModelsRequest {
  endpointUrl?: string;
}

export interface PiModelManagementSettings {
  endpointUrl: string;
  state: PiModelSyncState;
  managed: boolean;
}

export function parsePiModelRef(value: string): { provider: string; modelId: string } | null {
  const normalized = value.trim();
  const slash = normalized.indexOf('/');
  if (slash <= 0 || slash === normalized.length - 1) return null;
  const provider = normalized.slice(0, slash).trim();
  const modelId = normalized.slice(slash + 1).trim();
  return provider && modelId ? { provider, modelId } : null;
}

export function piModelOption(
  providerId: string,
  model: Pick<PiManagedModelDefinition, 'id' | 'name'>
): AgentModelOption {
  return {
    id: `${providerId}/${model.id}`,
    label: model.name?.trim() || model.id,
  };
}
