/**
 * How long a provider is asked to keep this app's prompt cache entries alive.
 *
 * 1.0.x had two knobs, matching Claude Code's `promptCacheTtl` /
 * `subagentPromptCacheTtl`. The delegate one went with the self-owned runtime
 * (dsh-rebase decision 123 rule 14, P1-12): DSH delegates follow their
 * parent's route. The main conversation is long-lived and re-reads the same
 * prefix for as long as the user keeps the tab open, so it pays for the hour.
 *
 * The vocabulary here is the WIRE one (`"5m"` / `"1h"`) — what Anthropic's
 * `cache_control.ttl` says and what the setting shows the user. pi-ai's own
 * vocabulary is `"short"` / `"long"`; {@link cacheRetentionForPromptCacheTtl} is
 * the only place the two are allowed to meet, so a third spelling cannot appear.
 */

/** A user-visible cache lifetime. */
export type PromptCacheTtl = '5m' | '1h';

/** Every value the setting may take, in the order a picker should show them. */
export const PROMPT_CACHE_TTLS = ['5m', '1h'] as const satisfies readonly PromptCacheTtl[];

/**
 * pi-ai's retention vocabulary, spelled here so neither the worker nor the
 * runtime plugins have to import the SDK's type just to name a default.
 */
export type CacheRetentionName = 'short' | 'long';

/** Renderer settings-store key for the main conversation's TTL. */
export const PROMPT_CACHE_TTL_SETTING_KEY = 'promptCacheTtl';

/** The main conversation keeps its prefix for an hour unless told otherwise. */
export const DEFAULT_PROMPT_CACHE_TTL: PromptCacheTtl = '1h';

export function isPromptCacheTtl(value: unknown): value is PromptCacheTtl {
  return value === '5m' || value === '1h';
}

/**
 * Read a persisted setting, falling back when it is absent or malformed.
 *
 * A stored value that is not one of the two is treated as absent rather than
 * passed through: the SDK would silently resolve an unknown string to its own
 * default, and the user would see a setting that claims something the request
 * does not do.
 */
export function readPromptCacheTtl(value: unknown, fallback: PromptCacheTtl): PromptCacheTtl {
  return isPromptCacheTtl(value) ? value : fallback;
}

/** The single translation point between the wire TTL and pi-ai's retention. */
export function cacheRetentionForPromptCacheTtl(ttl: PromptCacheTtl): CacheRetentionName {
  return ttl === '1h' ? 'long' : 'short';
}
