/**
 * H/17 — AI services the user added themselves, as opposed to the ones the
 * company gateway issues.
 *
 * ## Why this is not `piModelConfig.ts`
 *
 * That module describes the MANAGED wire contract: what the onboarding service
 * is allowed to send us, validated as untrusted input. This one describes what
 * a person typed into a form on their own machine. The two have different
 * trust models and, as `USER_PROVIDER_APIS` below records, deliberately
 * different sets of accepted API styles.
 */

// Deep import, not the `dshModelPlan` barrel (`dshModelPlan/index.ts`): the
// barrel re-exports `build.ts`, which pulls in `node:crypto`. This module is
// loaded by the renderer (no Node integration there), so only the leaf file
// that actually holds the table is imported.
import { DSH_OFFERED_COMPAT, DSH_PROTOCOLS, IMPLIED_EFFORT_LEVELS } from './dshModelPlan/tables';
import { stripRedundantVersion } from './modelBaseUrl';
import { SESSION_EFFORT_LEVELS, type SessionEffortLevel } from './types/agentHost';

/**
 * Every request shape pi-ai can actually stream, taken from the adapters it
 * ships (`@earendil-works/pi-ai/dist/api/*`).
 *
 * Deliberately NOT `PI_MODEL_APIS`. That list has four entries because it
 * validates the managed catalog and the company gateway only ever sends those
 * four — it is a statement about the SERVER, not about what this client can
 * talk to. Reusing it here would silently refuse six styles pi-ai implements,
 * for a reason that has nothing to do with the user's own service.
 */
export const USER_PROVIDER_APIS = [
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'google-vertex',
  'bedrock-converse-stream',
  'mistral-conversations',
  'pi-messages',
] as const;
export type UserProviderApi = (typeof USER_PROVIDER_APIS)[number];

export function isUserProviderApi(value: unknown): value is UserProviderApi {
  return typeof value === 'string' && (USER_PROVIDER_APIS as readonly string[]).includes(value);
}

/**
 * dsh-rebase P1-5d (decision 036 rule 2, decision 148): the subset of
 * {@link USER_PROVIDER_APIS} the current chat engine — DSH's hand-declared
 * `llm-pi-ai` route — can actually drive. Equal to `DSH_PROTOCOLS`
 * (`dshModelPlan/tables.ts`), the same table `dshModelPlan/build.ts` checks
 * when deciding which catalog models survive translation. Settings and the
 * model menu's "N models unavailable" footer read the SAME table rather than
 * each keeping their own copy of "three", so a future DSH upgrade that adds or
 * drops a protocol only has one place to update.
 *
 * {@link USER_PROVIDER_APIS} itself is not narrowed: the stored value and the
 * wire format must keep taking all ten, both because a service saved before
 * this restriction (or on a build of the app that still talks pi-ai directly)
 * must round-trip unharmed, and because `AgentDirMigrationService` validates
 * an imported `models.json` against the full ten, independent of which engine
 * the importing build happens to run.
 */
export const SUPPORTED_USER_PROVIDER_APIS: readonly UserProviderApi[] = DSH_PROTOCOLS;

export function isSupportedUserProviderApi(api: UserProviderApi): boolean {
  return (SUPPORTED_USER_PROVIDER_APIS as readonly string[]).includes(api);
}

/**
 * Services common enough to be worth pre-filling, adapted from PI-Desktop's
 * `packages/shared/src/provider-presets.ts`.
 *
 * Only the entries whose API style {@link USER_PROVIDER_APIS} covers are here:
 * a preset that cannot be saved is worse than an absent one, because the user
 * finds out after typing their key. PI-Desktop's `opencode_go` entries are the
 * ones this excludes — that style is its own, not something pi-ai implements.
 *
 * `custom` is not in this list; it is the absence of a preset.
 */
