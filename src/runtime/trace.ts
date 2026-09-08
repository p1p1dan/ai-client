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

import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Usage } from '@earendil-works/pi-ai';
import type { Context } from 'cordis';
import { Service } from 'cordis';
import {
  HOST_IO_SERVICE,
  type RunTrace,
  type RuntimeHostIoService,
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
  io: RuntimeHostIoService;
}

export class TracePlugin extends Service implements TraceService {
  static inject = [HOST_IO_SERVICE];
  readonly dir: string | null;
  private readonly versionStamp: Record<string, string>;
  private readonly now: () => number;
  private readonly newRunId: () => string;
  private readonly io: RuntimeHostIoService;
  private persistenceError?: Error;
  private pending: Promise<void> = Promise.resolve();
  private readonly _runs: RunTrace[] = [];

  constructor(ctx: Context, config: TracePluginConfig) {
    super(ctx, TRACE_SERVICE);
    this.dir = config.dir;
    this.versionStamp = config.versionStamp;
    this.now = config.now ?? (() => Date.now());
    this.newRunId = config.newRunId ?? (() => `run_${crypto.randomUUID()}`);
    this.io = config.io;
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
      async finish(outcome: {
        final_output: string;
        usage: Usage | null;
        success: boolean;
        error?: { code: string; message: string };
      }): Promise<RunTrace> {
        trace.final_output = outcome.final_output;
        trace.usage = outcome.usage;
        trace.success = outcome.success;
        if (outcome.error) trace.error = outcome.error;
        trace.latency_ms = sink.now() - startedAt;
        sink._runs.push(trace);
        await sink.persist(trace);
        return trace;
      },
    };
  }

  // Persistence failures stay separate from model outcomes and are surfaced by flush.
  async flush(): Promise<void> {
    await this.pending;
    if (this.persistenceError) throw this.persistenceError;
  }

  private async persist(trace: RunTrace): Promise<void> {
    if (!this.dir) return;
    const path = join(this.dir, 'runs.jsonl');
    const work = this.pending.then(() =>
      this.io.appendFile(path, Buffer.from(`${JSON.stringify(trace)}\n`), { mode: 0o600 })
    );
    this.pending = work.catch(() => {});
    try {
      await work;
    } catch (error) {
      this.persistenceError = error instanceof Error ? error : new Error(String(error));
      trace.persistence_error = {
        code: 'trace_write_failed',
        message: this.persistenceError.message,
      };
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
export async function buildVersionStamp(options: {
  io: RuntimeHostIoService;
  repoRoot: string;
  configVersion: string;
  extra?: Record<string, string>;
}): Promise<Record<string, string>> {
  const packageJsonPath = join(fileURLToPath(new URL('.', import.meta.url)), 'package.json');
  const pins: Record<string, string> = {};
  try {
    const manifest = JSON.parse(await readText(options.io, packageJsonPath)) as {
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
    git_commit: (await readGitCommit(options.repoRoot, options.io)) ?? 'unknown',
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
async function readGitCommit(repoRoot: string, io: RuntimeHostIoService): Promise<string | null> {
  try {
    const gitPath = join(repoRoot, '.git');
    const gitDir =
      (await io.stat(gitPath)).kind === 'directory'
        ? gitPath
        : resolve(repoRoot, (await readText(io, gitPath)).trim().replace(/^gitdir:\s*/, ''));
    const head = (await readText(io, join(gitDir, 'HEAD'))).trim();
    if (!head.startsWith('ref:')) return head;
    const ref = head.slice(4).trim();
    // A worktree's refs live in the SHARED gitdir, not the per-worktree one, so
    // `commondir` is followed when present.
    const commonDir = await readCommonDir(gitDir, io);
    return (await readText(io, join(commonDir, ref))).trim();
  } catch {
    // No repository at all in a packaged build. Not worth failing a run over;
    // the stamp says `unknown` and the rest of the trace stays usable.
    return null;
  }
}

async function readCommonDir(gitDir: string, io: RuntimeHostIoService): Promise<string> {
  try {
    const common = (await readText(io, join(gitDir, 'commondir'))).trim();
    return isAbsolute(common) ? common : join(gitDir, common);
  } catch {
    return gitDir;
  }
}

async function readText(io: RuntimeHostIoService, path: string): Promise<string> {
  return Buffer.from(
    (await io.readFile(path, { maxBytes: 1024 * 1024, overflow: 'error' })).bytes
  ).toString('utf8');
}
