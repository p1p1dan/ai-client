import type { AgentModelOption } from './types/agentCatalog';

export const PI_MANAGED_AGENT_DIR_NAME = 'pi-agent';
export const PI_MODELS_FILE_NAME = 'models.json';
export const PI_AUTH_FILE_NAME = 'auth.json';
export const PI_MODEL_SYNC_STATE_FILE_NAME = 'managed-models-state.json';
/**
 * Wire-form copy of the last fetched catalog, kept beside pi's `models.json`.
 *
 * `models.json` is pi's format — resolved base URLs, no credential sources — so
 * it cannot say whether a provider's key was the administrator's or this
 * client's. That answer is needed every time the files are rewritten, so the
 * response is kept as received (0600, managed agent dir only).
 */
export const PI_MODEL_SOURCE_FILE_NAME = 'managed-models-source.json';
export const PI_MODEL_MANAGEMENT_URL_SETTING_KEY = 'piModelManagementUrl';
export const PI_MODEL_MANAGEMENT_URL_ENV = 'PILAB_MODEL_CONFIG_URL';

/**
 * T08-c (D-Q9 decision 4) — whether the pi Host may load a repository's own
 * `.pi/` scope.
 *
 * `'1'` = trusted (the local-environment route: the machine is the user's, and
 * what a repo they cloned is allowed to configure is their call).
 * `'0'` = withheld (the managed route: we promise this build works and answer
 * for what it permits, so a cloned repo may not loosen the policy).
 *
 * Carried as an env var because the Host is a separate process that has no
 * access to the credential mode. Read as an explicit tri-state — an ABSENT key
 * means an old Main build, which must not be read as either answer.
 *
 * Blast radius worth knowing: this is pi's own `projectTrusted`, so `'0'` also
 * stops a repo's `.pi/settings.json` from contributing packages and models —
 * not just permission rules. That is deliberate: a cloned repo adding a package
 * is a cloned repo running code.
 */
export const PI_PROJECT_TRUST_ENV = 'AICLIENT_PI_TRUST_PROJECT_CONFIG';

/**
 * Path of the catalog endpoint on the onboarding service (plan D05).
 *
 * The default URL is this path joined to the onboarding service address the
 * build was compiled with — there is no derivation from the cch gateway, and no
 * hardcoded localhost default: a packaged build pointing at `127.0.0.1` fails
 * every sync and used to hide that behind a built-in model list.
 */
export const PI_MODEL_CONFIG_PATH = '/api/v1/models-config';

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
  /** Ordered labels from the management site; the first is the primary group. */
  tags?: string[];
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

/**
 * Where a provider's baseUrl / apiKey comes from (plan D01 + wire topic §一).
 *
 * `'managed'` — the management site carries the value, and it is present in the
 * config. `'onboarding'` — inherit the value this client received when it
 * logged in, so the config carries nothing.
 *
 * Stated explicitly per provider. An ABSENT `credentials` block is not a third
 * answer: it identifies a pre-D01 management endpoint, where everything was
 * inherited, and is read as both fields being `'onboarding'`.
 */
export type PiCredentialSource = 'managed' | 'onboarding';

export interface PiManagedProviderCredentials {
  baseUrl: PiCredentialSource;
  apiKey: PiCredentialSource;
}

export interface PiManagedProviderDefinition {
  name?: string;
  /** Present only when `credentials.baseUrl === 'managed'`; otherwise inherited. */
  baseUrl?: string;
  api: PiModelApi;
  authHeader?: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  credentials?: PiManagedProviderCredentials;
  /** Present only when `credentials.apiKey === 'managed'`, and only from an authenticated fetch. */
  apiKey?: string;
  models: PiManagedModelDefinition[];
}

export interface PiManagedModelsConfig {
  version: 1;
  updatedAt?: string;
  providers: Record<string, PiManagedProviderDefinition>;
}

/**
 * Where the models currently on disk came from.
 *
 * `'unavailable'` replaced the old `'seed'` (plan D03): there is no built-in
 * model table any more, so "the fetch failed and nothing is cached" is stated as
 * such instead of being papered over with three hardcoded ids. Note that it is
 * NOT the same as a successful fetch that returned zero models — that is
 * `'remote'` with an empty catalog, which is a legal answer meaning the
 * administrator has enabled nothing.
 */
export type PiModelSyncSource = 'remote' | 'stale-cache' | 'unavailable' | 'local';

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
  model: Pick<
    PiManagedModelDefinition,
    'id' | 'name' | 'tags' | 'reasoning' | 'thinkingLevelMap' | 'contextWindow'
  >
): AgentModelOption {
  return {
    id: `${providerId}/${model.id}`,
    label: model.name?.trim() || model.id,
    ...(model.tags ? { tags: [...model.tags] } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    // T38-b: carried, not dropped. A positive finite window only — a `0` or a
    // negative one is a broken configuration entry, and passing it on would give
    // every occupancy consumer a division by zero to defend against.
    ...(typeof model.contextWindow === 'number' &&
    Number.isFinite(model.contextWindow) &&
    model.contextWindow > 0
      ? { contextWindow: model.contextWindow }
      : {}),
  };
}