export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  api: UserProviderApi;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-responses' },
  {
    // No `/v1`, and that is not an oversight: the Anthropic SDK appends
    // `/v1/messages` itself, so a base that already carries the segment
    // produces `/v1/v1/messages`. pi-ai's own provider table and PI-Desktop's
    // preset list both state the version-less form. The symptom of getting
    // this wrong is an HTTP 503 that reads like the vendor is down (ARD D15).
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    api: 'anthropic-messages',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    api: 'google-generative-ai',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    api: 'openai-completions',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
  },
  {
    id: 'moonshotai-cn',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    api: 'openai-completions',
  },
  {
    id: 'zhipuai',
    label: 'Zhipu AI (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    api: 'openai-completions',
  },
  {
    id: 'alibaba-cn',
    label: 'Alibaba (Qwen)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api: 'openai-completions',
  },
  {
    id: 'volcengine',
    label: 'Volcengine (Doubao)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    api: 'openai-completions',
  },
  {
    id: 'siliconflow-cn',
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    api: 'openai-completions',
  },
  {
    id: 'minimax-cn',
    label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    api: 'openai-completions',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    api: 'openai-completions',
  },
  { id: 'xai', label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', api: 'openai-completions' },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    api: 'mistral-conversations',
  },
  {
    id: 'togetherai',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    api: 'openai-completions',
  },
  {
    id: 'fireworks-ai',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    api: 'openai-completions',
  },
] as const;

/**
 * A reasoning level a user can offer for one of their models (decision 168):
 * every session level except `off`. Declaring `off` would turn thinking off
 * explicitly on every request that names no level (commit messages, code
 * review, a chat on "Default" without Medium), which many backends refuse.
 */
export type UserModelEffort = Exclude<SessionEffortLevel, 'off'>;

/** The levels of {@link UserModelEffort}, in escalation order. */
export const USER_MODEL_EFFORTS: readonly UserModelEffort[] = SESSION_EFFORT_LEVELS.filter(
  (level): level is UserModelEffort => level !== 'off'
);

/**
 * Decision 168: a vendor's openai-completions dialect, for a model reached
 * through a proxy that pi-ai's own detection (by service name and address)
 * cannot recognise. Stored under this id; `toPiUserModel` writes the vendor's
 * whole compat group instead (see {@link compatForPreset}).
 */
export const USER_COMPAT_PRESETS = [
  'openai',
  'deepseek',
  'qwen',
  'qwen-chat-template',
  'zai',
  'openrouter',
] as const;
export type UserCompatPreset = (typeof USER_COMPAT_PRESETS)[number];

export function isUserCompatPreset(value: unknown): value is UserCompatPreset {
  return typeof value === 'string' && (USER_COMPAT_PRESETS as readonly string[]).includes(value);
}

/**
 * Per-model metadata a user can set for a model they picked.
 *
 * Mirrors the subset of {@link PiManagedModelDefinition} the add/edit form
 * exposes: the fields a personal service cannot be inferred from a bare
 * model id. Everything here is optional so a model with no metadata typed in
 * behaves exactly like before — pi falls back to its own defaults.
 */
export interface UserModelMeta {
  /** Decision 168: the label of the model menu; the id when unset. */
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
  /**
   * Decision 165: the model only accepts adaptive thinking (Claude Opus /
   * Sonnet 4.6 and later). Only meaningful for `anthropic-messages`; implies
   * `reasoning`. Written to models.json as `compat.forceAdaptiveThinking` with
   * `thinkingLevelMap.off: null`, never under this name.
   */
  adaptiveThinking?: boolean;
  /**
   * Decision 168: the levels the chat's effort menu offers for this model.
   * Absent means the implied Low / Medium / High. Written to models.json as a
   * `thinkingLevelMap` naming all seven levels, never under this name.
   */
  efforts?: UserModelEffort[];
  /**
   * Decision 168: the vendor dialect of an `openai-completions` reasoning
   * model. Absent means pi-ai's own detection. Written to models.json as the
   * vendor's compat group, never under this name.
   */
  compatPreset?: UserCompatPreset;
}

