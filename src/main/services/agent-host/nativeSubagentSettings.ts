/**
 * P5-2-5 — whether the native runtime offers delegation, and which definitions
 * this install has switched off.
 *
 * The legacy `@gotgenes/pi-subagents` plugin is an OPT-IN feature that defaults
 * to off, because it costs prompt tokens on a backend that cannot bound them.
 * Native delegation is a different thing on a different backend, and the P5-2
 * contract sets a different default: an install that has never expressed a
 * preference gets the full builtin catalog.
 *
 * So this is deliberately NOT `resolveOptInFeatures(...).includes('subagents')`.
 * That call answers "should the legacy plugin load", whose `false` is mostly
 * "nobody has been asked". Only a value the user actually set — the opt-in
 * override, or the older boolean it replaced — is read as a decision about
 * native delegation, and only `false` turns it off.
 */

import {
  PI_ENABLE_SUBAGENTS_SETTING_KEY,
  PI_OPT_IN_FEATURE_SETTINGS_KEY,
} from '@shared/piModelConfig';
import { readSharedSettings } from '../SharedSessionState';

/** Definition names this install switched off, kept out of the Markdown. */
export const NATIVE_SUBAGENTS_DISABLED_KEY = 'nativeSubagentsDisabled';

const SUBAGENTS_FEATURE_ID = 'subagents';

export interface NativeSubagentSettings {
  enabled: boolean;
  disabled?: readonly string[];
}

export function nativeSubagentSettings(
  settings: Record<string, unknown> = readSharedSettings()
): NativeSubagentSettings {
  const overrides = settings[PI_OPT_IN_FEATURE_SETTINGS_KEY];
  const override =
    overrides && typeof overrides === 'object' && !Array.isArray(overrides)
      ? (overrides as Record<string, unknown>)[SUBAGENTS_FEATURE_ID]
      : undefined;
  const legacy = settings[PI_ENABLE_SUBAGENTS_SETTING_KEY];
  const chosen = typeof override === 'boolean' ? override : legacy;
  const raw = settings[NATIVE_SUBAGENTS_DISABLED_KEY];
  const disabled = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    // Absent means nobody chose; only an explicit `false` is a refusal.
    enabled: typeof chosen === 'boolean' ? chosen : true,
    ...(disabled.length ? { disabled } : {}),
  };
}
