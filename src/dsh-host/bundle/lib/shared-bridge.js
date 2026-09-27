/**
 * Source-checkout shim for the aiclient-shared-bridge row (P0-6 prototype):
 * the row lives in `src/dsh-host/bridge/sharedPlugin.js`. The packaged host
 * gets the esbuild bundle of that module in place of this file
 * (dsh-rebase decision 011).
 * @module @aiclient/dsh-app/shared-bridge
 */
export * from '../../bridge/sharedPlugin.js';