/** One user-added service as the renderer sees it — never carries the key. */
export interface UserProviderView {
  id: string;
  name: string;
  baseUrl: string;
  api: UserProviderApi;
  /** Whether a key is stored. The key itself never crosses the IPC boundary. */
  hasApiKey: boolean;
  models: string[];
  /** Per-model metadata, keyed by model id. Absent entry = no metadata. */
  modelMeta?: Record<string, UserModelMeta>;
  enabled: boolean;
  createdAt: string;
}

export interface UserProviderDraft {
  /** Absent when creating. */
  id?: string;
  name: string;
  baseUrl: string;
  api: UserProviderApi;
  /**
   * Absent on edit means "keep the stored key". An explicit empty string is
   * still rejected — a service with no key cannot answer, and silently saving
   * one would produce a provider that fails only at request time.
   */
  apiKey?: string;
  models?: string[];
  /** Per-model metadata, keyed by model id. Absent means "no metadata". */
  modelMeta?: Record<string, UserModelMeta>;
  enabled?: boolean;
}

/** Why the group could not be read. Mirrors the vault's own read outcomes. */
export type UserProviderUnavailableReason = 'locked' | 'unsupported' | 'invalid';

export interface UserProviderState {
  providers: UserProviderView[];
  /**
   * Whether the stored keys are actually encrypted at rest.
   *
   * `false` means the OS keyring was unavailable and the vault fell back to
   * plaintext. Surfaced rather than hidden: the user is entitled to know their
   * key is sitting in a readable file (H/17 constraint 3).
   */
  encrypted: boolean;
  /** Present when the group could not be read at all; `providers` is then empty. */
  unavailable?: UserProviderUnavailableReason;
}

export interface FetchProviderModelsRequest {
  baseUrl: string;
  api: UserProviderApi;
  /** Absent means "use the stored key for `id`" — used when editing without retyping it. */
  apiKey?: string;
  id?: string;
}

export type FetchProviderModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string };

const OPERATION_SUFFIXES = [
  '/chat/completions',
  '/messages',
  '/responses',
  '/models',
  '/completions',
];

/**
 * Reduce a pasted URL to the service root.
 *
 * People copy the endpoint out of a vendor's curl example, which points at an
 * operation rather than at the base. Storing that verbatim produces requests to
 * `…/chat/completions/chat/completions`, and the resulting 404 reads as a bad
 * key. Mirrors PI-Desktop's `normalizeBaseUrlInput`.
 */
export function normalizeProviderBaseUrl(value: string, api?: string): string {
  let trimmed = value.trim().replace(/\/+$/, '');
  for (const suffix of OPERATION_SUFFIXES) {
    if (trimmed.toLowerCase().endsWith(suffix)) {
      trimmed = trimmed.slice(0, -suffix.length).replace(/\/+$/, '');
      break;
    }
  }
  // P5-5 / ARD D15. Stripping `/messages` off a pasted Anthropic curl example
  // leaves `…/v1`, and the SDK then asks for `/v1/v1/messages` — the same class
  // of mistake this function exists to absorb, one step further along. Only
  // applied when the caller knows the protocol; the api-less form is unchanged.
  return api ? stripRedundantVersion(trimmed, api) : trimmed;
}

export type BaseUrlIssue = 'empty' | 'invalid' | 'insecure';

/**
 * `null` when usable. Credentials-in-URL, query strings and fragments are
 * rejected rather than stripped: silently editing what someone pasted hides
 * the fact that they pasted a secret into a field that gets logged.
 */
export function checkProviderBaseUrl(value: string): BaseUrlIssue | null {
  const trimmed = value.trim();
  if (!trimmed) return 'empty';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'invalid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'insecure';
  if (!parsed.hostname) return 'invalid';
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return 'invalid';
  return null;
}

