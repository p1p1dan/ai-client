/**
 * The DSH plugin set between Main and the shared host (dsh-rebase P1-10b;
 * decisions 058, 059, 108 and 110).
 *
 *   Main   keeps the user's per-plugin overrides under the Main-owned
 *          settings key `dshPlugins` (`{overrides: {"<name>": true|false}}`;
 *          absent, or a plugin missing from `overrides`, means nobody has
 *          touched it — it follows the allowlist's `defaultEnabled`, so a
 *          plugin the allowlist adds in a later version turns on for a user
 *          who has only ever touched a different plugin's switch) and hands
 *          the host the overrides at every spawn (`AICLIENT_DSH_PLUGINS`,
 *          dshHostEnvironment.ts).
 *   host   resolves each plugin's override against the allowlist's
 *          `defaultEnabled`, composes the product bundles plus the enabled
 *          allowlisted plugins, and reports every allowlisted plugin's state
 *          in `ready` (`plugins`, {@link DshPluginReport}); Main keeps the
 *          latest report for the settings page (P1-10c).
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
   * Where the enabled set came from: `'main'` when Main sent an overrides
   * object (each plugin missing from it still follows the allowlist's
   * `defaultEnabled`), `'default'` when Main sent nothing at all (the env
   * var was absent: every plugin follows its default), or `'invalid'`
   * because Main's value could not be parsed (fail closed: nothing enabled).
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
 * The overrides a `dshPlugins` settings value holds: package name -> whether
 * the user turned it on or off by hand, keys sorted. `undefined` when there
 * is no usable value — nobody has touched any plugin, so every plugin
 * follows the allowlist's `defaultEnabled` (decision 110). An empty object is
 * itself a usable value (nobody has touched anything, but Main still owns the
 * decision) and is kept, not turned into `undefined`. Entries that are not a
 * package name mapped to a boolean are dropped; the host intersects the rest
 * with its allowlist anyway.
 */
export function parseDshPluginSelection(raw: unknown): Record<string, boolean> | undefined {
  if (!isRecord(raw) || !isRecord(raw.overrides)) return undefined;
  const overrides: Record<string, boolean> = {};
  for (const name of Object.keys(raw.overrides).sort()) {
    const value = raw.overrides[name];
    if (isDshPluginPackageName(name) && typeof value === 'boolean') overrides[name] = value;
  }
  return overrides;
}
