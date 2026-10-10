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

// dsh-rebase P1-12 step 3 (decision 147): `PI_PROJECT_TRUST_ENV` and
// `NATIVE_PROJECT_TRUSTED` left with the native worker, their only readers.
// The DSH bridge passes project trust as a constant of its own (decision 009).

// dsh-rebase decision 171: F08's User-Agent reference (`$AICLIENT_PI_USER_AGENT`
// in every provider's `headers`) went with the native worker that resolved it;
// the product name lives on in `types/requestUserAgent.ts`.

/**
 * Feature id of delegation, and the only native feature switch there is today.
 *
 * A feature id rather than a package name: T026 retired the package this used
 * to enable, and what the switch turned on in 1.0.x was the self-owned
 * runtime's delegation. Since dsh-rebase P1-12 it is only read by the
 * legacy-asset notice (decision 116 rule 9).
 */
export const PI_SUBAGENTS_FEATURE_ID = 'subagents';

/**
 * The older boolean behind {@link PI_SUBAGENTS_FEATURE_ID}, still read so an
 * install that set it keeps its choice. Absent is "never chose", which is ON.
 * Since dsh-rebase P1-12 its only reader is the legacy-asset notice
 * (`delegationSwitchExplicitlyOff`, decision 116 rule 9).
 */
export const PI_ENABLE_SUBAGENTS_SETTING_KEY = 'enablePiSubagents';

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
  /**
   * import-catalog-06 — ARD D15's per-model escape hatch, as a field.
   *
   * The runtime has always honoured it (`model-adapter/catalog.ts` keeps it and
   * `binding.ts` lets the row's own address beat the provider's), but the Main
   * side dropped it on the floor: `validateModel` builds its result field by
   * field, so an address an administrator wrote on one model never reached
   * `models.json` and never reached the in-memory catalog either. Declared here
   * so the whitelist has something to carry it in.
   *
   * Used VERBATIM, never suffixed: D15 states that an explicit override must not
   * be rewritten by the wire-protocol derivation — that derivation is the thing
   * it exists to escape from.
   */
  baseUrl?: string;
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
/**
 * A3 appends `'bundled'`: the catalog snapshot that shipped inside this release
 * artifact, read with no network I/O when nothing better is available.
 *
 * It is deliberately NOT folded into `'stale-cache'`, which means "the last
 * answer THIS client fetched". The two age differently and the UI owes the user
 * different sentences — a stale cache was current for this machine once, a
 * bundled baseline never was. Appended at the end of the union so the value
 * order stays stable for anything reading it positionally.
 */
export type PiModelSyncSource = 'remote' | 'stale-cache' | 'unavailable' | 'local' | 'bundled';

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

/**
 * Why a managed model sync did not produce a catalog.
 *
 * Six values, not six error strings: the renderer owes the user a different
 * SENTENCE and a different next step for each, and deriving that from
 * `error` — a free-form English diagnostic assembled from HTTP status text,
 * `JSON.parse` messages and `configValidation`'s field-by-field throws — would
 * be a substring match against text nobody promised to keep stable.
 *
 * Each value is decided where the failure happens and is never re-derived:
 *  - `credentials-disabled` / `credentials-missing` — `syncManagedPiModels`,
 *    before any request is made;
 *  - `unauthorized` / `server` — the moment a response object exists, off its
 *    status alone (see {@link httpSyncFailureKind});
 *  - `response` — the endpoint answered 2xx and the body could not be read,
 *    parsed or validated;
 *  - `network` — the default, and the only honest answer while no response
 *    exists yet: DNS, TLS, proxy, timeout and "the app is offline" all land
 *    here, and they share one next step (check the connection, try again).
 */
export type PiModelSyncFailureKind =
  | 'credentials-disabled'
  | 'credentials-missing'
  | 'unauthorized'
  | 'server'
  | 'response'
  | 'network';

/** `syncManagedPiModels`'s refusal when this install is on the local route. */
export const MANAGED_CREDENTIALS_DISABLED_ERROR = 'Managed credentials are disabled';

/** `syncManagedPiModels`'s refusal when the vault holds no gateway credential. */
export const MANAGED_CREDENTIALS_UNAVAILABLE_ERROR = 'Managed credentials are unavailable';

/**
 * A response exists, so the endpoint was reached — the only question left is
 * whether it refused THIS account (which no retry can fix) or failed for its
 * own reasons (which a retry can).
 */
export function httpSyncFailureKind(status: number): PiModelSyncFailureKind {
  return status === 401 || status === 403 ? 'unauthorized' : 'server';
}

/**
 * The last managed sync that came away with no catalog, kept so a renderer can
 * ask about it long after the login that triggered it.
 *
 * `error` is the raw English diagnostic and is NOT product copy: it is carried
 * for a bug report, printed small and below the explanation, never in place of
 * one.
 */
export interface PiModelSyncFailure {
  kind: PiModelSyncFailureKind;
  error: string;
  /** `Date.now()` of the attempt. */
  at: number;
}

export interface PiModelSyncResult extends PiModelSyncState {
  ok: boolean;
  /**
   * Set whenever `error` is. Present on `ok: true` results too — a stale cache
   * or the shipped baseline still means the wire failed, and the caller may
   * want to say which way.
   */
  failureKind?: PiModelSyncFailureKind;
}

export interface SyncPiModelsRequest {
  endpointUrl?: string;
}

export interface PiModelManagementSettings {
  endpointUrl: string;
  state: PiModelSyncState;
  managed: boolean;
  /**
   * The last failed managed sync, or `null` when the most recent one worked.
   *
   * Carried on this reply rather than on a channel of its own because every
   * consumer needs `managed` in the same breath: on the local route a missing
   * managed catalog is not a failure at all, it is the route working as
   * chosen.
   */
  lastFailure: PiModelSyncFailure | null;
}

/**
 * Settings → Extensions → Skills: the two skill folders the DSH host reads
 * (dsh-rebase P1-16e, decision 101). P1-12 step 1 dropped the delegation
 * switch, the prompt-template folders and the user's own `~/.pi/agent`
 * folders, which nothing reads any more (decisions 103-105, 116).
 */
export interface PiResourceSettings {
  managed: boolean;
  paths: {
    /** `~/.agents/skills`. */
    sharedSkills: string;
    /** `<appAgentDir>/skills`, the host's `customSkillDirs`. */
    appSkills: string;
  };
}

/**
 * The per-feature switch map 1.0.x wrote (`{ subagents: false }`); read only
 * by the legacy-asset notice since dsh-rebase P1-12.
 */
export const PI_OPT_IN_FEATURE_SETTINGS_KEY = 'piOptInFeatures';

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
    'id' | 'name' | 'tags' | 'reasoning' | 'thinkingLevelMap' | 'contextWindow' | 'input'
  >
): AgentModelOption {
  // T3: only the two kinds the runtime understands, deduplicated. An empty or
  // unrecognisable list is NOT passed on as `[]`: the runtime reads that the
  // same as an absent field (text-only), and so must every consumer here.
  const input = Array.isArray(model.input)
    ? [
        ...new Set(
          model.input.filter(
            (kind): kind is 'text' | 'image' => kind === 'text' || kind === 'image'
          )
        ),
      ]
    : [];
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
    ...(input.length > 0 ? { input } : {}),
  };
}
