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

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
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
import { errorCode } from './host/errors.ts';

/**
 * Ceiling for one `runs.jsonl` before it is rotated, and how many rotated
 * generations are kept beside it. Total on disk is bounded by
 * `(TRACE_FILE_GENERATIONS + 1) * TRACE_FILE_MAX_BYTES` — 32 MiB at these
 * values, the same order as one session file, which is the number the capacity
 * reconciliation budgets against.
 */
export const TRACE_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const TRACE_FILE_GENERATIONS = 3;
/**
 * permissions-12 — ceilings for `runs`, the in-memory mirror of what was
 * written. Two of them because either one alone is escapable: a hundred runs of
 * a one-line prompt are nothing, and one run that read a large file is not
 * bounded by a count at all.
 */
export const TRACE_MEMORY_MAX_RUNS = 100;
export const TRACE_MEMORY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * concurrency-03 / capacity-05 — the sidecar that makes one trace directory
 * one writer at a time.
 *
 * `AICLIENT_RUNTIME_TRACE_DIR` is read from the environment and every worker
 * inherits it, so a forensic run has as many writers of `runs.jsonl` as it has
 * sessions. The promise chain inside `persist` serializes this process and says
 * so; across processes nothing did, and two workers that cross the ceiling
 * together each ran a full set of renames — the second one shifting the
 * generation the first had just moved, retiring it a cycle early and leaving a
 * hole where readers count backwards from `runs.1.jsonl`.
 */
const ROTATE_LOCK_NAME = 'runs.rotate.lock';
/**
 * How long the rotation lock can plausibly be held: a few renames and one
 * append. Anything older was stranded by a crash and is dropped, because a lock
 * nobody clears would stop this directory rotating for good.
 */
const ROTATE_LOCK_MAX_AGE_MS = 30_000;
/** Total time a run waits for a peer's rotation before giving up on its own. */
const ROTATE_LOCK_WAIT_MS = 250;
const ROTATE_LOCK_POLL_MS = 25;
/** A lock file is one small JSON object; anything bigger is not one of ours. */
const ROTATE_LOCK_MAX_BYTES = 4096;

export interface TracePluginConfig {
  /** Absolute directory for `runs.jsonl`. `null` keeps traces in memory only. */
  dir: string | null;
  /** Merged into every trace's `version_stamp`. */
  versionStamp: Record<string, string>;
  now?: () => number;
  /** Injectable so a test can assert on ids without matching a uuid. */
  newRunId?: () => string;
  io: RuntimeHostIoService;
  /** Bytes one `runs.jsonl` may reach before rotating. `0` disables rotation. */
  maxFileBytes?: number;
  /** Rotated generations kept: `runs.1.jsonl` … `runs.<n>.jsonl`. `0` deletes instead. */
  fileGenerations?: number;
  /** Ceilings for the in-memory mirror; the newest run is never evicted. */
  maxMemoryRuns?: number;
  maxMemoryBytes?: number;
  /**
   * How long to wait for another process's rotation of this directory. `0`
   * means one attempt, which is what a test wanting a deterministic loser sets.
   */
  rotationLockWaitMs?: number;
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
  /** Serialized size of each entry in `_runs`, same order. */
  private readonly runSizes: number[] = [];
  private runsBytes = 0;
  private _evictedRuns = 0;
  private readonly maxFileBytes: number;
  private readonly fileGenerations: number;
  private readonly maxMemoryRuns: number;
  private readonly maxMemoryBytes: number;
  private readonly rotationLockWaitMs: number;

  constructor(ctx: Context, config: TracePluginConfig) {
    super(ctx, TRACE_SERVICE);
    this.dir = config.dir;
    this.versionStamp = config.versionStamp;
    this.now = config.now ?? (() => Date.now());
    this.newRunId = config.newRunId ?? (() => `run_${crypto.randomUUID()}`);
    this.io = config.io;
    this.maxFileBytes = config.maxFileBytes ?? TRACE_FILE_MAX_BYTES;
    this.fileGenerations = config.fileGenerations ?? TRACE_FILE_GENERATIONS;
    this.maxMemoryRuns = config.maxMemoryRuns ?? TRACE_MEMORY_MAX_RUNS;
    this.maxMemoryBytes = config.maxMemoryBytes ?? TRACE_MEMORY_MAX_BYTES;
    this.rotationLockWaitMs = config.rotationLockWaitMs ?? ROTATE_LOCK_WAIT_MS;
  }

  get runs(): readonly RunTrace[] {
    return this._runs;
  }

