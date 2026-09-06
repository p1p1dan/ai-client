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
  reason: 'user_configured' | PermissionPluginProblem;
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
 * Which bundled feature plugins should this session load?
 *
 * `configuredPackages` is the user's own merged `packages` list, the same value
 * `decidePermissionPlugin` is given.
 */
export function resolveBundledFeaturePlugins(
  configuredPackages: unknown,
  baseDir = hostDirectory(),
  options: PermissionPluginMatchOptions = {}
): BundledFeaturePluginResolution {
  const paths: string[] = [];
  const skipped: SkippedFeaturePlugin[] = [];

  for (const plugin of BUNDLED_FEATURE_PLUGINS) {
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
