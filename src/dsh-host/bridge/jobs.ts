/**
 * The session's background jobs and the live output of its running commands
 * (dsh-rebase P1-7b; decisions 069, 072 rules 1 and 5, 099 rule 15, 119;
 * plan P1-7 shard 03 §4).
 *
 * DSH's job registry (`ctx.jobs`, dsh-jobs) holds every job a session owns:
 * `run_in_background` commands, one-shot background subagents, workflows —
 * and every foreground `bash` / `pwsh` call too, which DSH registers as a job
 * from its start and removes once the call collects it (a call that outlives
 * its timeout moves to the background as the same job). This module reads
 * that registry for one session:
 *
 *   `jobs` projection   the session's jobs as `DshJobSummary`s, minus the
 *                       foreground job a running call is still waiting on;
 *                       sent on each lifecycle change, at most once a second
 *   `tool.output`       the tail of a running foreground command's output,
 *                       read at the ring's absolute offsets (`readAt`, never
 *                       the model's cursor), at most four times a second
 *   `worker.job.kill`   DSH's own kill, fenced by the session's ownership
 *   `worker.job.read`   one job's output for the jobs window
 *
 * Which job a foreground call runs as: the bridge wraps `tools/execute` (the
 * same hook that stamps `execStartedAt`, decision 099 rule 15); while a
 * `bash` / `pwsh` call of the session's own agent is inside it, the job that
 * registers with the call's kind and its command as label is that call's —
 * DSH registers it synchronously inside the call, and bash and pwsh are
 * exclusive tools, so one agent runs one at a time (experiment E1 by
 * construction). A call asking for `run_in_background` is not waited on: its
 * job is a background job from the start.
 *
 * No value imports from DSH: the runtime hands the registry in.
 */

import { type DshJobSummary, TOOL_OUTPUT_TAIL_BYTES } from '../../shared/types/runtimeEvents.ts';
import {
  WORKER_JOB_READ_DEFAULT_BYTES,
  WORKER_JOB_READ_MAX_BYTES,
  WORKER_JOB_UNKNOWN,
  WORKER_JOBS_UNAVAILABLE,
  type WorkerJobKillResult,
  type WorkerJobReadResult,
} from '../../shared/types/workerRpc.ts';
import { PiWorkerSessionError } from './piWorkerErrors.ts';

// ---- the slice of dsh-jobs read here -------------------------------------------

/** `JobView` of `@deepseek-ai/dsh-jobs`, narrowed. */
export interface DshJobView {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly owner?: string;
  readonly status: string;
  readonly progress?: string;
  readonly detail?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly output?: {
    readonly total: number;
    readonly earliest: number;
    readonly spillPaths?: readonly string[];
  };
}

/** `JobEvent` of `@deepseek-ai/dsh-jobs`, narrowed. */
export type DshJobEvent =
  | { readonly type: 'registered' | 'progress' | 'stopping' | 'removed'; readonly job: DshJobView }
  | { readonly type: 'settled'; readonly job: DshJobView; readonly cause?: string }
  | {
      readonly type: 'output';
      readonly id: string;
      readonly owner?: string;
      readonly total: number;
    };

/** One chunk of a job's output ring. */
export interface DshJobChunk {
  readonly at: number;
  readonly text: string;
}

/**
 * `ctx.jobs` (dsh-jobs), narrowed. `list` is all `busy` needs; the rest is
 * P1-7b's, and optional so a host (or a test) without it still runs.
 */
export interface DshJobsView {
  list(caller?: string): Array<{ readonly owner?: string; readonly status: string }>;
  readonly events?: {
    subscribe(
      filter: { readonly owner: string },
      listener: (event: DshJobEvent) => void
    ): () => void;
  };
  get?(id: string, caller?: string): DshJobView;
  readAt?(
    id: string,
    from: number,
    caller?: string
  ): { readonly chunks: readonly DshJobChunk[]; readonly next: number; readonly lossy: boolean };
  kill?(id: string, caller?: string, reason?: string): 'requested' | 'already-finished';
}

/** The tools whose foreground calls DSH runs as jobs of the same name. */
export const SHELL_JOB_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh']);

/** Settled jobs the `jobs` projection keeps (plan P1-7 shard 03 §4: the newest few). */
export const JOBS_SETTLED_KEPT = 8;
/** At most one `jobs` projection per session and window. */
export const JOBS_PROJECTION_INTERVAL_MS = 1_000;
/** At most one `tool.output` per running command and window. */
export const TOOL_OUTPUT_INTERVAL_MS = 250;

/** The kill reason a job settles with when the jobs window stopped it. */
export const JOB_KILL_REASON = 'stopped by the user from the app';

