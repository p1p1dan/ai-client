/**
 * The user's DSH plugin selection, in Main's shared settings (dsh-rebase
 * P1-10b; decisions 059 rule 4 and 108 rule 5).
 *
 * One Main-owned key, `dshPlugins: {enabled: [...]}`: the package names the
 * user switched on. Absent means nobody chose, and the host applies the
 * allowlist's `defaultEnabled` (`AICLIENT_DSH_PLUGINS` is then not set at
 * all). The renderer never models the key; `ipc/settings.ts` keeps it across
 * the renderer's whole-object saves (`MAIN_OWNED_SETTING_KEYS`).
 *
 * `currentDshHostLaunch` reads it at every spawn; `dshHostPlugins.ts` writes
 * it and asks for the restart.
 */

import { DSH_PLUGINS_SETTING_KEY, parseDshPluginSelection } from '@shared/dshPlugins';
import { readSharedSettings, writeSharedSettings } from '../SharedSessionState';

/** The enabled list the settings hold, or `undefined`: nobody chose (the allowlist's defaults). */
export function readDshPluginSelection(
  settings: Record<string, unknown> = readSharedSettings()
): string[] | undefined {
  return parseDshPluginSelection(settings[DSH_PLUGINS_SETTING_KEY]);
}

/**
 * Store `enabled` (each package name once, sorted), or drop the key for
 * `undefined` so the defaults apply again. Merged into the file like every
 * Main-owned key. Returns whether the stored value changed.
 */
export function writeDshPluginSelection(enabled: readonly string[] | undefined): boolean {
  const settings = readSharedSettings();
  const next =
    enabled === undefined ? undefined : parseDshPluginSelection({ enabled: [...enabled] });
  const stored = settings[DSH_PLUGINS_SETTING_KEY];
  const value = next === undefined ? undefined : { enabled: next };
  if (JSON.stringify(stored) === JSON.stringify(value)) return false;
  const { [DSH_PLUGINS_SETTING_KEY]: _previous, ...rest } = settings;
  writeSharedSettings(value === undefined ? rest : { ...rest, [DSH_PLUGINS_SETTING_KEY]: value });
  return true;
}
