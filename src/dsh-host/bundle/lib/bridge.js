/**
 * Source-checkout shim for the aiclient-bridge row: the row lives in
 * `src/dsh-host/bridge/plugin.ts`, loaded here by type stripping. The packaged
 * host never sees this file; scripts/build-dsh-host.mjs overwrites it with the
 * esbuild bundle of that module (dsh-rebase decision 011).
 * @module @aiclient/dsh-app/bridge
 */
export * from '../../bridge/plugin.ts';
