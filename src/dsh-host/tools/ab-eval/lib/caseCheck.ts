/**
 * `--check-cases`: every case prepared once, its setup run, and its checks run
 * against the untouched repository, with an empty answer, and no model at all.
 * A case is only worth running if that fails: when every check already passes
 * with no agent work, the checks cannot tell a good run from no run.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { commandChecks, runCommandList, staticChecks } from './checks.ts';
import { baseEnv, createSandbox, packageCacheEnv } from './sandbox.ts';
import type { CheckResult, LoadedCase } from './types.ts';
import {
  applyOverlay,
  collectChanges,
  commitSetup,
  DEFAULT_IGNORE,
  prepareWorkspace,
} from './workspace.ts';

export interface CaseCheckResult {
  id: string;
  /** Setup and preparation went through. */
  prepared: boolean;
  error?: string;
  setup: CheckResult[];
  setupMs: number;
  checks: CheckResult[];
  /** The checks cannot fail an agent that does nothing. */
  toothless: boolean;
}

export async function checkCases(
  cases: readonly LoadedCase[],
  scratchRoot: string,
  scratchDir: string,
  log: (line: string) => void
): Promise<CaseCheckResult[]> {
  const out: CaseCheckResult[] = [];
  for (const [index, c] of cases.entries()) {
    const box = createSandbox(scratchDir, `check-${index + 1}`);
    const base = baseEnv(box, { proxies: true });
    const result: CaseCheckResult = {
      id: c.id,
      prepared: false,
      setup: [],
      setupMs: 0,
      checks: [],
      toothless: false,
    };
    try {
      let commit = prepareWorkspace(c, box.ws, join(scratchRoot, 'git-cache'), base);
      if (c.setup && c.setup.length > 0) {
        const started = performance.now();
        result.setup = await runCommandList(c.setup, 'setup', box.ws, {
          ...base,
          ...packageCacheEnv(scratchRoot),
        });
        result.setupMs = Math.round(performance.now() - started);
        const failed = result.setup.find((item) => !item.passed);
        if (failed) throw new Error(`setup failed: ${failed.id}`);
        commit = commitSetup(box.ws, commit, base);
      }
      result.prepared = true;
      const ignore = [...DEFAULT_IGNORE, ...(c.checks?.ignore ?? [])];
      const changes = collectChanges(box.ws, commit, ignore, base);
      const checks = c.checks ?? {};
      result.checks.push(
        ...staticChecks(checks, {
          ws: box.ws,
          changes: changes.files,
          patch: changes.patch,
          answer: '',
          env: base,
        })
      );
      if (c.overlayDir) applyOverlay(c.overlayDir, box.ws);
      result.checks.push(...(await commandChecks(checks, box.ws, base)));
      result.toothless = result.checks.every((item) => item.passed);
    } catch (error) {
      result.error = String(error instanceof Error ? error.message : error);
    } finally {
      rmSync(box.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    log(
      `${c.id}: ${result.error ? `NOT READY — ${result.error}` : result.toothless ? 'TOOTHLESS — every check passes with no agent work' : 'ok'}` +
        (result.setup.length > 0 ? ` (setup ${Math.round(result.setupMs / 100) / 10} s)` : '')
    );
    for (const item of [...result.setup, ...result.checks]) {
      log(`  ${item.passed ? 'pass' : 'FAIL'}  ${item.id}`);
    }
    out.push(result);
  }
  return out;
}