/** How a model-list request presents the key; the caller adds the key itself. */
export type ProviderModelListAuth = 'anthropic' | 'bearer' | 'google';

/** One request {@link providerModelListAttempts} plans. */
export interface ProviderModelListAttempt {
  url: string;
  /** The path relative to the base, for the "tried …" note of a failed fetch. */
  path: string;
  auth: ProviderModelListAuth;
  /** Only made when the attempt right before it was refused (401 / 403). */
  onlyAfterRefusal?: boolean;
}

/** Anthropic's own maximum page size for `GET /v1/models` (its default is 20). */
const ANTHROPIC_MODEL_PAGE_LIMIT = 1000;

function modelListAuth(api: UserProviderApi): ProviderModelListAuth {
  if (api === 'anthropic-messages' || api === 'pi-messages') return 'anthropic';
  if (api === 'google-generative-ai') return 'google';
  return 'bearer';
}

/**
 * Where a service lists its models, in the order to ask (decision 165).
 *
 * Every style but one asks `{base}/models` once: the version segment of an
 * OpenAI-style base is part of the URL its vendor documents (PI-Desktop's
 * `endpointPathSuffixes` says the same for all its styles).
 *
 * `anthropic-messages` is the exception, because its base is stored WITHOUT
 * `/v1` (the SDK appends `/v1/messages`), so `{base}/models` is a path neither
 * Anthropic nor most compatible proxies serve. Its order:
 *  1. `{base}/v1/models?limit=1000` with Anthropic's headers — the official API;
 *  2. the same URL with a bearer token, only if (1) was refused — proxies
 *     (new-api / one-api style) that only check `Authorization` there;
 *  3. `{base}/models` with Anthropic's headers, after any other failure of the
 *     `/v1` attempts — what this client asked before, kept so a service that
 *     answered it keeps working.
 *
 * Takes a stored or a pasted base: it is normalized here the same way the
 * service stores it, which is a no-op for an already stored one.
 */
export function providerModelListAttempts(
  baseUrl: string,
  api: UserProviderApi
): ProviderModelListAttempt[] {
  const base = normalizeProviderBaseUrl(baseUrl, api);
  if (api === 'anthropic-messages') {
    const v1 = `${base}/v1/models?limit=${ANTHROPIC_MODEL_PAGE_LIMIT}`;
    return [
      { url: v1, path: '/v1/models', auth: 'anthropic' },
      { url: v1, path: '/v1/models', auth: 'bearer', onlyAfterRefusal: true },
      { url: `${base}/models`, path: '/models', auth: 'anthropic' },
    ];
  }
  return [{ url: `${base}/models`, path: '/models', auth: modelListAuth(api) }];
}

/**
 * Decision 165 (user ruling 2026-10-09): whether a model id names a Claude
 * model that only accepts adaptive thinking, so the add/edit form can tick
 * that switch for the user. A suggestion for the form only — the model plan
 * never guesses from ids (decision 141).
 *
 * Matches what pi-ai's bundled catalog marks `forceAdaptiveThinking`: Opus /
 * Sonnet 4.6 and later, every 5.x (Fable included) and Mythos; never Haiku,
 * never Opus / Sonnet 4.5 or earlier. Vendor and region prefixes
 * (`anthropic/`, `us.anthropic.`) and both version spellings (`4-6`, `4.6`)
 * are accepted, as are suffixes (`-20260101`, `-v1`, `:batch`, `[1m]`).
 */
const ADAPTIVE_ONLY_CLAUDE =
  /^(?:[a-z0-9-]+\.)*claude-(?:(?:opus|sonnet)-4[-.][6-9]|(?:opus|sonnet|fable|mythos)-[5-9])(?![0-9])/;

export function suggestsAdaptiveThinking(modelId: string): boolean {
  const tail = modelId.trim().toLowerCase().split('/').pop() ?? '';
  return ADAPTIVE_ONLY_CLAUDE.test(tail);
}

