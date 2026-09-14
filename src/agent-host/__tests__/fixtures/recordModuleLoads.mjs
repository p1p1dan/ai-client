/**
 * P6-2 — `--import` entry that installs the recording hooks.
 *
 * The log path travels through `AICLIENT_MODULE_LOG` because hooks are
 * initialized before the worker's own environment handling runs.
 */
import { register } from 'node:module';

register('./moduleLoadHooks.mjs', import.meta.url, {
  data: { path: process.env.AICLIENT_MODULE_LOG },
});
