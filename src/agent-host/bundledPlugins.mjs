/**
 * Feature switches this app offers, and the pi extension packages it refuses to
 * ship — R03, rewritten by T025.
 *
 * ## Nothing is bundled any more
 *
 * R03 shipped two pi extensions inside the worker and injected them into pi's
 * resource loader: `@juicesharp/rpiv-ask-user-question` (a `ui.select` /
 * `ui.input` questionnaire) and `@gotgenes/pi-subagents` (delegation). P6-5
 * retired the engine that did the injecting. The native runtime answers both
 * needs itself — the `ask` tool raises `question.requested`, and delegation is
 * `src/runtime/plugins/subagent/` — so the two packages had no runtime consumer
 * left, only ~1.7 MB of payload the build still insisted on and verified.
 *
 * They are named in {@link RETIRED_BUNDLED_PLUGIN_PACKAGES} rather than simply
 * forgotten, because "not in the dependency list" is not by itself a guard: the
 * copy filter walks whatever is installed under `src/agent-host/node_modules`,
 * so a leftover install directory would quietly travel again. The filter
 * refuses these names outright (`shouldCopy` in
 * `scripts/agent-host-build-lib.mjs`).
 *
 * `@gotgenes/pi-permission-system` is NOT on that list and is still shipped:
 * `src/main/services/piPermissionPolicy/index.ts` reads
 * `<worker dir>/node_modules/@gotgenes/pi-permission-system/config.json` as the
 * bundled scope of the permission-policy panel, and the build writes that file.
 * It is payload plus a file location, not a loaded extension.
 *
 * ## What the opt-in table is for now
 *
 * {@link OPT_IN_FEATURE_PLUGINS} still drives the Settings → Pi Resources
 * switches (Main reads it through {@link optInFeatureRegistry}). The one entry
 * left, `subagents`, no longer enables a package — the native runtime always
 * has delegation. Reconciling that switch with what native actually does is
 * T026's job; T025 only stopped shipping the package behind it, and left the
 * user-visible switch exactly as it was.
 */

/**
 * pi extension packages this app used to bundle and must not bundle again.
 *
 * Kept as data so the copy filter, the artifact verifier and their tests all
 * refuse the same names.
 */
export const RETIRED_BUNDLED_PLUGIN_PACKAGES = [
  '@juicesharp/rpiv-ask-user-question',
  '@gotgenes/pi-subagents',
];

/**
 * @typedef {object} OptInFeaturePlugin
 * @property {string} optIn Feature id the user turns on.
 * @property {{label: string, cost: string, defaultEnabled: boolean, legacySettingKey?: string}} [settings]
 */

/** @type {readonly OptInFeaturePlugin[]} */
export const OPT_IN_FEATURE_PLUGINS = [
  {
    optIn: 'subagents',
    settings: {
      label: 'Sub-agents',
      cost: 'Lets the model delegate work to background agents. Off by default: its tool definitions are sent with every request, so it costs tokens on every turn even when unused. Changing it reloads Pi workers.',
      defaultEnabled: false,
      legacySettingKey: 'enablePiSubagents',
    },
  },
];

export function optInFeatureRegistry(plugins = OPT_IN_FEATURE_PLUGINS) {
  return plugins.flatMap((plugin) => {
    if (!plugin.optIn) return [];
    if (!plugin.settings?.cost.trim() || !plugin.settings.label.trim()) {
      throw new Error(`Missing settings or cost description for ${plugin.optIn}`);
    }
    return [{ id: plugin.optIn, ...plugin.settings }];
  });
}
