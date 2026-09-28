/**
 * The DSH plugin set between Main and the shared host (dsh-rebase P1-10b;
 * decisions 058, 059 and 108).
 *
 *   Main   keeps the user's choice under the Main-owned settings key
 *          `dshPlugins` (`{enabled: [...]}`; absent: nobody chose, the
 *          allowlist's `defaultEnabled` apply) and hands the host the enabled
 *          list at every spawn (`AICLIENT_DSH_PLUGINS`, dshHostEnvironment.ts).
 *   host   composes the product bundles plus the enabled allowlisted plugins
 *          and reports every allowlisted plugin's state in `ready`
 *          (`plugins`, {@link DshPluginReport}); Main keeps the latest report
 *          for the settings page (P1-10c).
 *
 * Import-free and erasable: Main imports it, the host only its types.
 */

/** Main-owned top-level settings key (`MAIN_OWNED_SETTING_KEYS` in ipc/settings.ts). */
export const DSH_PLUGINS_SETTING_KEY = 'dshPlugins';

/**
 * What became of one allowlisted plugin at a host start:
 *   loaded    composed from the install directory; its bundle patch inserts
 *             only the rows the allowlist declares
 *   disabled  not in the enabled set
 *   missing   enabled, but not in the host's install directory (decision 025
 *             rule 5: a warning, never a refused boot)
 *   rejected  enabled and installed, but left out: another version, not a
 *             bundle, skipped by DSH (a peer it does not satisfy), resolved
 *             outside the install directory, or a bundle patch that inserts
 *             an undeclared row or touches a row it did not insert
 */
export type DshPluginState = 'loaded' | 'disabled' | 'missing' | 'rejected';

export const DSH_PLUGIN_STATES: readonly DshPluginState[] = [
  'loaded',
  'disabled',
  'missing',
  'rejected',
];

export interface DshPluginStatus {
  name: string;
  /** The allowlisted version. */
  version: string;
  state: DshPluginState;
  /** Why a plugin is not loaded; absent for `loaded` and for a plain `disabled`. */
  reason?: string;
  defaultEnabled: boolean;
  /** `loaded` only: declared rows that did not start (their `apply` threw, or they wait on a service). */
  inactiveRows?: string[];
}

/** A bundle the profile listed that the host took out of it, and why. */
export interface DshDroppedBundle {
  name: string;
  reason: string;
}

/** `ready.plugins`. */
export interface DshPluginReport {
  /**
   * Where the enabled set came from: Main's list, the allowlist's defaults
   * (Main sent none), or nothing at all because Main's value was malformed.
   */
  enabledFrom: 'main' | 'default' | 'invalid';
  /** Every allowlisted plugin, in allowlist order. */
  plugins: DshPluginStatus[];
  /** Bundles the profile listed that this start dropped (off the allowlist, disabled, missing). */
  dropped: DshDroppedBundle[];
}

/** npm package names (the allowlist's own rule). */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function isDshPluginPackageName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 214 && PACKAGE_NAME.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is DshPluginStatus {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.version === 'string' &&
    (DSH_PLUGIN_STATES as readonly unknown[]).includes(value.state) &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    typeof value.defaultEnabled === 'boolean' &&
    (value.inactiveRows === undefined ||
      (Array.isArray(value.inactiveRows) &&
        value.inactiveRows.every((row) => typeof row === 'string')))
  );
}

export function isDshPluginReport(value: unknown): value is DshPluginReport {
  return (
    isRecord(value) &&
    (value.enabledFrom === 'main' ||
      value.enabledFrom === 'default' ||
      value.enabledFrom === 'invalid') &&
    Array.isArray(value.plugins) &&
    value.plugins.every(isStatus) &&
    Array.isArray(value.dropped) &&
    value.dropped.every(
      (item) => isRecord(item) && typeof item.name === 'string' && typeof item.reason === 'string'
    )
  );
}

/**
 * The enabled list a `dshPlugins` settings value holds: package names, once
 * each, sorted. `undefined` when there is no usable value — nobody chose, so
 * the allowlist's `defaultEnabled` decide. Names that are not package names
 * are dropped; the host intersects the rest with its allowlist anyway.
 */
export function parseDshPluginSelection(raw: unknown): string[] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.enabled)) return undefined;
  return [...new Set(raw.enabled.filter(isDshPluginPackageName))].sort();
}
