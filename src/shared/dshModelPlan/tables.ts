// New in dsh-rebase P1-5a
/**
 * Static copies of what `@deepseek-ai/dsh-llm-pi-ai` 0.1.7-rc.2 accepts on a
 * hand-declared route. Copied, not imported: this module is loaded where DSH
 * is not installed (Main, root Vitest). A DSH upgrade that changes either
 * table is caught by the drift gate in the dsh-host package, which loads a
 * plan into a real host and requires empty route diagnostics.
 */

import { SESSION_EFFORT_LEVELS } from '../types/agentHost.ts';
import type { DshEffortLevel, DshProtocol } from './types.ts';

/** `PROTOCOLS` / `supportedProtocols()` (`dsh-llm-pi-ai` lib/index.js:798-812). */
export const DSH_PROTOCOLS: readonly DshProtocol[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
];

/**
 * The compat keys each protocol offers (`COMPAT_GATES`, lib/index.js:377-447).
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

/** `THINKING_LEVELS`, escalation order (lib/index.js:297-305); identical to ours. */
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
