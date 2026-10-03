/**
 * Types for `permissionPolicy.mjs`.
 *
 * The module is `.mjs` because the 1.0.x worker build script imported it (a
 * `.mjs` cannot import a `.ts`) while the policy itself needs a comment per
 * judgement call (a `.json` cannot carry one). Since dsh-rebase P1-12 it lives
 * in the permissions library, and its TypeScript consumers need a declaration.
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

/** The table as JSON text: the bytes the 1.0.x build wrote into the worker artifact. */
export declare function serializeDefaultPermissionPolicy(): string;
