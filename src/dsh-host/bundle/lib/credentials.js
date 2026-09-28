/**
 * Source-checkout shim for the aiclient-credentials row: the row lives in
 * `src/dsh-host/credentials/plugin.ts`, loaded here by type stripping. The
 * packaged host never sees this file; scripts/build-dsh-host.mjs overwrites it
 * with the esbuild bundle of that module (dsh-rebase decision 011).
 * @module @aiclient/dsh-app/credentials
 */
export { default, name } from '../../credentials/plugin.ts';
