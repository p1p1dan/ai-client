/**
 * Source-checkout shim for the aiclient-permissions row: the row lives in
 * `src/dsh-host/permissions/plugin.ts`, loaded here by type stripping. The
 * packaged host never sees this file; scripts/build-dsh-host.mjs overwrites it
 * with the esbuild bundle of that module (dsh-rebase decision 011).
 * @module @aiclient/dsh-app/permissions
 */
export * from '../../permissions/plugin.ts';
