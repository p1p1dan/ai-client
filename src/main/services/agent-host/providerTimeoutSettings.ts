/**
 * The provider idle timeout, read off the settings page's own store (T093).
 *
 * A renderer-owned setting, so it lives one level down in the persist wrapper
 * and has to come through `readSettingsState` — the same unwrap
 * `defaultTemporaryPath` and the prompt-cache TTL need, and the same trap: read
 * off the settings FILE's top level it is `undefined` on every machine.
 *
 * A value the user never touched is reported as ABSENT rather than as the
 * default; the default is applied once, where the DSH model plan is built
 * (decision 040). Since dsh-rebase P1-12 step 1 the plan is its only reader:
 * chat bootstraps no longer carry it.
 *
 * `0` is a real value here — the user's "never time out" — so this must never
 * be written as a truthiness test anywhere downstream.
 */

import {
  isProviderIdleTimeoutMs,
  PROVIDER_IDLE_TIMEOUT_SETTING_KEY,
} from '@shared/types/providerTimeout';
import { readSettingsState } from '../../ipc/settings';

export interface ProviderTimeoutSettings {
  providerIdleTimeoutMs?: number;
}

export function providerTimeoutSettings(
  read: () => Record<string, unknown> = readSettingsState
): ProviderTimeoutSettings {
  const raw = read()[PROVIDER_IDLE_TIMEOUT_SETTING_KEY];
  // Numbers and numeric strings both, because the settings store is JSON and a
  // picker that writes `"120000"` must not silently fall back to the default.
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : raw;
  return isProviderIdleTimeoutMs(value) ? { providerIdleTimeoutMs: value } : {};
}