/** What the runtime gives the tracker. */
export interface DshJobsHost {
  /** The session the jobs belong to: DSH's owner id. A rewind changes it. */
  owner(): string;
  registry(): DshJobsView | undefined;
  /** The `jobs` projection changed; the runtime sends it (or folds it into a waiting baseline). */
  projectJobs(jobs: DshJobSummary[]): void;
  /** New output of a running foreground call; the runtime names its row. */
  emitOutput(output: {
    toolCallId: string;
    jobId: string;
    tail: string;
    omittedBytes: number;
    totalBytes: number;
  }): void;
  log?(...args: unknown[]): void;
  now(): number;
}

interface CommandCall {
  readonly command: string;
  readonly kind: string;
  jobId?: string;
}

interface Throttle {
  lastAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

const JOB_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'stopping',
  'completed',
  'killed',
  'failed',
]);

function isLive(status: string): boolean {
  return status === 'running' || status === 'stopping';
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The text of `chunks` from absolute byte offset `from` on. The registry hands
 * out whole chunks, so the first may start before `from`: its head is cut in
 * bytes (a character a cut splits is dropped whole rather than garbled).
 */
export function ringText(
  chunks: readonly DshJobChunk[],
  from: number
): { text: string; at: number } {
  let text = '';
  let at: number | undefined;
  for (const chunk of chunks) {
    if (chunk.at >= from) {
      at ??= chunk.at;
      text += chunk.text;
      continue;
    }
    const bytes = Buffer.from(chunk.text, 'utf8');
    const end = chunk.at + bytes.length;
    if (end <= from) continue;
    let cut = from - chunk.at;
    // Skip continuation bytes so the text starts on a character.
    while (cut < bytes.length && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut += 1;
    at ??= chunk.at + cut;
    text += bytes.subarray(cut).toString('utf8');
  }
  return { text, at: at ?? from };
}

/** One registry view as the `jobs` projection carries it. */
export function jobSummaryOf(job: DshJobView, promoted: boolean): DshJobSummary | undefined {
  if (typeof job.id !== 'string' || !JOB_STATUSES.has(job.status)) return undefined;
  return {
    id: job.id,
    kind: String(job.kind),
    label: String(job.label ?? ''),
    status: job.status as DshJobSummary['status'],
    ...(job.progress ? { progress: job.progress } : {}),
    ...(job.detail ? { detail: job.detail } : {}),
    startedAt: job.startedAt,
    ...(typeof job.finishedAt === 'number' ? { finishedAt: job.finishedAt } : {}),
    ...(promoted ? { promoted: true as const } : {}),
  };
}

export class DshJobsTracker {
  private readonly host: DshJobsHost;
  private unsubscribe: (() => void) | null = null;
  private subscribedOwner = '';
  /** Foreground shell calls of the session's agent inside `tools/execute`, by call id. */
  private readonly calls = new Map<string, CommandCall>();
  /** A running foreground call's job -> the call. */
  private readonly foreground = new Map<string, string>();
  /** Jobs that were a call's foreground command before its timeout moved them to the background. */
  private readonly promoted = new Set<string>();
  private readonly outputThrottles = new Map<string, Throttle>();
  private readonly projection: Throttle = { lastAt: Number.NEGATIVE_INFINITY };
  /** The last `jobs` value handed to the runtime, as JSON. */
  private lastProjected = '[]';
  private disposed = false;

  constructor(host: DshJobsHost) {
    this.host = host;
  }

  /** Follow the registry for the session's current owner id; again after a rewind. */
  follow(): void {
    const owner = this.host.owner();
    if (this.disposed || !owner || owner === this.subscribedOwner) return;
    this.stopFollowing();
    const events = this.host.registry()?.events;
    if (!events) return;
    try {
      this.unsubscribe = events.subscribe({ owner }, (event) => {
        // Delivered inside the registry's commit; a throw here is contained there.
        try {
          this.onEvent(event);
        } catch (error) {
          this.host.log?.('[dsh-bridge] job event failed', event.type, error);
        }
      });
      this.subscribedOwner = owner;
    } catch (error) {
      this.host.log?.('[dsh-bridge] job events unavailable', error);
    }
  }

  private stopFollowing(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.subscribedOwner = '';
    this.calls.clear();
    this.foreground.clear();
    this.promoted.clear();
    for (const throttle of this.outputThrottles.values()) clearTimeout(throttle.timer);
    this.outputThrottles.clear();
    clearTimeout(this.projection.timer);
    this.projection.timer = undefined;
    this.lastProjected = '[]';
  }

  dispose(): void {
    this.stopFollowing();
    this.disposed = true;
  }

  // ---- the foreground call window (`tools/execute`) ---------------------------------

  /** A call of the session's agent entered `tools/execute`. */
  beginCall(callId: string, name: string, args: unknown): void {
    if (!SHELL_JOB_TOOLS.has(name)) return;
    const record = recordOf(args);
    const command = record?.command;
    if (typeof command !== 'string' || record?.run_in_background === true) return;
    this.calls.set(callId, { command, kind: name });
  }

  /**
   * The call left `tools/execute` with `value` (DSH's execution-local result):
   * a `promoted` command keeps running as its job, which the projection shows
   * from now on; any other end leaves nothing to follow for the row.
   */
  endCall(callId: string, value: unknown): void {
    const call = this.calls.get(callId);
    if (!call) return;
    this.calls.delete(callId);
    const jobId = call.jobId;
    if (!jobId) return;
    this.foreground.delete(jobId);
    const throttle = this.outputThrottles.get(jobId);
    clearTimeout(throttle?.timer);
    this.outputThrottles.delete(jobId);
    const result = recordOf(value);
    if (result?.kind === 'promoted' && result.jobId === jobId) this.promoted.add(jobId);
    this.refresh();
  }

  // ---- registry events ----------------------------------------------------------------

  private onEvent(event: DshJobEvent): void {
    const owner = this.subscribedOwner;
    if (event.type === 'output') {
      if (event.owner !== undefined && event.owner !== owner) return;
      if (this.foreground.has(event.id)) this.scheduleOutput(event.id);
      return;
    }
    if (event.job.owner !== owner) return;
    if (event.type === 'registered') this.attach(event.job);
    if (event.type === 'removed') {
      this.foreground.delete(event.job.id);
      this.promoted.delete(event.job.id);
    }
    this.refresh();
  }

  /** A shell job that registered while its call waits in `tools/execute` is that call's. */
  private attach(job: DshJobView): void {
    if (!SHELL_JOB_TOOLS.has(job.kind)) return;
    for (const [callId, call] of this.calls) {
      if (call.jobId || call.kind !== job.kind || call.command !== job.label) continue;
      call.jobId = job.id;
      this.foreground.set(job.id, callId);
      return;
    }
  }

  // ---- the `jobs` projection ------------------------------------------------------------

  /**
   * The session's jobs now: registration order, the newest
   * {@link JOBS_SETTLED_KEPT} settled ones, never a job a running call waits on.
   */
  current(): DshJobSummary[] {
    const owner = this.host.owner();
    const registry = this.host.registry();
    if (!owner || !registry) return [];
    let views: DshJobView[];
    try {
      views = registry.list(owner) as DshJobView[];
    } catch (error) {
      this.host.log?.('[dsh-bridge] job list unreadable', error);
      return [];
    }
    const own = views.filter((job) => job.owner === owner && !this.foreground.has(job.id));
    const settled = own.filter((job) => !isLive(job.status));
    const dropped = new Set(
      settled
        .slice()
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
        .slice(JOBS_SETTLED_KEPT)
        .map((job) => job.id)
    );
    return own
      .filter((job) => !dropped.has(job.id))
      .map((job) => jobSummaryOf(job, this.promoted.has(job.id)))
      .filter((job): job is DshJobSummary => job !== undefined);
  }

  /**
   * The projection after a change: sent at once when the last one went out a
   * window ago, else once at the end of the window, with whatever is current then.
   */
  private refresh(): void {
    if (this.disposed) return;
    const throttle = this.projection;
    if (throttle.timer) return;
    const wait = throttle.lastAt + JOBS_PROJECTION_INTERVAL_MS - this.host.now();
    if (wait <= 0) {
      this.sendProjection();
      return;
    }
    throttle.timer = setTimeout(() => {
      throttle.timer = undefined;
      this.sendProjection();
    }, wait);
  }

  private sendProjection(): void {
    if (this.disposed) return;
    const jobs = this.current();
    const json = JSON.stringify(jobs);
    if (json === this.lastProjected) return;
    this.lastProjected = json;
    this.projection.lastAt = this.host.now();
    // Also reached from a timer, where nothing else would contain a throw.
    try {
      this.host.projectJobs(jobs);
    } catch (error) {
      this.host.log?.('[dsh-bridge] jobs projection failed', error);
    }
  }

  /** The baseline knows what it sent: later changes compare against it. */
  noteProjected(jobs: readonly DshJobSummary[]): void {
    this.lastProjected = JSON.stringify(jobs);
  }

  // ---- live output of a running call ------------------------------------------------------

  private scheduleOutput(jobId: string): void {
    let throttle = this.outputThrottles.get(jobId);
    if (!throttle) {
      throttle = { lastAt: Number.NEGATIVE_INFINITY };
      this.outputThrottles.set(jobId, throttle);
    }
    if (throttle.timer) return;
    const wait = throttle.lastAt + TOOL_OUTPUT_INTERVAL_MS - this.host.now();
    if (wait <= 0) {
      this.sendOutput(jobId, throttle);
      return;
    }
    const pending = throttle;
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      this.sendOutput(jobId, pending);
    }, wait);
  }

  private sendOutput(jobId: string, throttle: Throttle): void {
    const callId = this.foreground.get(jobId);
    if (!callId || this.disposed) return;
    throttle.lastAt = this.host.now();
    // Also reached from a timer, where nothing else would contain a throw (a
    // job the registry already dropped, a host going down).
    try {
      const read = this.readTail(jobId, TOOL_OUTPUT_TAIL_BYTES);
      if (!read) return;
      this.host.emitOutput({
        toolCallId: callId,
        jobId,
        tail: read.text,
        omittedBytes: read.from,
        totalBytes: read.next,
      });
    } catch (error) {
      this.host.log?.('[dsh-bridge] live output unreadable', jobId, error);
    }
  }

  /** The newest `maxBytes` of a job's output, or its output after `from`, newest `maxBytes` at most. */
  private readTail(
    jobId: string,
    maxBytes: number,
    from?: number
  ): WorkerJobReadResult | undefined {
    const owner = this.host.owner();
    const registry = this.host.registry();
    if (!registry?.get || !registry.readAt) return undefined;
    const view = registry.get(jobId, owner);
    const total = view.output?.total ?? 0;
    const earliest = view.output?.earliest ?? 0;
    const asked = from ?? 0;
    const start = Math.max(asked, earliest, total - maxBytes, 0);
    const read = registry.readAt(jobId, start, owner);
    const { text, at } = ringText(read.chunks, start);
    const spillPaths = view.output?.spillPaths?.filter((path) => typeof path === 'string');
    return {
      text,
      from: at,
      next: read.next,
      omittedBytes: Math.max(0, at - asked),
      lossy: read.lossy || (from !== undefined && from < earliest),
      ...(spillPaths && spillPaths.length > 0 ? { spillPaths: [...spillPaths] } : {}),
    };
  }

  // ---- the jobs window's requests ----------------------------------------------------------

  /** `worker.job.read`: a job of this session, read without moving the model's cursor. */
  read(jobId: string, from: number | undefined, maxBytes?: number): WorkerJobReadResult {
    const budget = Math.min(maxBytes ?? WORKER_JOB_READ_DEFAULT_BYTES, WORKER_JOB_READ_MAX_BYTES);
    let result: WorkerJobReadResult | undefined;
    try {
      result = this.readTail(jobId, budget, from);
    } catch (error) {
      throw new PiWorkerSessionError(
        WORKER_JOB_UNKNOWN,
        `No job ${jobId} of this session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!result) {
      throw new PiWorkerSessionError(WORKER_JOBS_UNAVAILABLE, 'This host has no job registry');
    }
    return result;
  }

  /** `worker.job.kill`: DSH's own kill; the job settles `killed` once its work stops. */
  kill(jobId: string, reason = JOB_KILL_REASON): WorkerJobKillResult {
    const registry = this.host.registry();
    if (!registry?.kill) {
      throw new PiWorkerSessionError(WORKER_JOBS_UNAVAILABLE, 'This host has no job registry');
    }
    try {
      return { outcome: registry.kill(jobId, this.host.owner(), reason) };
    } catch (error) {
      throw new PiWorkerSessionError(
        WORKER_JOB_UNKNOWN,
        `No job ${jobId} of this session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Decision 069 rule 1: a Stop ends the session's one-shot background
   * subagents (kind `subagent`) — never its commands, which the window shows
   * and stops one by one. Returns the jobs asked to stop.
   */
  stopSubagentJobs(reason: string): string[] {
    const registry = this.host.registry();
    const owner = this.host.owner();
    if (!registry?.kill || !owner) return [];
    const stopped: string[] = [];
    let views: DshJobView[];
    try {
      views = registry.list(owner) as DshJobView[];
    } catch {
      return [];
    }
    for (const job of views) {
      if (job.owner !== owner || job.kind !== 'subagent' || job.status !== 'running') continue;
      try {
        registry.kill(job.id, owner, reason);
        stopped.push(job.id);
      } catch (error) {
        this.host.log?.('[dsh-bridge] subagent job not stopped', job.id, error);
      }
    }
    return stopped;
  }
}
