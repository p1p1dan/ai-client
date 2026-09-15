/**
 * Feature switches this app offers, and the pi extension packages it refuses to
 * ship — R03, rewritten by T025 and T026.
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
 * ## What the switch table is for now
 *
 * {@link NATIVE_FEATURE_SWITCHES} drives the Settings → Pi Resources switches
 * (Main reads it through {@link nativeFeatureRegistry}). The one entry left,
 * `subagents`, no longer enables a package — it turns a feature of this app's
 * OWN runtime on and off, which is why T026 renamed it off the "opt-in bundled
 * extension" vocabulary.
 *
 * There is no `defaultEnabled` here any more. The default is not this table's
 * to state: the native runtime's contract is that an install which never
 * expressed a preference gets the full builtin catalog, and the single reader
 * of that rule is `nativeSubagentSettings` in Main. A second copy here is
 * exactly how the page came to show "off" for a session that was registering
 * delegation tools on every turn (cutover-10).
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
 * @typedef {object} NativeFeatureSwitch
 * @property {string} id Feature id the user turns on or off.
 * @property {{label: string, cost: string, legacySettingKey?: string}} [settings]
 */

/** @type {readonly NativeFeatureSwitch[]} */
export const NATIVE_FEATURE_SWITCHES = [
  {
    id: 'subagents',
    settings: {
      label: 'Sub-agents',
      cost: 'Lets the model delegate work to background agents. On unless you turn it off: its tool definitions are sent with every request, so it costs tokens on every turn even when unused. Changing it reloads workers.',
      legacySettingKey: 'enablePiSubagents',
    },
  },
];

export function nativeFeatureRegistry(switches = NATIVE_FEATURE_SWITCHES) {
  return switches.flatMap((entry) => {
    if (!entry.id) return [];
    if (!entry.settings?.cost.trim() || !entry.settings.label.trim()) {
      throw new Error(`Missing settings or cost description for ${entry.id}`);
    }
    return [{ id: entry.id, ...entry.settings }];
  });
}
