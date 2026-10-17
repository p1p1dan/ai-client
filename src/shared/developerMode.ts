/**
 * Route B S-6 feedback 10 (claude-sdk-engine README ruling 26): developer mode.
 * Off by default. While it is off, the settings it holds are hidden on the
 * settings page and every reader sees them at their defaults; the stored
 * values are kept, so turning it back on restores them as they were.
 *
 * One gate for every reader (Main's three setting reads and the renderer's
 * engine prediction), so the settings page, the model plan and the engine
 * choice cannot disagree about what is in effect.
 */

import { CLAUDE_SDK_ENGINE_SETTING_KEY } from './claudeSdkEngine';
import { CACHE_CONTROL_ON_TOOLS_SETTING_KEY } from './types/cacheControlOnTools';
import {
  REQUEST_USER_AGENT_CUSTOM_SETTING_KEY,
  REQUEST_USER_AGENT_MODE_SETTING_KEY,
} from './types/requestUserAgent';

/** Renderer settings-store key; absent means the user never touched it. */
export const DEVELOPER_MODE_SETTING_KEY = 'developerModeEnabled';
export const DEFAULT_DEVELOPER_MODE_ENABLED = false;

/** Only a real boolean counts; anything else is the default. */
export function resolveDeveloperModeEnabled(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_DEVELOPER_MODE_ENABLED;
}

/** The settings-store keys that only take effect in developer mode. Web Inspector stays out (ruling 26). */
export const DEVELOPER_MODE_SETTING_KEYS: readonly string[] = [
  CACHE_CONTROL_ON_TOOLS_SETTING_KEY,
  CLAUDE_SDK_ENGINE_SETTING_KEY,
  REQUEST_USER_AGENT_MODE_SETTING_KEY,
  REQUEST_USER_AGENT_CUSTOM_SETTING_KEY,
];

/**
 * The settings state as readers must see it: with developer mode off, the
 * gated keys read as absent, so each reader falls back to its own default.
 */
export function applyDeveloperModeGate(
  state: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  if (resolveDeveloperModeEnabled(state[DEVELOPER_MODE_SETTING_KEY])) return state;
  const gated: Record<string, unknown> = { ...state };
  for (const key of DEVELOPER_MODE_SETTING_KEYS) delete gated[key];
  return gated;
}