/** Whether any field of a model's metadata is set. */
export function hasModelMeta(meta: UserModelMeta | undefined): boolean {
  return meta !== undefined && Object.values(meta).some((value) => value !== undefined);
}

/** Levels an adaptive-only Claude model takes as `output_config.effort` (no `minimal`). */
const ADAPTIVE_EFFORTS: readonly UserModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Budget thinking: pi-ai clamps `xhigh` / `max` to `high`, so offering them repeats High. */
const BUDGET_EFFORTS: readonly UserModelEffort[] = ['minimal', 'low', 'medium', 'high'];

/**
 * Decision 168: the levels a model can offer under its API style.
 *
 * - `anthropic-messages` with adaptive thinking: Low to Max (the API has no
 *   `minimal` effort);
 * - `anthropic-messages` without it (budget thinking): Minimal to High;
 * - every other style: all six.
 */
export function availableModelEfforts(
  api: string,
  adaptiveThinking: boolean
): readonly UserModelEffort[] {
  if (api !== 'anthropic-messages') return USER_MODEL_EFFORTS;
  return adaptiveThinking ? ADAPTIVE_EFFORTS : BUDGET_EFFORTS;
}

/**
 * Decision 168: a model's offered levels as the API style can use them.
 *
 * Unknown values and `off` are dropped, duplicates collapse, the order is the
 * escalation order, and levels {@link availableModelEfforts} rules out go.
 * `undefined` when nothing is left, or when what is left is the implied Low /
 * Medium / High — both mean "no `efforts`". The form, the save payload and
 * Main's models.json writer all call this, so a stored list never reaches
 * the file in a shape the panel could not show.
 */
export function normalizeModelEfforts(
  efforts: unknown,
  api: string,
  adaptiveThinking: boolean
): UserModelEffort[] | undefined {
  if (!Array.isArray(efforts)) return undefined;
  const available = availableModelEfforts(api, adaptiveThinking);
  const kept = available.filter((level) => efforts.includes(level));
  if (kept.length === 0) return undefined;
  const implied =
    kept.length === IMPLIED_EFFORT_LEVELS.size &&
    kept.every((level) => IMPLIED_EFFORT_LEVELS.has(level));
  return implied ? undefined : kept;
}

/**
 * Whether a vendor dialect sends a reasoning level at all. `qwen-chat-template`
 * only switches thinking on or off (`chat_template_kwargs.enable_thinking`),
 * so every level would be the same request.
 */
export function compatPresetSendsEfforts(preset: UserCompatPreset | undefined): boolean {
  return preset !== 'qwen-chat-template';
}

/**
 * The compat group of each vendor dialect: the six openai-completions
 * switches that set a vendor apart in pi-ai 0.85.1, at the values its own
 * detection and catalog give that vendor's native endpoint
 * (`openai-completions.js` `detectCompat`, `providers/data/*.json`). Written
 * whole, so the result no longer depends on the service's name or address.
 */
const COMPAT_PRESET_GROUPS: Readonly<
  Record<UserCompatPreset, Readonly<Record<string, string | boolean>>>
