/**
 * P5-2-5 — whether the native runtime offers delegation, and which definitions
 * this install has switched off.
 *
 * The `subagents` switch was built for the legacy `@gotgenes/pi-subagents`
 * plugin, which defaulted to off because it cost prompt tokens on a backend that
 * could not bound them. T025 stopped shipping that plugin, and cutover-10 made
 * this function the ONLY answer to "is delegation on" — Settings asks it too
 * (`piModelConfig/getPiResourceSettings`) rather than resolving the switch a
 * second way.
 *
 * That split is what the second reader used to get wrong: it answered "should
 * the plugin load", whose `false` is mostly "nobody has been asked", while the
 * P5-2 contract says an install that never expressed a preference gets the full
 * builtin catalog. So the page showed a switch reading "off" for sessions that
 * registered the delegation tools on every turn. Only a value the user actually
 * set — the override, or the older boolean it replaced — is a decision about
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
