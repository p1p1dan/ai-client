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

import { stripRedundantVersion } from './modelBaseUrl';

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
 * Per-model metadata a user can set for a model they picked.
 *
 * Mirrors the subset of {@link PiManagedModelDefinition} the add/edit form
 * exposes: the four fields a personal service cannot be inferred from a bare
 * model id. Everything here is optional so a model with no metadata typed in
 * behaves exactly like before — pi falls back to its own defaults.
 */
export interface UserModelMeta {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
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

/**
 * Where a service lists its models, relative to the stored base URL.
 *
 * One path for every style: PI-Desktop's own `endpointPathSuffixes` lists
 * `/models` for all seven of its styles, and the version segment (`/v1`) is
 * part of the base URL every vendor documents, not something to guess at here.
 */
export const PROVIDER_MODELS_PATH = '/models';
