/**
 * aiclient-fs-search — the workspace search tools as a DSH host row
 * (dsh-rebase decision 190), in place of dsh-base's `tool-fs-search` row,
 * which the product bundle turns off.
 *
 * DSH's row registers `glob` and `grep` together and offers no way to take
 * one without the other, so this row registers both: `glob` through DSH's own
 * `applyGlobTool`, unchanged, and `grep` as ours (`grepTool.ts`: output modes,
 * context lines, case folding, file types, multiline, paging). With
 * `AICLIENT_RUNTIME_RICH_GREP=0` (forwarded by Main) it registers DSH's
 * `applyGrepTool` instead, so the composition offers exactly what
 * `tool-fs-search` did.
 *
 * The config keeps dsh-tool-fs-search's field names and defaults, so the row's
 * config moved over from `tool-fs-search` as it was.
 *
 * Two ways in, like the bridge row (decision 011): a source checkout loads
 * `bundle/lib/fs-search.js`, a one-line re-export of this file; the packaged
 * host loads the esbuild bundle scripts/build-dsh-host.mjs writes over it.
 */

import type { Context } from '@deepseek-ai/cordis';
import {
  applyGlobTool,
  applyGrepTool,
  GLOB_MAX_RESULTS,
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_GRACE_MS,
  SEARCH_META_MAX_BYTES,
  SEARCH_STDERR_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
} from '@deepseek-ai/dsh-tool-fs-search';
import { richGrepEnabled } from '../lib/toolSwitches.ts';
import { applyRichGrepTool, type RichGrepCaps, type RichGrepContext } from './grepTool.ts';

/** Stable Cordis plugin name and bundle row id. */
export const name = 'aiclient-fs-search';

/** dsh-tool-fs-search's own: the registry, prompt assembly and the spawn seam. */
export const inject = ['tools', 'systemPrompt', 'subprocess'];

/** dsh-tool-fs-search's config, field for field. */
export interface FsSearchSettings {
  richGrep: boolean;
  glob: {
    sampleOverCapGlobResults: boolean;
    maxResults: number;
    maxMetaBytes: number;
    rawOutputMaxBytes: number;
    graceMs: number;
    stderrMaxBytes: number;
    timeoutMs: number;
  };
  /** DSH's grep, when the switch is off. */
  dshGrep: {
    maxMatches: number;
    maxLineBytes: number;
    maxMetaBytes: number;
    rawOutputMaxBytes: number;
    graceMs: number;
    stderrMaxBytes: number;
    timeoutMs: number;
  };
  grep: RichGrepCaps;
}

/**
 * The row's config, checked the way dsh-tool-fs-search checks its own: a
 * missing `sampleOverCapGlobResults` or a limit that is not a positive integer
 * throws, so a broken bundle fails at its first start.
 */
export function resolveFsSearchSettings(
  config: unknown,
  env: Readonly<Record<string, string | undefined>>
): FsSearchSettings {
  const raw = (typeof config === 'object' && config !== null ? config : {}) as Record<
    string,
    unknown
  >;
  if (typeof raw.sampleOverCapGlobResults !== 'boolean') {
    throw new Error('aiclient-fs-search: sampleOverCapGlobResults must be true or false');
  }
  const limit = (field: string, fallback: number): number => {
    const value = raw[field] ?? fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error(`aiclient-fs-search: ${field} must be a positive integer`);
    }
    return value;
  };
  const shared = {
    rawOutputMaxBytes: limit('rawOutputMaxBytes', RAW_OUTPUT_MAX_BYTES),
    graceMs: limit('graceMs', SEARCH_GRACE_MS),
    stderrMaxBytes: limit('stderrMaxBytes', SEARCH_STDERR_MAX_BYTES),
    timeoutMs: limit('timeoutMs', SEARCH_TIMEOUT_MS),
  };
  const maxMetaBytes = limit('searchMetaMaxBytes', SEARCH_META_MAX_BYTES);
  const maxLineBytes = limit('grepMaxLineBytes', GREP_MAX_LINE_BYTES);
  return {
    richGrep: richGrepEnabled(env),
    glob: {
      sampleOverCapGlobResults: raw.sampleOverCapGlobResults,
      maxResults: limit('globMaxResults', GLOB_MAX_RESULTS),
      maxMetaBytes,
      ...shared,
    },
    dshGrep: {
      maxMatches: limit('grepMaxMatches', GREP_MAX_MATCHES),
      maxLineBytes,
      maxMetaBytes,
      ...shared,
    },
    grep: { maxLineBytes, ...shared },
  };
}

export function apply(ctx: Context, config?: unknown): void {
  const settings = resolveFsSearchSettings(config, process.env);
  applyGlobTool(ctx, settings.glob);
  if (settings.richGrep) applyRichGrepTool(ctx as unknown as RichGrepContext, settings.grep);
  else applyGrepTool(ctx, settings.dshGrep);
}