> = {
  // pi-ai's own answer for an endpoint it does not recognise.
  openai: {
    thinkingFormat: 'openai',
    supportsDeveloperRole: true,
    supportsStore: true,
    supportsReasoningEffort: true,
    maxTokensField: 'max_completion_tokens',
    requiresReasoningContentOnAssistantMessages: false,
  },
  // deepseek.json rows plus detectCompat's `isDeepSeek` branch.
  deepseek: {
    thinkingFormat: 'deepseek',
    supportsDeveloperRole: false,
    supportsStore: false,
    supportsReasoningEffort: true,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true,
  },
  // qwen-token-plan*.json (DashScope): levels for the models that take them.
  qwen: {
    thinkingFormat: 'qwen',
    supportsDeveloperRole: false,
    supportsStore: false,
    supportsReasoningEffort: true,
    maxTokensField: 'max_completion_tokens',
    requiresReasoningContentOnAssistantMessages: false,
  },
  // Self-hosted Qwen (vLLM / SGLang chat template): no catalog row; the
  // conservative choices of every non-OpenAI row.
  'qwen-chat-template': {
    thinkingFormat: 'qwen-chat-template',
    supportsDeveloperRole: false,
    supportsStore: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: false,
  },
  // zai.json GLM-5.2 / 5.3 rows (`zaiToolStream` is not offered by DSH).
  zai: {
    thinkingFormat: 'zai',
    supportsDeveloperRole: false,
    supportsStore: false,
    supportsReasoningEffort: true,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: false,
  },
  // openrouter.json's common row plus detectCompat's `isOpenRouter` branch.
  openrouter: {
    thinkingFormat: 'openrouter',
    supportsDeveloperRole: false,
    supportsStore: true,
    supportsReasoningEffort: true,
    maxTokensField: 'max_completion_tokens',
    requiresReasoningContentOnAssistantMessages: false,
  },
};

/**
 * Decision 168: the compat block a vendor dialect writes, limited to the keys
 * DSH offers on `openai-completions` (`DSH_OFFERED_COMPAT`), so the model plan
 * passes all of it and none is reported as `compat_not_offered`.
 */
export function compatForPreset(preset: UserCompatPreset): Record<string, string | boolean> {
  const offered = DSH_OFFERED_COMPAT['openai-completions'];
  return Object.fromEntries(
    Object.entries(COMPAT_PRESET_GROUPS[preset]).filter(([key]) => offered.includes(key))
  );
}

/**
 * Apply one edit of the form to a model's metadata (decisions 165, 168).
 *
 * The two thinking switches are tied: adaptive thinking is a kind of
 * reasoning, so turning it on turns reasoning on, and turning reasoning off
 * turns adaptive thinking off with it. A field patched to `undefined` is
 * cleared. With `api`, an edit of the offered levels, or one that flips
 * adaptive thinking, leaves `efforts` normalized for that style.
 */
export function applyModelMetaPatch(
  meta: UserModelMeta | undefined,
  patch: Partial<UserModelMeta>,
  api?: UserProviderApi
): UserModelMeta {
  const next: UserModelMeta = { ...meta, ...patch };
  if (patch.adaptiveThinking === true) next.reasoning = true;
  if ('reasoning' in patch && next.reasoning !== true) next.adaptiveThinking = undefined;
  const adaptive = next.adaptiveThinking === true;
  const adaptiveFlipped = (meta?.adaptiveThinking === true) !== adaptive;
  if (api !== undefined && next.efforts !== undefined && ('efforts' in patch || adaptiveFlipped)) {
    next.efforts = normalizeModelEfforts(
      next.efforts,
      api,
      api === 'anthropic-messages' && adaptive
    );
  }
  return next;
}

/**
 * A model's metadata without the fields its service's API style cannot use,
 * and without fields that are not set. `adaptiveThinking` only exists for
 * `anthropic-messages`, `compatPreset` only for `openai-completions`; both
 * that and `efforts` only while reasoning is on, and `efforts` normalized
 * ({@link normalizeModelEfforts}). The name is trimmed; an empty one is unset.
 */
export function modelMetaForApi(meta: UserModelMeta, api: UserProviderApi): UserModelMeta {
  const out: UserModelMeta = {};
  const name = meta.name?.trim();
  if (name) out.name = name;
  if (meta.contextWindow !== undefined) out.contextWindow = meta.contextWindow;
  if (meta.maxTokens !== undefined) out.maxTokens = meta.maxTokens;
  if (meta.reasoning !== undefined) out.reasoning = meta.reasoning;
  if (meta.input !== undefined) out.input = meta.input;
  const anthropic = api === 'anthropic-messages';
  if (anthropic && meta.adaptiveThinking !== undefined) {
    out.adaptiveThinking = meta.adaptiveThinking;
  }
  const adaptive = anthropic && meta.adaptiveThinking === true;
  if (meta.reasoning === true || adaptive) {
    const preset = api === 'openai-completions' ? meta.compatPreset : undefined;
    if (preset !== undefined) out.compatPreset = preset;
    const efforts = compatPresetSendsEfforts(preset)
      ? normalizeModelEfforts(meta.efforts, api, adaptive)
      : undefined;
    if (efforts) out.efforts = efforts;
  }
  return out;
}

