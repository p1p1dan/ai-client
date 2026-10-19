// New in dsh-rebase P1-5a
/**
 * Static copies of what `@deepseek-ai/dsh-llm-pi-ai` 0.2.0-rc.2 accepts on a
 * hand-declared route. Copied, not imported: this module is loaded where DSH
 * is not installed (Main, root Vitest). A DSH upgrade that changes either
 * table is caught by the drift gate in the dsh-host package, which loads a
 * plan into a real host and requires empty route diagnostics.
 */

import { SESSION_EFFORT_LEVELS } from '../types/agentHost.ts';
import type { DefaultMaxTokensMode, DshEffortLevel, DshProtocol } from './types.ts';

/** `PROTOCOLS` / `supportedProtocols()` (`dsh-llm-pi-ai` lib/index.js:802-817). */
export const DSH_PROTOCOLS: readonly DshProtocol[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
];

/**
 * The compat keys each protocol offers (`COMPAT_GATES`, lib/index.js:379-451).
 * Withheld keys are left out: setting one rejects the whole profile.
 */
export const DSH_OFFERED_COMPAT: Readonly<Record<DshProtocol, readonly string[]>> = {
  'openai-completions': [
    'supportsStore',
    'supportsDeveloperRole',
    'supportsReasoningEffort',
    'supportsUsageInStreaming',
    'supportsFinishReason',
    'maxTokensField',
    'requiresToolResultName',
    'requiresAssistantAfterToolResult',
    'requiresThinkingAsText',
    'requiresReasoningContentOnAssistantMessages',
    'thinkingFormat',
    'chatTemplateKwargs',
    'chatTemplateArgs',
    'supportsThinkingTokenBudget',
    'thinkingTokenBudgetField',
    'vllmPriority',
    'supportsStrictMode',
    'cacheControlFormat',
    'supportsLongCacheRetention',
  ],
  'openai-responses': [
    'supportsDeveloperRole',
    'supportsMaxOutputTokens',
    'supportsStrictMode',
    'supportsLongCacheRetention',
  ],
  'anthropic-messages': [
    'supportsEagerToolInputStreaming',
    'supportsLongCacheRetention',
    'supportsCacheControlOnTools',
    'supportsTemperature',
    'forceAdaptiveThinking',
    'allowEmptySignature',
    'supportsStrictTools',
  ],
};

/** `THINKING_LEVELS`, escalation order (lib/index.js:296-304); identical to ours. */
export const DSH_EFFORT_LEVELS: readonly DshEffortLevel[] = SESSION_EFFORT_LEVELS;

/**
 * Levels our catalog treats as supported when a reasoning model's map does not
 * mention them (pi-ai semantics, and the renderer's assumed three). DSH treats
 * an unmentioned level as unsupported, so these are written out by name.
 */
export const IMPLIED_EFFORT_LEVELS: ReadonlySet<DshEffortLevel> = new Set([
  'low',
  'medium',
  'high',
]);

/**
 * The native runtime's defaults for a model the catalog does not size
 * (`model-adapter/catalog.ts`). DSH's own are 262144 / 32768.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;

/**
 * Decision 146 (GW-4): a row's `maxTokens` above this share of its declared
 * `contextWindow` is taken for a catalog that copied the window into it
 * (DSH's compaction then has no message budget), and planned as
 * {@link MAX_TOKENS_WINDOW_SHARE_FALLBACK} of the window instead. Real output
 * caps stay at or under half: pi-ai's catalog tops out there (o3 100k of 200k,
 * GPT-5.4 128k of 272k) apart from rows that equal the window.
 */
export const MAX_TOKENS_WINDOW_SHARE_LIMIT = 0.5;
/** DSH's own reference route reserves 256k of a 1M window (`dsh-llm-deepseek`). */
export const MAX_TOKENS_WINDOW_SHARE_FALLBACK = 0.25;

/**
 * Decision 146: the `maxTokens` the plan hands DSH for a row. Only a row that
 * declares both numbers is judged; over half its window is planned as a
 * quarter of it. The plan (`build.ts`) and the model settings panel share it,
 * so the panel works from what the plan will send (decision 177).
 */
