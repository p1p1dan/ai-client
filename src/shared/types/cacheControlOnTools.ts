/**
 * GW-16 temporary switch (dsh-rebase decisions 146 rules 23-27, 149 rule 19,
 * 159): whether anthropic-messages requests put a `cache_control` breakpoint
 * on the last tool definition.
 *
 * pi-ai marks three places by default: the system block, the last tool and the
 * last user message. A company gateway refused some requests with
 * `cache_limit` (its rewrite of Anthropic's "A maximum of 4 blocks with
 * cache_control" error), so the default here drops the tools breakpoint and a
 * request carries at most two; switching it on restores three. A test switch:
 * once the gateway question is settled it is either removed or made permanent,
 * so everything it touches is listed in decision 159.
 */

/** Renderer settings-store key; absent means the user never touched it. */
export const CACHE_CONTROL_ON_TOOLS_SETTING_KEY = 'experimentalCacheControlOnTools';

/** Off: system + last user message, two breakpoints per request at most. */
export const DEFAULT_CACHE_CONTROL_ON_TOOLS = false;

/** The value a plan is built with: only a stored `true` turns the tools breakpoint on. */
export function resolveCacheControlOnTools(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_CACHE_CONTROL_ON_TOOLS;
}

/** The mode as Main's log states it, e.g. `cache_control on tools: off (2 breakpoints max)`. */
export function describeCacheControlOnTools(on: boolean): string {
  return `cache_control on tools: ${on ? 'on (3 breakpoints max)' : 'off (2 breakpoints max)'}`;
}
