/**
 * Source-checkout shim for the aiclient-loop-guard row: the row lives in
 * `src/dsh-host/loopGuard/plugin.ts`, loaded here by type stripping. The
 * packaged host never sees this file; scripts/build-dsh-host.mjs overwrites it
 * with the esbuild bundle of that module (dsh-rebase decision 011).
 * @module @aiclient/dsh-app/loop-guard
 */
export * from '../../loopGuard/plugin.ts';
