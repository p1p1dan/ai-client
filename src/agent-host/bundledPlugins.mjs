/**
 * The feature extensions this app ships with — R03.
 *
 * ## Why a table and not three constants
 *
 * Three consumers read this list and each of them fails differently when it
 * drifts, so there is exactly one place to change:
 *
 *  - `scripts/agent-host-build-lib.mjs` — preflight (is it installed?), the copy
 *    filter's licence set, and artifact verification (did the entry survive?).
 *  - `src/agent-host/bundledFeaturePlugins.ts` — resolves each to an absolute
 *    path at runtime and hands it to pi.
 *  - the tests for both.
 *
 * ## `entry` is an assertion, not a lookup
 *
 * Each `entry` is copied from that package's own `pi.extensions[0]`, and the
 * build asserts the file exists in the artifact. This is deliberate duplication:
 * the packaging filter walks DIRECTORIES and skips a whole subtree the moment it
 * answers no, so a filter mistake removes a package silently and every unit test
 * still passes. A missing entry file is the one symptom that cannot hide.
 *
 * If an upstream release moves its entry, the build fails loudly here rather
 * than shipping an extension that never loads.
 *
 * ## Why these two
 *
 * `@juicesharp/rpiv-ask-user-question` has a non-terminal branch
 * (`ask-user-question.ts`: `ctx.mode === "rpc" && hasDialogUI(ctx.ui)`) that
 * drives `ui.select` / `ui.input` — the two primitives `ExtensionUiDialog.tsx`
 * already renders. The renderer has had a complete consumer for this and no
 * producer.
 *
 * `@gotgenes/pi-subagents` is bundled INSTEAD of `tintinweb/pi-subagents`, which
 * the permission system's own compatibility table
 * (`@gotgenes/pi-permission-system/docs/subagent-integration.md`) records as
 * emitting no lifecycle events: its sub-agents get neither deterministic
 * detection nor ask-state forwarding, so their tool calls run around the
 * approval dialog while the UI still shows a permission tier. That is a security
 * gap, not a preference.
 *
 * ## Not bundled, and why
 *
 * `pi-workspace-history` — blocked upstream, not rejected. See
 * `docs/plantree/plans/pi-resources-and-commands/open-questions.md` (Q-R5).
 * `pi-cc-extensions` (14M, re-adds a terminal UI), `pi-fff` (native binaries),
 * `rpiv-advisor` (spends model quota by default), `rpiv-web-tools` (ten API keys
 * to fill in) and `pi-web-access` (measured +170M) stay on the recommend list.
 */

/**
 * @typedef {object} BundledFeaturePlugin
 * @property {string} package npm name, exactly as installed under node_modules.
 * @property {string} entry Path within the package to its `pi.extensions[0]`.
 * @property {boolean} shipsLicenceFile Whether upstream includes a LICENSE file.
 */

/** @type {readonly BundledFeaturePlugin[]} */
export const BUNDLED_FEATURE_PLUGINS = [
  {
    package: '@juicesharp/rpiv-ask-user-question',
    entry: 'index.ts',
    shipsLicenceFile: true,
  },
  {
    package: '@gotgenes/pi-subagents',
    entry: 'src/index.ts',
    shipsLicenceFile: true,
  },
];

/** Package names only, for the preflight that refuses to build without them. */
export function bundledFeaturePluginPackages() {
  return BUNDLED_FEATURE_PLUGINS.map((plugin) => plugin.package);
}

/**
 * Entry paths as `shouldCopy` sees them — relative to `node_modules`, NOT
 * including it.
 *
 * The two views exist because the copy filter and the artifact verifier disagree
 * about where the root is: the walker is rooted AT `node_modules`, the verifier
 * at the artifact directory above it. Passing a verifier path to `shouldCopy`
 * makes `topPackage` read `node_modules` as the package name, so every
 * package-specific branch silently stops matching and the assertion passes no
 * matter what the filter does.
 */
export function bundledFeaturePluginCopyPaths() {
  return BUNDLED_FEATURE_PLUGINS.map((plugin) => `${plugin.package}/${plugin.entry}`);
}

/** Artifact-relative paths of the entry files, for `verifyArtifact`. */
export function bundledFeaturePluginEntryPaths() {
  return bundledFeaturePluginCopyPaths().map((rel) => `node_modules/${rel}`);
}
