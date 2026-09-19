/**
 * How long a provider request may stay silent before it is cut (decision 029).
 *
 * Two timeouts, one number. `headersTimeout` bounds "the request went out and
 * nothing came back at all"; `bodyTimeout` bounds "the stream opened and then
 * stopped producing bytes". pi's own CLI sets both from a single user-facing
 * value (`core/http-dispatcher.ts`) and passes the same number to the SDK as its
 * per-request `timeout`, and decision 029 adopts that shape: one knob the user
 * can reason about, three places it lands.
 *
 * Our default is 120 s where pi's is 300 s. The 2026-09-19 field report (batch I
 * #5) is the reason: with no timeout at all the SDK's 600 s wall clock applied,
 * so a gateway that accepted the connection and then went quiet held one message
 * for ten minutes per attempt with nothing on screen. 120 s keeps the worst case
 * (three retries plus the ladder) under nine minutes, all of it visible.
 *
 * The vocabulary here is MILLISECONDS end to end — the setting, the wire, the
 * dispatcher and the SDK all speak the same unit, so there is no translation
 * point to drift (contrast `promptCacheTtl.ts`, which has two vocabularies and
 * therefore one translation function).
 */

/** Renderer settings-store key. The settings page itself is T093's other half. */
export const PROVIDER_IDLE_TIMEOUT_SETTING_KEY = 'providerIdleTimeoutMs';

/** Decision 029: 120 s, half of pi's 300 s. See the module note for why. */
export const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 120_000;

/** The one value that means "never cut a silent request". */
export const PROVIDER_IDLE_TIMEOUT_DISABLED = 0;

/**
 * What "disabled" has to become before it reaches an SDK.
 *
 * Every SDK we talk through reads `timeout: 0` as "time out immediately", not
 * as "no timeout" — so passing the user's 0 straight through would fail every
 * request instantly. pi hit the same wall and settled on max int32; the same
 * number is used here so a trace from either program reads the same.
 */
export const PROVIDER_TIMEOUT_DISABLED_SENTINEL = 2_147_483_647;

/** The values a picker should offer, in order. `0` is the "off" rung. */
export const PROVIDER_IDLE_TIMEOUT_CHOICES = [
  30_000,
  60_000,
  120_000,
  300_000,
  PROVIDER_IDLE_TIMEOUT_DISABLED,
] as const satisfies readonly number[];

/** An upper bound on the stored value, so a typo cannot disable the timeout. */
const MAX_PROVIDER_IDLE_TIMEOUT_MS = 3_600_000;

export function isProviderIdleTimeoutMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_PROVIDER_IDLE_TIMEOUT_MS
  );
}

/**
 * Read a persisted or transported value, falling back when it is absent or
 * malformed.
 *
 * Strings are accepted because the renderer settings store keeps everything as
 * JSON and a picker that writes `"120000"` must not silently disable the
 * timeout. Anything that is not a whole, in-range count of milliseconds is
 * treated as ABSENT rather than passed through, for the reason
 * `readPromptCacheTtl` states: a setting that claims something the request does
 * not do is worse than no setting.
 */
export function readProviderIdleTimeoutMs(
  value: unknown,
  fallback: number = DEFAULT_PROVIDER_IDLE_TIMEOUT_MS
): number {
  if (isProviderIdleTimeoutMs(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (isProviderIdleTimeoutMs(parsed)) return parsed;
  }
  return fallback;
}

/**
 * The number an SDK's per-request `timeout` must be given for this setting.
 *
 * Never zero: see {@link PROVIDER_TIMEOUT_DISABLED_SENTINEL}.
 */
export function providerRequestTimeoutMs(idleTimeoutMs: number): number {
  return idleTimeoutMs === PROVIDER_IDLE_TIMEOUT_DISABLED
    ? PROVIDER_TIMEOUT_DISABLED_SENTINEL
    : idleTimeoutMs;
}
