/**
 * Source-checkout shim for the aiclient-encrypted-read row: the row lives in
 * `src/dsh-host/encryptedRead/plugin.ts`, loaded here by type stripping. The
 * packaged host never sees this file; scripts/build-dsh-host.mjs overwrites
 * it with the esbuild bundle of that module (dsh-rebase decision 011).
 * @module @aiclient/dsh-app/encrypted-read
 */
export * from '../../encryptedRead/plugin.ts';
