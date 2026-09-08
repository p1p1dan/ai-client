/**
 * Structured run traces — engineering standard §2, §11 and §15.
 *
 * Every run writes one JSON object: what went in, which model and config
 * version answered, the ordered steps, the usage numbers, and what came out.
 * The point is stated in §2 and §11: a bug is reconstructed from the trace, and
 * another agent can read it without being handed the schema. So the field names
 * are §2's snake_case, not this repo's camelCase, and nothing here is a summary
 * — the numbers are pi's own, unaggregated.
 *
 * ## Why usage is recorded raw
 *
 * ARD D9 makes cache hit rate `cacheRead / (input + cacheRead)` a gate at P2-5,
 * and requires a BASELINE captured while the old backend still exists. The
 * cheapest way to be ready for that is to persist pi's `Usage` verbatim from
 * P0's first run, so P2-0/P2-6 can compute the ratio from stored traces rather
 * than needing a new measurement pass. `src/shared/piTurnRollup.ts` already
 * accumulates the same three fields on the legacy side.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Usage } from '@earendil-works/pi-ai';
import type { Context } from 'cordis';
import { Service } from 'cordis';
import {
  type RunTrace,
  TRACE_SERVICE,
  type TraceRun,
  type TraceService,
  type TraceStep,
} from './contracts.ts';

export interface TracePluginConfig {
  /** Absolute directory for `runs.jsonl`. `null` keeps traces in memory only. */
  dir: string | null;
  /** Merged into every trace's `version_stamp`. */
  versionStamp: Record<string, string>;
  now?: () => number;
  /** Injectable so a test can assert on ids without matching a uuid. */
  newRunId?: () => string;
}

export class TracePlugin extends Service implements TraceService {
  readonly dir: string | null;
  private readonly versionStamp: Record<string, string>;
  private readonly now: () => number;
  private readonly newRunId: () => string;
  private readonly _runs: RunTrace[] = [];

  constructor(ctx: Context, config: TracePluginConfig) {
    super(ctx, TRACE_SERVICE);
    this.dir = config.dir;
    this.versionStamp = config.versionStamp;
    this.now = config.now ?? (() => Date.now());
    this.newRunId = config.newRunId ?? (() => `run_${crypto.randomUUID()}`);
    if (this.dir) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  get runs(): readonly RunTrace[] {
    return this._runs;
  }

  begin(input: { runId?: string; input: string; model: string; provider: string }): TraceRun {
    const startedAt = this.now();
    const steps: TraceStep[] = [];
    const trace: RunTrace = {
      run_id: input.runId ?? this.newRunId(),
      timestamp: new Date(startedAt).toISOString(),
      input: input.input,
      model: input.model,
      provider: input.provider,
      config_version: this.versionStamp.config_version ?? 'p0',
      steps,
      final_output: '',
      usage: null,
      latency_ms: 0,
      success: false,
      version_stamp: this.versionStamp,
    };
    const sink = this;
    return {
      runId: trace.run_id,
      note(type, detail) {
        steps.push({
          step: steps.length + 1,
          type,
          at: new Date(sink.now()).toISOString(),
          detail,
        });
      },
      finish(outcome: {
        final_output: string;
        usage: Usage | null;
        success: boolean;
        error?: { code: string; message: string };
      }): RunTrace {
        trace.final_output = outcome.final_output;
        trace.usage = outcome.usage;
        trace.success = outcome.success;
        if (outcome.error) trace.error = outcome.error;
        trace.latency_ms = sink.now() - startedAt;
        sink._runs.push(trace);
        sink.persist(trace);
        return trace;
      },
    };
  }

  /**
   * Append-only JSONL, one run per line.
   *
   * A write failure is swallowed on purpose: a trace is an observation of the
   * run, and losing the observation must never turn a working turn into a
   * failed one. The loss is still visible — `runs` holds the trace in memory,
   * and the file simply has fewer lines than the process produced.
   */
  private persist(trace: RunTrace): void {
    if (!this.dir) return;
    try {
      appendFileSync(join(this.dir, 'runs.jsonl'), `${JSON.stringify(trace)}\n`, { mode: 0o600 });
    } catch {
      // Intentionally ignored — see above.
    }
  }
}

/**
 * §15's "accountable version stamp": what was actually running.
 *
 * Cheap by construction — one `package.json` read and one `.git/HEAD` walk, no
 * subprocess. `git rev-parse` would be the obvious way to get the commit, but
 * this runs inside a utility worker on a user's machine, where spawning a
 * process per run is both slower and a thing the sandbox may refuse.
 */
export function buildVersionStamp(options: {
  repoRoot: string;
  configVersion: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  const packageJsonPath = join(fileURLToPath(new URL('.', import.meta.url)), 'package.json');
  const pins: Record<string, string> = {};
  try {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      pins[`dep:${name}`] = range;
    }
  } catch {
    pins['dep:unreadable'] = 'true';
  }
  return {
    config_version: options.configVersion,
    git_commit: readGitCommit(options.repoRoot) ?? 'unknown',
    node: process.version,
    ...pins,
    ...(options.extra ?? {}),
  };
}

/**
 * The checked-out commit, read straight off disk.
 *
 * Handles the linked-worktree layout explicitly, because runtime development
 * happens in one (`feat/runtime-evolution`): there `.git` is a FILE holding
 * `gitdir: <path>`, and a reader that only understands the directory layout
 * would stamp every trace `unknown` — which is precisely the "it worked
 * yesterday, why not today?" that §15 exists to end.
 */
function readGitCommit(repoRoot: string): string | null {
  try {
    const gitPath = join(repoRoot, '.git');
    const gitDir = statSync(gitPath).isDirectory()
      ? gitPath
      : readFileSync(gitPath, 'utf8')
          .trim()
          .replace(/^gitdir:\s*/, '');
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head;
    const ref = head.slice(4).trim();
    // A worktree's refs live in the SHARED gitdir, not the per-worktree one, so
    // `commondir` is followed when present.
    const commonDir = readCommonDir(gitDir);
    return readFileSync(join(commonDir, ref), 'utf8').trim();
  } catch {
    // No repository at all in a packaged build. Not worth failing a run over;
    // the stamp says `unknown` and the rest of the trace stays usable.
    return null;
  }
}

function readCommonDir(gitDir: string): string {
  try {
    const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    return common.startsWith('/') ? common : join(gitDir, common);
  } catch {
    return gitDir;
  }
}
