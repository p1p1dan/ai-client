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
 * T08-c (D-Q9 decision 4) — the managed route's "a cloned repo may not
 * configure this machine" marker. `'0'` on the managed route, `'1'` on the
 * local one, sent in BOTH modes so an ABSENT key can only mean an old Main
 * build.
 *
 * Two corrections worth carrying, because the name promises more than the
 * variable delivers:
 *
 *  - **The name is ours, not pi's.** The `pi` CLI has no such variable
 *    (verified against the bundled `dist/`: it resolves project trust from
 *    `--approve` / `--no-approve`, its own `trust.json`, the global
 *    `defaultProjectTrust` setting, or an interactive prompt). Exporting this
 *    key into a PTY therefore changes nothing about what the TUI loads — the
 *    embedded pi CLI decides that for itself. The one thing the value still
 *    does on that path is tell `PiTuiPty` it is on the managed route, which is
 *    when inherited credential variables are stripped out of the terminal.
 *  - **decision 009 took the native route off it.** It used to be the native
 *    worker's `projectTrusted` as well, and that is what made a managed
 *    session ignore the repository's MCP servers, skills, permission policy and
 *    instruction files. The native answer is now {@link NATIVE_PROJECT_TRUSTED}
 *    — a constant, because the managed route trusts a project for everything
 *    except its model settings, which the runtime never reads from a workspace.
 */
export const PI_PROJECT_TRUST_ENV = 'AICLIENT_PI_TRUST_PROJECT_CONFIG';

/**
 * decision 009 — whether a NATIVE worker may read the repository's own
 * configuration layers.
 *
 * Those layers are project MCP (`.pi/mcp.json`, `.pi/mcp.local.json`), project
 * skills and prompt templates, the project permission policy
 * (`.pi/agent/pi-permissions.jsonc` and `.local.jsonc`), and the project
 * instruction files (CLAUDE.md / AGENTS.md / CLAUDE.local.md).
 *
 * A constant rather than a second environment variable, because the answer no
 * longer varies by anything Main knows. The managed route trusts the project
 * too (user ruling, 2026-09-15), and the one project-scoped thing it still
 * refuses — model settings — is not something the native runtime has any code
 * path to read: its catalog arrives from Main's hand-over or from the agent
 * directory, never from the workspace. A variable that is always `'1'` would
 * read as a switch and invite the same question to be answered twice.
 *
 * Two things can still withdraw it, and neither is a credential mode: an
 * `unbound` scratch session ANDs it away in `piWorkerRpcServer`, and an
 * explicit `settingSources` list can close the project and local tiers
 * (decision 008).
 */
export const NATIVE_PROJECT_TRUSTED = true;

/**
 * Which OPT-IN bundled feature extensions this session may load, as a
 * comma-separated list of feature ids (see `bundledPlugins.mjs`).
 *
 * One value carries both the switch and the target: an ABSENT key means "load
 * none of them", so an older Main build that sends nothing lands on the
 * conservative side rather than on a second reading of the state.
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
  /** Whether the bundled sub-agent extension is injected. Default OFF. */
  enableSubagents: boolean;
  paths: {
    sharedSkills: string;
    /**
     * H/19 — the user's OWN `~/.pi/agent` subdirectories. Since both modes now
     * run out of the app's directory these are no longer loaded; they are the
     * SOURCE the migration copies from, and the settings page shows them as
     * such.
     */
    userSkills: string;
    userPromptTemplates: string;
    /** `<appAgentDir>/{skills,prompts}` — what every session actually loads. */
    appSkills: string;
    appPromptTemplates: string;
  };
  bundledFeatures: Array<{
    id: string;
    label: string;
    cost: string;
    defaultEnabled: boolean;
    enabled: boolean;
  }>;
}

/**
 * A partial update: each present field is applied, absent fields are left as
 * they are. Independent switches share one settings surface, and a request that
 * had to carry all of them would make any toggle able to clobber the others
 * from a stale snapshot.
 */
export interface UpdatePiResourceSettingsRequest {
  enableSubagents?: boolean;
  optInFeatures?: Record<string, boolean>;
}

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
