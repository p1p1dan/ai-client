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
 * R01 — the user's own pi agent dir, whose skills and prompt templates the Host
 * should also load. Absent means borrow nothing.
 *
 * Managed mode moves `PI_CODING_AGENT_DIR` to `~/.pilab/pi-agent`, so anything
 * installed the documented way (under `~/.pi/agent/`) stops being visible, with
 * no message saying so. This carries the source directory back.
 *
 * Deliberately ONE value for both the switch and the target, unlike the
 * tri-state above: an absent key here needs no separate reading, because "did
 * not send a directory" and "do not borrow" are the same instruction, and an
 * older Main build that sends nothing lands on the conservative side. Main owns
 * the decision because it is the side that knows the credential mode and the
 * user setting; the Host only resolves the two subdirectories and checks they
 * exist.
 *
 * Scope is resources only. The Host must never turn this into an extension
 * path: an extension is code, and the user's own copy of the permission system
 * would collide with the patched one this app ships.
 */
export const PI_BORROW_RESOURCES_DIR_ENV = 'AICLIENT_PI_BORROW_RESOURCES_DIR';

/** R01 — user setting behind {@link PI_BORROW_RESOURCES_DIR_ENV}. Absent = on. */
export const PI_BORROW_USER_RESOURCES_SETTING_KEY = 'borrowUserPiResources';

/**
 * Which OPT-IN bundled feature extensions this session may load, as a
 * comma-separated list of feature ids (see `bundledPlugins.mjs`).
 *
 * Shaped exactly like {@link PI_BORROW_RESOURCES_DIR_ENV} and for the same
 * reason: one value carries both the switch and the target, and an ABSENT key
 * means "load none of them" — so an older Main build that sends nothing lands on
 * the conservative side rather than on a second reading of the state.
 *
 * It exists because a bundled extension is not free: its tool schemas are part
 * of every request's cached prefix. Measured on a first turn (2026-09-07,
 * `claude-sonnet-5`): 11.4 KB of tool JSON, of which `subagent` +
 * `get_subagent_result` + `steer_subagent` were 4.8 KB — paid on every session
 * whether or not anyone delegates. `ask_user_question` is NOT opt-in: it is the
 * producer for a renderer surface that would otherwise never appear.
 */
export const PI_OPT_IN_EXTENSIONS_ENV = 'AICLIENT_PI_OPT_IN_EXTENSIONS';

/**
 * F08 — the environment variable every generated provider's `User-Agent`
 * header references.
 *
 * pi resolves `$NAME` in a provider's `headers` at request time, so the config
 * on disk carries the REFERENCE and this process supplies the value. That split
 * is not incidental: `configValidation.ts` refuses any header whose value is
 * not `$`-prefixed, precisely so a `models.json` can never come to hold a
 * literal secret or a value that outlives the build that wrote it. A version
 * number is neither, but it IS build-specific, and routing it through the
 * environment means an upgraded app corrects its own header without rewriting
 * config it may not even sync.
 */
export const PI_USER_AGENT_ENV = 'AICLIENT_PI_USER_AGENT';

/**
 * F08 — product half of the User-Agent, before the `/<version>` suffix.
 *
 * pi's default (`pi (win32 10.0.26100; x64)`) identifies the CLI and the host
 * OS, which is exactly what the gateway must NOT see here: requests from this
 * app are not requests from a pi CLI installation, and telling the two apart at
 * the gateway is the whole point of overriding it. The OS/arch detail is
 * dropped with it rather than reproduced — it is not ours to publish.
 */
export const PI_USER_AGENT_PRODUCT = 'claude-cli-pilab';

/** `claude-cli-pilab/0.4.0-test.7` — the value {@link PI_USER_AGENT_ENV} carries. */
export function piUserAgent(appVersion: string): string {
  const version = appVersion.trim();
  return version ? `${PI_USER_AGENT_PRODUCT}/${version}` : PI_USER_AGENT_PRODUCT;
}

/**
 * The header name written into every generated provider.
 *
 * Compared case-INSENSITIVELY against what a management config already carries
 * (see `toPiModelsJson`): HTTP header names are case-insensitive, so a config
 * spelling it `user-agent` states the same field, and treating the two as
 * different would write both and leave which one wins to the transport.
 */
export const PI_USER_AGENT_HEADER = 'User-Agent';

/**
 * Feature id of the bundled sub-agent extension, and the only member of the
 * opt-in list today.
 *
 * A feature id rather than the npm name on purpose: the package name lives in
 * `src/agent-host/bundledPlugins.mjs` and must stay there — Main decides whether
 * the feature is on, the Host decides which package that is.
 */
export const PI_SUBAGENTS_FEATURE_ID = 'subagents';

/** User setting behind {@link PI_SUBAGENTS_FEATURE_ID}. Absent = OFF. */
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

/** R04 — the three durable installation locations shown in Settings → Resources. */
export interface PiResourceSettings {
  managed: boolean;
  borrowUserPiResources: boolean;
  /** Whether the bundled sub-agent extension is injected. Default OFF. */
  enableSubagents: boolean;
  paths: {
    sharedSkills: string;
    userSkills: string;
    userPromptTemplates: string;
    managedSkills: string;
    managedPromptTemplates: string;
  };
}

/**
 * A partial update: each present field is applied, absent fields are left as
 * they are. Two independent switches share one settings surface, and a request
 * that had to carry both would make either toggle able to clobber the other
 * from a stale snapshot.
 */
export interface UpdatePiResourceSettingsRequest {
  borrowUserPiResources?: boolean;
  enableSubagents?: boolean;
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
