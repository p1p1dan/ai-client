/**
 * Types for `permissionPolicy.mjs`.
 *
 * The module is `.mjs` because the BUILD SCRIPT imports it (a `.mjs` cannot
 * import a `.ts`) while the policy itself needs a comment per judgement call
 * (a `.json` cannot carry one). That leaves TypeScript consumers — the tests —
 * needing a declaration.
 *
 * Deliberately loose. Restating the policy's shape here would create a second
 * place for it to be described and a way for the two to disagree; the tests
 * narrow what they read. What this file exists to say is only "these two
 * exports are there, and one of them returns a string".
 */

export declare const AICLIENT_DEFAULT_PERMISSION_POLICY: {
  $schema: string;
  debugLog: boolean;
  permissionReviewLog: boolean;
  yoloMode: boolean;
  permission: {
    path: Record<string, unknown>;
    [surface: string]: unknown;
  };
};

/** The exact bytes the build writes into the artifact. */
export declare function serializeDefaultPermissionPolicy(): string;