export function plannedMaxTokens(
  contextWindow: number | undefined,
  maxTokens: number | undefined
): number | undefined {
  if (maxTokens === undefined || contextWindow === undefined) return maxTokens;
  if (maxTokens <= Math.floor(contextWindow * MAX_TOKENS_WINDOW_SHARE_LIMIT)) return maxTokens;
  return Math.max(1, Math.floor(contextWindow * MAX_TOKENS_WINDOW_SHARE_FALLBACK));
}

/**
 * Decision 190: the output limit a reasoning row that declares none is
 * planned with, by protocol. Thinking and the reply share the limit, so
 * {@link DEFAULT_MAX_TOKENS} cuts a long reply (a whole-file write) short.
 * Every current model of each protocol's own vendor accepts these: Anthropic
 * since Claude 3.7 (Opus 4 / 4.1 top out at exactly 32000), OpenAI's
 * Responses models since GPT-4.1 and the o-series. OpenAI-compatible services
 * vary the most, so they get the smaller raise.
 */
export const REASONING_DEFAULT_MAX_TOKENS: Readonly<Record<DshProtocol, number>> = {
  'anthropic-messages': 32_000,
  'openai-responses': 32_000,
  'openai-completions': 16_384,
};

/** Decision 190's switch, read by Main: `0` selects `flat` (`DefaultMaxTokensMode`). */
export const PROTOCOL_MAX_TOKENS_ENV = 'AICLIENT_RUNTIME_PROTOCOL_MAX_TOKENS';

/** The mode a value of {@link PROTOCOL_MAX_TOKENS_ENV} selects; anything but `0` is `protocol`. */
export function resolveDefaultMaxTokensMode(value: unknown): DefaultMaxTokensMode {
  return value === '0' ? 'flat' : 'protocol';
}

/** The mode as Main's plan log states it, e.g. `default output limit: flat 8192`. */
export function describeDefaultMaxTokens(mode: DefaultMaxTokensMode): string {
  if (mode === 'flat') return `default output limit: flat ${DEFAULT_MAX_TOKENS}`;
  const raises = Object.entries(REASONING_DEFAULT_MAX_TOKENS)
    .map(([api, tokens]) => `${api} ${tokens}`)
    .join(', ');
  return `default output limit: reasoning rows by protocol (${raises}; at most a quarter of the window), ${DEFAULT_MAX_TOKENS} otherwise`;
}

/**
 * Decision 190: the output limit of a row that declares none. A reasoning row
 * gets its protocol's raise, but no more than a quarter of its window
 * (decision 146's share; the default window when it declares none) and never
 * less than {@link DEFAULT_MAX_TOKENS}; anything else gets
 * {@link DEFAULT_MAX_TOKENS}. The plan (`build.ts`) and the model settings
 * panel share it.
 */
export function defaultMaxTokensFor(input: {
  api: DshProtocol;
  reasoning: boolean;
  contextWindow?: number;
  mode?: DefaultMaxTokensMode;
}): number {
  if (input.mode === 'flat' || !input.reasoning) return DEFAULT_MAX_TOKENS;
  const window = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const share = Math.floor(window * MAX_TOKENS_WINDOW_SHARE_FALLBACK);
  return Math.max(DEFAULT_MAX_TOKENS, Math.min(REASONING_DEFAULT_MAX_TOKENS[input.api], share));
}

/** Retry budget of the native loop: 3 retries, 3 s rising to 30 s (`providerRetry.ts`). */
export const NATIVE_RETRY_MAX = 3;
export const NATIVE_RETRY_INITIAL_DELAY_MS = 3_000;
export const NATIVE_RETRY_MAX_DELAY_MS = 30_000;

/** Placeholder `agent-default-model` for a plan with no usable model (R9). */
export const EMPTY_PLAN_DEFAULT_MODEL = { provider: 'aiclient-none', model: 'none' } as const;

/** Prefix of every key reference name a route carries. */
export const KEY_REF_PREFIX = 'AICLIENT_KEY_';

/**
 * Decision 037's default: DSH owns User-Agent, so the client identifies itself
 * with its own header, carrying the app version, on every route.
 */
export const CLIENT_IDENTITY_HEADER = 'X-Pilab-Client';