  /**
   * How many runs `runs` has dropped to stay inside its ceilings.
   *
   * Non-zero means the mirror is no longer the whole session, which an
   * in-process assertion over `runs` has to know before it concludes "that run
   * never happened". The file is the complete record; this array is not.
   */
  get evictedRuns(): number {
    return this._evictedRuns;
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
        // Serialized once and reused: the line that goes to disk is also what
        // the memory ceiling is measured in, so the two can never disagree
        // about how big this run was.
        const line = Buffer.from(`${JSON.stringify(trace)}\n`);
        sink.remember(trace, line.byteLength);
        await sink.persist(trace, line);
        return trace;
      },
    };
  }

  // Persistence failures stay separate from model outcomes and are surfaced by flush.
  async flush(): Promise<void> {
    await this.pending;
    if (this.persistenceError) throw this.persistenceError;
  }

  /**
   * permissions-12 — keep `runs` bounded, newest wins.
   *
   * Without this the array is a second, unbounded copy of every trace the
   * process ever wrote: prompts, step details and final answers all stay
   * reachable for the life of the worker, and a long session pays for it in
   * resident memory with nothing reading it. Eviction is oldest-first because
   * the run anybody asks about is the last one; the complete record is the
   * file, and `evictedRuns` says when the array stopped being it.
   */
  private remember(trace: RunTrace, bytes: number): void {
    this._runs.push(trace);
    this.runSizes.push(bytes);
    this.runsBytes += bytes;
    while (
      // The newest run survives whatever its size: dropping the trace of the
      // run that just finished would defeat the point of keeping any.
      this._runs.length > 1 &&
      (this._runs.length > this.maxMemoryRuns || this.runsBytes > this.maxMemoryBytes)
    ) {
      this._runs.shift();
      this.runsBytes -= this.runSizes.shift() ?? 0;
      this._evictedRuns++;
    }
  }

  private async persist(trace: RunTrace, line: Buffer): Promise<void> {
    if (!this.dir) return;
    const dir = this.dir;
    const path = join(dir, 'runs.jsonl');
    const work = this.pending.then(async () => {
      // Rotation runs inside the same serialized chain as the append, so a
      // rename can never land between another run's size check and its write.
      // Across processes the same guarantee is the directory lock: it spans the
      // rotation AND the append, so a peer cannot append into a file this run
      // is about to move, and cannot start its own set of renames halfway
      // through ours.
      const guard = await this.lockRotation(dir);
      let rotation: Error | undefined;
      try {
        if (guard.token !== undefined) rotation = await this.rotate(dir, path, line.byteLength);
        // Losing the lock to a live peer is not a failure: it is rotating right
        // now, so this run appends and the next one finds the fresh file. A
        // lock we could not even attempt is a failure, and only matters while
        // there is a ceiling to enforce.
        else if (guard.error && this.maxFileBytes > 0)
          rotation = new RotationError(guard.error.message);
        await this.io.appendFile(path, line, { mode: 0o600 });
      } finally {
        await this.unlockRotation(dir, guard.token);
      }
      // Reported only after the trace is safely on disk. Housekeeping that
      // failed must not cost the run its record, but it also must not stay
      // invisible — an unrotatable directory grows without bound.
      if (rotation) throw rotation;
    });
    this.pending = work.catch(() => {});
    try {
      await work;
    } catch (error) {
      this.persistenceError = error instanceof Error ? error : new Error(String(error));
      trace.persistence_error = {
        code: error instanceof RotationError ? 'trace_rotate_failed' : 'trace_write_failed',
        message: this.persistenceError.message,
      };
    }
  }

  /**
   * Bound `runs.jsonl` by renaming it, not by rewriting it.
   *
   * The file is append-only JSONL, and the two obvious alternatives both cost
   * more than they are worth inside a worker: dropping the oldest lines means
   * reading and rewriting the whole file on every run, and truncating in place
   * cuts a line in half and leaves the remainder unparseable. A rename is one
   * cheap step, it keeps recent history readable in `runs.1.jsonl`, and a
   * reader only needs to know that older runs live in higher-numbered files.
   *
   * The size is read from disk rather than counted in process, because the file
   * outlives the process — a fresh worker appending to yesterday's 8 MiB file
   * would otherwise believe it was empty.
   *
   * Returns the failure instead of throwing it, so the caller can still write.
   */
  private async rotate(dir: string, path: string, incoming: number): Promise<Error | undefined> {
    if (this.maxFileBytes <= 0) return undefined;
    try {
      const size = await this.size(path);
      // A line larger than the whole budget is still written whole: a trace
      // split across generations is worse than one oversized file, and the
      // next run rotates it away.
      if (size === 0 || size + incoming <= this.maxFileBytes) return undefined;
      if (this.fileGenerations <= 0) {
        await this.remove(path);
        return undefined;
      }
      // Oldest first, so nothing is overwritten before it has been shifted up.
      // `rename` replaces the destination, which is what retires generation N.
      for (let index = this.fileGenerations; index >= 1; index--) {
        const from = index === 1 ? path : join(dir, `runs.${index - 1}.jsonl`);
        await this.move(from, join(dir, `runs.${index}.jsonl`));
      }
      return undefined;
    } catch (error) {
      return new RotationError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Hold this directory against the other workers writing to it.
   *
   * `createOnly` is the exclusion; the wait is there because the alternative to
   * waiting is skipping the rotation, and a directory whose workers always
   * arrive together would then never rotate at all. A lock held by a live
   * process is respected, one older than any real rotation is dropped — by
   * rename, so that two workers clearing the same debris cannot both go on to
   * create it.
   *
   * Returns no token when the lock is busy or unusable. Nothing here ever
   * throws: the trace has to reach disk even when the housekeeping around it
   * cannot.
   */
  private async lockRotation(dir: string): Promise<{ token?: string; error?: Error }> {
    const path = join(dir, ROTATE_LOCK_NAME);
    const token = randomUUID();
    // `Date.now()`, never the injected clock: a test that freezes time to make
    // trace ids stable would otherwise date every lock to the epoch and read
    // its own as debris.
    const deadline = Date.now() + this.rotationLockWaitMs;
    try {
      for (;;) {
        const record = Buffer.from(
          JSON.stringify({ pid: process.pid, host: hostname(), token, acquiredAt: Date.now() })
        );
        try {
          await this.io.writeFile(path, record, { createOnly: true, mode: 0o600 });
          return { token };
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
        }
        if (await this.dropStrandedLock(path)) continue;
        if (Date.now() >= deadline) return {};
        await new Promise((resolve) => setTimeout(resolve, ROTATE_LOCK_POLL_MS));
      }
    } catch (error) {
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /** Whether the lock at `path` was debris, and has been cleared. */
  private async dropStrandedLock(path: string): Promise<boolean> {
    let owner: { pid?: unknown; host?: unknown; acquiredAt?: unknown };
    try {
      const read = await this.io.readFile(path, {
        maxBytes: ROTATE_LOCK_MAX_BYTES,
        overflow: 'truncate',
      });
      owner = read.truncated ? {} : (JSON.parse(Buffer.from(read.bytes).toString('utf8')) ?? {});
    } catch (error) {
      // Released between our create and our read: the next attempt takes it.
      if (errorCode(error) === 'ENOENT') return true;
      owner = {};
    }
    const acquiredAt = typeof owner.acquiredAt === 'number' ? owner.acquiredAt : undefined;
    const fresh = acquiredAt !== undefined && Date.now() - acquiredAt <= ROTATE_LOCK_MAX_AGE_MS;
    const local = typeof owner.host !== 'string' || owner.host === hostname();
    if (fresh && (!local || alive(owner.pid))) return false;
    const aside = `${path}.${randomUUID()}.stale`;
    try {
      await this.io.rename(path, aside);
    } catch (error) {
      // Someone else cleared it first; either way the name is free to retry.
      if (errorCode(error) !== 'ENOENT') throw error;
      return true;
    }
    await this.remove(aside);
    return true;
  }

  /** Give the lock back, unless a later holder already replaced it. */
  private async unlockRotation(dir: string, token: string | undefined): Promise<void> {
    if (token === undefined) return;
    const path = join(dir, ROTATE_LOCK_NAME);
    try {
      const read = await this.io.readFile(path, {
        maxBytes: ROTATE_LOCK_MAX_BYTES,
        overflow: 'truncate',
      });
      const held = JSON.parse(Buffer.from(read.bytes).toString('utf8')) as { token?: unknown };
      if (held.token !== token) return;
      await this.remove(path);
    } catch {
      // A lock we cannot read or delete ages out on its own; failing the run
      // over it would cost the trace we just wrote.
    }
  }

  private async size(path: string): Promise<number> {
    try {
      return (await this.io.stat(path)).size;
    } catch (error) {
      // Nothing written yet is the normal first-run state, not a failure.
      if (errorCode(error) === 'ENOENT') return 0;
      throw error;
    }
  }

  private async move(from: string, to: string): Promise<void> {
    try {
      await this.io.rename(from, to);
    } catch (error) {
      // A generation that does not exist yet is the normal state until the
      // file has rotated that many times.
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  private async remove(path: string): Promise<void> {
    try {
      await this.io.unlink(path);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}

/**
 * Whether the pid recorded in a rotation lock is still running.
 *
 * `EPERM` counts as alive: the process exists, it just belongs to another user.
 * Signal `0` only asks the question, it delivers nothing.
 */
function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/** Marks a failure of trace housekeeping, as opposed to a lost trace. */
class RotationError extends Error {
  constructor(message: string) {
    super(`runs.jsonl rotation failed: ${message}`);
    this.name = 'RotationError';
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
