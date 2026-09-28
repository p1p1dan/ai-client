/**
 * The user's DSH plugin overrides, in Main's shared settings (dsh-rebase
 * P1-10b; decisions 059 rule 4, 108 rule 5 and 110).
 *
 * One Main-owned key, `dshPlugins: {overrides: {"<name>": true|false}}`: the
 * plugins the user has switched on or off by hand. A plugin missing from
 * `overrides` — absent altogether means nobody has touched any plugin — has
 * the host apply the allowlist's `defaultEnabled` for it (`AICLIENT_DSH_PLUGINS`
 * is then not set at all). The renderer never models the key; `ipc/settings.ts`
 * keeps it across the renderer's whole-object saves (`MAIN_OWNED_SETTING_KEYS`).
 *
 * `currentDshHostLaunch` reads it at every spawn; `dshHostPlugins.ts` writes
 * it and asks for the restart.
 */

import { DSH_PLUGINS_SETTING_KEY, parseDshPluginSelection } from '@shared/dshPlugins';
import { readSharedSettings, writeSharedSettings } from '../SharedSessionState';

/**
 * The overrides the settings hold, or `undefined`: nobody has touched any
 * plugin (every plugin follows the allowlist's `defaultEnabled`).
 */
export function readDshPluginSelection(
  settings: Record<string, unknown> = readSharedSettings()
): Record<string, boolean> | undefined {
  return parseDshPluginSelection(settings[DSH_PLUGINS_SETTING_KEY]);
}

/**
 * Store `overrides` (each entry a package name mapped to the user's choice),
 * or drop the key for `undefined` so every plugin goes back to following its
 * default. Merged into the file like every Main-owned key. Returns whether
 * the stored value changed.
 */
export function writeDshPluginSelection(overrides: Record<string, boolean> | undefined): boolean {
  const settings = readSharedSettings();
  const next = overrides === undefined ? undefined : parseDshPluginSelection({ overrides });
  const stored = settings[DSH_PLUGINS_SETTING_KEY];
  const value = next === undefined ? undefined : { overrides: next };
  if (JSON.stringify(stored) === JSON.stringify(value)) return false;
  const { [DSH_PLUGINS_SETTING_KEY]: _previous, ...rest } = settings;
  writeSharedSettings(value === undefined ? rest : { ...rest, [DSH_PLUGINS_SETTING_KEY]: value });
  return true;
}
