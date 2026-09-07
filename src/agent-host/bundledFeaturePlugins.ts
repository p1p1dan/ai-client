/**
 * Resolving the bundled feature extensions — R03.
 *
 * The list itself lives in `bundledPlugins.mjs`, which the build script also
 * reads; this module is only the runtime half — turn each name into an absolute
 * directory for `resourceLoaderOptions.additionalExtensionPaths`, and decide
 * when NOT to.
 *
 * ## These paths must never be mixed into the permission gate's list
 *
 * `verifyPermissionExtensionLoaded(loaded, injectedRoots)` accepts ANY extension
 * whose path starts with one of `injectedRoots` as proof that the permission
 * system loaded. Appending a feature plugin's root to that argument would make
 * "pi-subagents loaded" satisfy the check that exists to prove the approval gate
 * is running — a session with no gate would then start and report itself
 * healthy. The two lists are joined only where pi is called, and the
 * verification keeps receiving the gate's list alone.
 *
 * ## Missing is not fatal here
 *
 * The permission system is fail-closed: absent, the session refuses to start,
 * because tools would otherwise run unattended. A feature plugin is the opposite
 * — absent, one feature is gone and everything else is exactly as safe as it
 * was. So a problem is reported for the log and the session proceeds.
 *
 * ## Opt-in plugins
 *
 * A plugin carrying an `optIn` feature id is SHIPPED but not injected until the
 * session names that id. The cost it avoids is not disk: every extension's tool
 * schemas sit in the cached prefix of every request, so a feature nobody uses is
 * still paid for on every turn. `parseOptInFeatures` reads the list Main sends;
 * an absent list enables nothing, which is the conservative side and the side an
 * older Main build lands on.
 *
 * ## Why a user's own copy wins
 *
 * pi merges the settings-derived package list with `additionalExtensionPaths`.
 * Two live copies of the same extension register their tools and commands twice,
 * and the user's copy is the one they chose the version of. Skipping ours is
 * both the smaller surprise and the one they can undo.
 */

import { BUNDLED_FEATURE_PLUGINS } from './bundledPlugins.mjs';
import {
  hostDirectory,
  lookupBundledPackage,
  type PermissionPluginMatchOptions,
  type PermissionPluginProblem,
  packageConfiguredByUser,
} from './permissionPlugin.ts';

export interface SkippedFeaturePlugin {
  package: string;
  reason: 'user_configured' | 'not_enabled' | PermissionPluginProblem;
  /** Human-readable, for the Host log. */
  detail?: string;
}

export interface BundledFeaturePluginResolution {
  /** Absolute directories to append to `additionalExtensionPaths`. */
  paths: string[];
  /** Everything not injected, with the reason — a silent skip is a bug report nobody can file. */
  skipped: SkippedFeaturePlugin[];
}

/**
 * Parse the comma-separated feature ids Main sends in
 * `AICLIENT_PI_OPT_IN_EXTENSIONS`.
 *
 * `undefined` and an empty string both mean "none". Unknown ids are kept rather
 * than rejected: this list is written by a newer Main than the Host it may be
 * talking to, and an id for a plugin this build does not carry simply matches
 * nothing.
 */
export function parseOptInFeatures(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  );
}

/**
 * Which bundled feature plugins should this session load?
 *
 * `configuredPackages` is the user's own merged `packages` list, the same value
 * `decidePermissionPlugin` is given.
 *
 * The opt-in gate is checked FIRST, before the user's own copy. Both arms end in
 * "our copy is not injected", and when the feature is off the more accurate
 * reason to log is that it is off — a `user_configured` line would claim we
 * stood aside for their version when we were never going to inject ours. A user
 * who lists the package in their own pi settings still gets pi's own loading
 * path; this switch only governs the copy we inject.
 */
export function resolveBundledFeaturePlugins(
  configuredPackages: unknown,
  baseDir = hostDirectory(),
  options: PermissionPluginMatchOptions & {
    /** Feature ids the user turned on; anything `optIn` outside it is skipped. */
    optInFeatures?: ReadonlySet<string>;
  } = {}
): BundledFeaturePluginResolution {
  const paths: string[] = [];
  const skipped: SkippedFeaturePlugin[] = [];
  const optInFeatures = options.optInFeatures ?? new Set<string>();

  for (const plugin of BUNDLED_FEATURE_PLUGINS) {
    if (plugin.optIn && !optInFeatures.has(plugin.optIn)) {
      skipped.push({
        package: plugin.package,
        reason: 'not_enabled',
        detail: `${plugin.package} is off by default; enable "${plugin.optIn}" in Settings → Pi Resources to load it`,
      });
      continue;
    }
    if (packageConfiguredByUser(configuredPackages, plugin.package, options)) {
      skipped.push({
        package: plugin.package,
        reason: 'user_configured',
        detail: `${plugin.package} is configured in the user's own pi settings; the bundled copy is not injected`,
      });
      continue;
    }
    const found = lookupBundledPackage(plugin.package, baseDir);
    if (found.path) {
      paths.push(found.path);
      continue;
    }
    skipped.push({
      package: plugin.package,
      reason: found.problem ?? 'not_present',
      detail: found.detail,
    });
  }

  return { paths, skipped };
}
