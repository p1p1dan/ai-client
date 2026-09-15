/**
 * Types for `bundledPlugins.mjs`.
 *
 * The table is `.mjs` for the same reason `permissionPolicy.mjs` is: the build
 * script imports it, and a `.mjs` cannot import a `.ts`. Main imports the same
 * file, so both ends agree by construction rather than by review.
 */

/** pi extension packages this app used to bundle and must not bundle again. */
export declare const RETIRED_BUNDLED_PLUGIN_PACKAGES: readonly string[];

export interface NativeFeatureSwitch {
  /** Feature id the user turns on or off. */
  id: string;
  settings?: {
    label: string;
    cost: string;
    legacySettingKey?: string;
  };
}

export declare const NATIVE_FEATURE_SWITCHES: readonly NativeFeatureSwitch[];

export interface NativeFeature {
  id: string;
  label: string;
  cost: string;
  legacySettingKey?: string;
}
export declare function nativeFeatureRegistry(
  switches?: readonly NativeFeatureSwitch[]
): NativeFeature[];
