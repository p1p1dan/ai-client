// New in dsh-rebase P1-5a
/**
 * Our request settings mapped onto DSH's route-level knobs (decision 040 rule
 * 3, design shard 03 §5). DSH has no per-agent knobs, so a delegate inherits
 * its parent's route and `subagentPromptCacheTtl` has nowhere to go.
 */

import {
  cacheRetentionForPromptCacheTtl,
  DEFAULT_PROMPT_CACHE_TTL,
  isPromptCacheTtl,
} from '../types/promptCacheTtl.ts';
import {
  DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
  isProviderIdleTimeoutMs,
  providerRequestTimeoutMs,
} from '../types/providerTimeout.ts';
import {
  NATIVE_RETRY_INITIAL_DELAY_MS,
  NATIVE_RETRY_MAX,
  NATIVE_RETRY_MAX_DELAY_MS,
} from './tables.ts';
import type { DshRouteSettings, DshRouteSettingsInput } from './types.ts';

export function dshRouteSettings(input: DshRouteSettingsInput = {}): DshRouteSettings {
  const ttl = isPromptCacheTtl(input.promptCacheTtl)
    ? input.promptCacheTtl
    : DEFAULT_PROMPT_CACHE_TTL;
  // `0` is the user's "never time out": test for presence, never truthiness.
  const idle =
    input.providerIdleTimeoutMs !== undefined &&
    isProviderIdleTimeoutMs(input.providerIdleTimeoutMs)
      ? input.providerIdleTimeoutMs
      : DEFAULT_PROVIDER_IDLE_TIMEOUT_MS;
  return {
    cacheRetention: cacheRetentionForPromptCacheTtl(ttl),
    // DSH requires a positive value; "off" becomes the timer ceiling (2^31 - 1),
    // which is also `MAX_TIMER_DELAY_MS` on the DSH side.
    streamIdleTimeoutMs: providerRequestTimeoutMs(idle),
    retryPolicy: {
      mode: 'normal',
      maxRetries: NATIVE_RETRY_MAX,
      backoff: {
        initialDelayMs: NATIVE_RETRY_INITIAL_DELAY_MS,
        maxDelayMs: NATIVE_RETRY_MAX_DELAY_MS,
      },
    },
  };
}
