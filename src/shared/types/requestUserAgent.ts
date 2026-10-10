/**
 * dsh-rebase decision 171 (GitHub issue #7): the User-Agent of every request
 * this app makes to a model service, one global choice.
 *
 * DSH owns User-Agent: `dsh-llm-pi-ai`'s `requestHeaders()` drops any route
 * header of that name and sends `deepseek-harness/<version> (+url)` on every
 * provider request, whatever the profile says. Some providers admit only the
 * identity 1.0.x sent (F08, `claude-cli-pilab/<version>`). So the model plan
 * carries the wanted value in a private route header that DSH forwards like
 * any other ({@link USER_AGENT_RELAY_HEADER}), and the host's fetch wrapper
 * (`src/dsh-host/lib/userAgentRelay.ts`) moves it into User-Agent before the
 * request leaves. Main's own request to a provider (the model list, which is
 * also the connection test) sends the same value.
 *
 * No imports: the host bundle takes this file in (`HOST_INPUTS` in
 * `scripts/dsh-host-build-lib.mjs`), so it must not pull anything with it.
 */

/** Product half of the default User-Agent: 1.0.x's F08 value (commit 69576588). */
export const PI_USER_AGENT_PRODUCT = 'claude-cli-pilab';

/** `claude-cli-pilab/1.1.0`, or the product alone when there is no version. */
export function defaultRequestUserAgent(appVersion: string): string {
  const version = appVersion.trim();
  return version ? `${PI_USER_AGENT_PRODUCT}/${version}` : PI_USER_AGENT_PRODUCT;
}

/**
 * - `default`: {@link defaultRequestUserAgent} of the app version;
 * - `engine`: whatever DSH sends (`deepseek-harness/…`). Nothing is relayed,
 *   and Main's own requests keep Electron's default User-Agent: Main cannot
 *   know the string DSH builds;
 * - `custom`: the user's value.
 */
export const REQUEST_USER_AGENT_MODES = ['default', 'engine', 'custom'] as const;

export type RequestUserAgentMode = (typeof REQUEST_USER_AGENT_MODES)[number];

export const DEFAULT_REQUEST_USER_AGENT_MODE: RequestUserAgentMode = 'default';

/** Renderer settings-store keys; absent means the user never touched them. */
export const REQUEST_USER_AGENT_MODE_SETTING_KEY = 'requestUserAgentMode';
export const REQUEST_USER_AGENT_CUSTOM_SETTING_KEY = 'requestUserAgentCustom';

/** The longest value accepted, after trimming. */
export const REQUEST_USER_AGENT_MAX_LENGTH = 256;

/**
 * The private route header the plan carries the wanted value in. Reserved:
 * the plan drops one a provider states, and the host's wrapper removes it from
 * every request it sees, so it never reaches a provider.
 */
export const USER_AGENT_RELAY_HEADER = 'X-Aiclient-User-Agent';

export type RequestUserAgentProblem = 'not_text' | 'empty' | 'too_long' | 'invalid_character';

export type RequestUserAgentCheck =
  | { ok: true; value: string }
  | { ok: false; problem: RequestUserAgentProblem };

/** Visible ASCII and the space: no control character, no tab, nothing non-ASCII. */
const VISIBLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * The one check every reader applies: the settings page, the store's setter,
 * the model plan, Main's model list and the host's wrapper. Surrounding
 * whitespace is trimmed off; what is left must be 1 to
 * {@link REQUEST_USER_AGENT_MAX_LENGTH} characters of visible ASCII or spaces,
 * which also rules out a line break smuggling in a second header.
 */
export function checkRequestUserAgent(value: unknown): RequestUserAgentCheck {
  if (typeof value !== 'string') return { ok: false, problem: 'not_text' };
  const trimmed = value.trim();
  if (trimmed === '') return { ok: false, problem: 'empty' };
  if (trimmed.length > REQUEST_USER_AGENT_MAX_LENGTH) return { ok: false, problem: 'too_long' };
  if (!VISIBLE_ASCII.test(trimmed)) return { ok: false, problem: 'invalid_character' };
  return { ok: true, value: trimmed };
}

export function isRequestUserAgentMode(value: unknown): value is RequestUserAgentMode {
  return (
    typeof value === 'string' && (REQUEST_USER_AGENT_MODES as readonly string[]).includes(value)
  );
}

/** The stored choice as read out of the settings file: anything may be in there. */
export interface RequestUserAgentSetting {
  mode?: unknown;
  custom?: unknown;
}

export interface ResolvedRequestUserAgent {
  /** The mode the settings ask for: `default` when absent or unknown. */
  mode: RequestUserAgentMode;
  /** What to send; `undefined` leaves DSH's own (and Electron's default, in Main). */
  userAgent: string | undefined;
  /**
   * Why the stored choice was not used as it stands: a custom value that fails
   * the check (the default is sent instead), or a default the app version made
   * unusable (DSH's own is sent).
   */
  problem?: RequestUserAgentProblem;
}

/** The User-Agent a choice means, with the fallbacks applied. */
export function resolveRequestUserAgent(
  setting: RequestUserAgentSetting,
  appVersion: string
): ResolvedRequestUserAgent {
  const mode = isRequestUserAgentMode(setting.mode)
    ? setting.mode
    : DEFAULT_REQUEST_USER_AGENT_MODE;
  if (mode === 'engine') return { mode, userAgent: undefined };
  let problem: RequestUserAgentProblem | undefined;
  if (mode === 'custom') {
    // A custom mode with nothing typed yet reads as empty, not as "not text".
    const custom = checkRequestUserAgent(setting.custom ?? '');
    if (custom.ok) return { mode, userAgent: custom.value };
    problem = custom.problem;
  }
  const fallback = checkRequestUserAgent(defaultRequestUserAgent(appVersion));
  if (fallback.ok) return { mode, userAgent: fallback.value, ...(problem ? { problem } : {}) };
  return { mode, userAgent: undefined, problem: problem ?? fallback.problem };
}

/** The choice as Main's log states it, e.g. `user agent: default (claude-cli-pilab/1.1.0)`. */
export function describeRequestUserAgent(resolved: ResolvedRequestUserAgent): string {
  if (resolved.userAgent === undefined) {
    return resolved.problem
      ? `user agent: ${resolved.mode} unusable (${resolved.problem}), sending the engine default`
      : 'user agent: engine default';
  }
  if (resolved.problem) {
    return `user agent: custom value unusable (${resolved.problem}), sending the default (${resolved.userAgent})`;
  }
  return `user agent: ${resolved.mode} (${resolved.userAgent})`;
}
