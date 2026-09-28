/**
 * The plugin settings page's state (dsh-rebase P1-10c; decisions 108, 110
 * and 117): the catalog this build ships, merged with the user's overrides
 * and the latest host report. Pure; `ipc/dshPlugins.ts` does the reading.
 */

import type {
  DshDelistedPlugin,
  DshPluginHostStatus,
  DshPluginsState,
  DshPluginView,
} from '@shared/dshPluginSettings';
import type { DshPluginReport } from '@shared/dshPlugins';
import type { DshPluginCatalog } from './pluginCatalog';

/**
 * Merge the three sources.
 *
 * - `enabled` is what the next host start asks for, by the host's own rule
 *   (`enabledNames` in src/dsh-host/lib/hostPlugins.ts): the override when
 *   there is one, else the allowlist's `defaultEnabled`.
 * - `pendingRestart` compares it with the last reported start: `disabled`
 *   means the host left it out; `loaded`, `missing` and `rejected` all mean
 *   the host was asked for it. No report, no comparison.
 * - `delisted` lists names this build no longer ships that the user had
 *   switched on, and names the host's last start dropped that are not in the
 *   catalog (with the host's reason). A delisted name the user switched off
 *   is not news.
 */
export function buildDshPluginsState(input: {
  catalog: DshPluginCatalog;
  overrides: Readonly<Record<string, boolean>> | undefined;
  report: DshPluginReport | undefined;
}): DshPluginsState {
  const { catalog, overrides = {}, report } = input;
  const plugins: DshPluginView[] = catalog.plugins.map((entry) => {
    const override = Object.hasOwn(overrides, entry.name) ? overrides[entry.name] : undefined;
    const enabled = override ?? entry.defaultEnabled;
    const status = report?.plugins.find((plugin) => plugin.name === entry.name);
    const host: DshPluginHostStatus | null = status
      ? {
          state: status.state,
          ...(status.reason !== undefined ? { reason: status.reason } : {}),
          ...(status.inactiveRows !== undefined ? { inactiveRows: [...status.inactiveRows] } : {}),
        }
      : null;
    return {
      ...entry,
      enabled,
      overridden: override !== undefined,
      host,
      pendingRestart: host !== null && (host.state !== 'disabled') !== enabled,
    };
  });

  const shipped = new Set(catalog.plugins.map((entry) => entry.name));
  const delisted: DshDelistedPlugin[] = [];
  const addDelisted = (name: string, reason: string | null): void => {
    const known = delisted.find((item) => item.name === name);
    if (known) known.reason ??= reason;
    else delisted.push({ name, reason });
  };
  for (const [name, on] of Object.entries(overrides)) {
    if (on && !shipped.has(name)) addDelisted(name, null);
  }
  for (const dropped of report?.dropped ?? []) {
    if (!shipped.has(dropped.name) && overrides[dropped.name] !== false) {
      addDelisted(dropped.name, dropped.reason);
    }
  }

  return {
    plugins,
    delisted,
    hostReported: report !== undefined,
    selectionInvalid: report?.enabledFrom === 'invalid',
    catalogError: catalog.error,
  };
}

/**
 * The overrides after the user flips one switch: every other entry is kept as
 * it was, including names this build no longer ships (a plugin delisted for
 * one version keeps the user's choice if it comes back).
 */
export function withOverride(
  current: Readonly<Record<string, boolean>> | undefined,
  name: string,
  enabled: boolean
): Record<string, boolean> {
  return { ...(current ?? {}), [name]: enabled };
}
