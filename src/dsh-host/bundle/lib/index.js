/**
 * @aiclient/dsh-app — ai-client's worker-engine bundle over dsh-base.
 *
 * The bundle is its patch (`cordis.patch.yml`); its one plugin row is the
 * subpath export `./bridge`. Nothing imports the package root.
 * The P0 IPC probe that used to live here (`aiclient-probe`, which answers
 * every approval with allowed-once) is the test-only bundle
 * `src/dsh-host/tools/probe-bundle` now, and never ships (dsh-rebase decision 015).
 * @module @aiclient/dsh-app
 */

/** The profile bundle name this package is layered under. */
export const bundleName = '@aiclient/dsh-app';