/**
 * Decision 165 (user ruling 2026-10-09), extended by decision 168 (user
 * ruling 2026-10-09): the metadata to fill in when the user selects
 * `modelId`, or `undefined` for none.
 *
 * Only for `anthropic-messages`, only for an id {@link suggestsAdaptiveThinking}
 * recognises, and only while the model has no metadata yet — anything already
 * typed or stored is the user's, and is never overwritten. Every adaptive
 * Claude in pi-ai's catalog declares Max; X-High only some, so it is left out.
 */
export function prefillModelMeta(
  modelId: string,
  api: UserProviderApi,
  existing: UserModelMeta | undefined
): UserModelMeta | undefined {
  if (api !== 'anthropic-messages' || hasModelMeta(existing)) return undefined;
  if (!suggestsAdaptiveThinking(modelId)) return undefined;
  return { reasoning: true, adaptiveThinking: true, efforts: ['low', 'medium', 'high', 'max'] };
}

/**
 * Whether a model's settings differ from its defaults — the prefill a fresh
 * selection would get, or nothing (decision 168). Compared as the save would
 * send them, so a hidden field or a whitespace name is not a customization.
 */
export function isModelMetaCustomized(
  modelId: string,
  api: UserProviderApi,
  meta: UserModelMeta | undefined
): boolean {
  const defaults = prefillModelMeta(modelId, api, undefined) ?? {};
  return (
    canonicalMeta(modelMetaForApi(meta ?? {}, api)) !==
    canonicalMeta(modelMetaForApi(defaults, api))
  );
}

function canonicalMeta(meta: UserModelMeta): string {
  const entries = Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

/**
 * Decision 168: what a token-count field's text means. Empty is "unset";
 * anything but a positive whole number written in digits is invalid — a
 * `type="number"` field cannot tell "32k" from empty, which is why the form
 * reads text. Grouping (`128,000`, `128 000`, `128_000`) is accepted.
 */
export function parseModelTokenCount(raw: string): { value?: number; invalid: boolean } {
  const compact = raw.trim().replace(/[\s,_]/g, '');
  if (!compact) return { invalid: false };
  if (!/^\d+$/.test(compact)) return { invalid: true };
  const value = Number(compact);
  return Number.isSafeInteger(value) && value > 0 ? { value, invalid: false } : { invalid: true };
}

/**
 * The `modelMeta` of the draft the form saves, or `undefined` to leave it out.
 *
 * Only selected models, only set fields, only fields the API style takes.
 * Leaving it out means "keep what is stored" to the service, so when the
 * service already has metadata (`stored`, the edited row's) the map is always
 * sent, empty if everything was cleared — otherwise unticking the last switch
 * of a model would never reach the vault (decision 165).
 */
export function modelMetaDraft(input: {
  selected: readonly string[];
  meta: Readonly<Record<string, UserModelMeta>>;
  api: UserProviderApi;
  stored?: Readonly<Record<string, UserModelMeta>>;
}): Record<string, UserModelMeta> | undefined {
  const out: Record<string, UserModelMeta> = {};
  for (const id of input.selected) {
    const entry = input.meta[id];
    if (!entry) continue;
    const kept = modelMetaForApi(entry, input.api);
    if (hasModelMeta(kept)) out[id] = kept;
  }
  if (Object.keys(out).length > 0) return out;
  return input.stored && Object.keys(input.stored).length > 0 ? out : undefined;
}
