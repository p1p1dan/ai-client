/**
 * Types for `bundledPlugins.mjs`.
 *
 * The table is `.mjs` for the same reason `permissionPolicy.mjs` is: the build
 * script imports it, and a `.mjs` cannot import a `.ts`. The runtime resolver
 * (`bundledFeaturePlugins.ts`) reads the same table, so both ends agree by
 * construction rather than by review.
 */

export interface BundledFeaturePlugin {
  /** npm name, exactly as installed under `node_modules`. */
  package: string;
  /** Path within the package to its `pi.extensions[0]`. */
  entry: string;
  /** Whether upstream includes a LICENSE file in its published tarball. */
  shipsLicenceFile: boolean;
  /**
   * Feature id that must appear in the session's opt-in list before this plugin
   * is injected. Absent means "always injected".
   */
  optIn?: string;
  settings?: {
    label: string;
    cost: string;
    defaultEnabled: boolean;
    legacySettingKey?: string;
  };
}

export declare const BUNDLED_FEATURE_PLUGINS: readonly BundledFeaturePlugin[];

export interface OptInFeature {
  id: string;
  label: string;
  cost: string;
  defaultEnabled: boolean;
  legacySettingKey?: string;
}
export declare function optInFeatureRegistry(
  plugins?: readonly BundledFeaturePlugin[]
): OptInFeature[];

/** Feature ids of the plugins that are shipped but injected only on request. */
export declare function optInFeatureIds(): string[];

/** Package names only, for the preflight that refuses to build without them. */
export declare function bundledFeaturePluginPackages(): string[];

/** Artifact-relative paths of the entry files, for `verifyArtifact`. */
export declare function bundledFeaturePluginEntryPaths(): string[];
