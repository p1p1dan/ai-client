/**
 * P5-2-2 — the session's delegation registry.
 *
 * Provenance: the `DelegationRecord` shape, the caps and the wait semantics are
 * PI-Desktop's, from `packages/agent-runtime/src/runtime.ts` (220–350 and
 * 2850–3330) at `948ee676`. Pulled out of the runtime class into its own module
 * because here it has to be testable without a provider, a session or a host:
 * the concurrency gate, the pruning rule and the wait predicate are the parts
 * that fail as races, and a race you can only reach through a live model is a
 * race you cannot regress.
 *
 * The registry owns three things and nothing else:
 *
 * - **Admission.** Ten running delegates per session, with the eleventh
 *   refused by name rather than silently queued.
 * - **Settlement.** A record moves out of `running` exactly once, and everyone
 *   waiting on it wakes.
 * - **Retention.** A settled record stays readable by id, so re-reading a
 *   report is free and never re-runs the work.
 */

import type { SubagentRunResult, SubagentRunStatus } from './run.ts';

/** Running delegates per session, across batches. */
export const MAX_SUBAGENT_CONCURRENCY = 10;
/** Settled records kept for re-reading. Running records are never evicted. */
export const MAX_RETAINED_DELEGATIONS = 100;

export type DelegationStatus = 'running' | SubagentRunStatus;

/**
 * Why a delegate was asked to stop, as the terminal status it should settle in.
 *
 * The delegate's own loop only sees an `AbortSignal`, which says THAT it was
 * cancelled and never WHY. Without this the run could only ever report
 * `aborted`, so "you stopped this" and "this never converged after being asked
 * to" arrived at the reader — and at the parent model — as the same sentence.
 */
export type DelegationCancelReason = Extract<SubagentRunStatus, 'stopped' | 'timed_out'>;

export interface DelegationRecord {
  delegationId: string;
  agentName: string;
  /** The short label the model gave this delegation, for display. */
  label?: string;
  status: DelegationStatus;
  startedAt: number;
  completedAt?: number;
  result?: SubagentRunResult;
  /** Resolves when the delegate settles. */
  completion: Promise<void>;
  /** Stops the delegate's agent. Idempotent. */
  abort: () => void;
  /**
   * True when `TaskStop` asked for this stop, so an aborted run reads as
   * `stopped` rather than `aborted`. The distinction is what lets a transcript
   * say "you stopped this" instead of "this broke".
   */
  stopRequested: boolean;
  /**
   * The terminal status the stop asked for, read by the delegate's own run once
   * its loop has closed. Absent until something asks it to stop.
   */
  cancelReason?: DelegationCancelReason;
  /**
   * When this delegation's outcome was handed to the parent model.
   *
   * The stable delivery marker the P5-2 contract asks for, and it exists
   * because "still running" is NOT a usable proxy for "not yet reported". A
   * delegate that finishes while the parent is still working is already out of
   * the running set by the time the parent goes idle, so a resume pass that
   * only looked at running delegations would drop its report on the floor —
   * measured, not theorised: that is what the SA07 case caught. Conversely a
   * report the parent already read through `TaskWait` must not be delivered a
   * second time and integrated twice.
   *
   * Set by whatever puts the outcome in front of the model: the auto-resume
   * pass, `TaskWait` for the targets that had settled, and `TaskStop` for the
   * ones it stopped and reported on. `TaskList` does NOT set it — a heartbeat
   * is a status line, not a report.
   */
  deliveredAt?: number;
  turns: number;
  toolCalls: number;
  lastToolName?: string;
  lastActivityAt: number;
}

export interface DelegationSummary {
  delegationId: string;
  agent: string;
  label?: string;
  status: DelegationStatus;
  startedAt: number;
  completedAt?: number;
  turns: number;
  toolCalls: number;
  lastToolName?: string;
  error?: { code: string; message: string };
}

export function delegationSummary(record: DelegationRecord): DelegationSummary {
  return {
    delegationId: record.delegationId,
    agent: record.agentName,
    ...(record.label ? { label: record.label } : {}),
    status: record.status,
    startedAt: record.startedAt,
    // The settled result is authoritative once it exists: the live counters
    // stop moving at settlement, and a heartbeat read afterwards must not
    // report a smaller number than the final one.
    turns: record.result?.turns ?? record.turns,
    toolCalls: record.result?.toolCalls ?? record.toolCalls,
    ...(record.lastToolName ? { lastToolName: record.lastToolName } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.result?.error ? { error: record.result.error } : {}),
  };
}

export function elapsedSeconds(record: DelegationRecord, now: number): number {
  const end = record.completedAt ?? now;
  return Math.max(1, Math.round((end - record.startedAt) / 1000));
}

/** One line of live status for the model, cheap enough to repeat. */
export function formatDelegationHeartbeat(record: DelegationRecord, now: number): string {
  const parts = [
    `${record.agentName} (${record.delegationId})`,
    record.status,
    `${elapsedSeconds(record, now)}s`,
  ];
  const turns = record.result?.turns ?? record.turns;
  const toolCalls = record.result?.toolCalls ?? record.toolCalls;
  if (turns > 0) parts.push(`${turns} turns`);
  if (toolCalls > 0) parts.push(`${toolCalls} tool calls`);
  if (record.lastToolName) parts.push(`last tool ${record.lastToolName}`);
  return parts.join(', ');
}

export interface AdmissionRequest {
  delegationId: string;
  agentName: string;
  label?: string;
  abort: () => void;
  now?: number;
}

export class DelegationRegistry {
  private readonly records = new Map<string, DelegationRecord>();

  get(delegationId: string): DelegationRecord | undefined {
    return this.records.get(delegationId);
  }

  has(delegationId: string): boolean {
    return this.records.has(delegationId);
  }

  all(): DelegationRecord[] {
    return [...this.records.values()].sort((left, right) => left.startedAt - right.startedAt);
  }

  running(): DelegationRecord[] {
    return [...this.records.values()].filter((record) => record.status === 'running');
  }

  /**
   * Settled delegations whose outcome the parent model has not seen yet, oldest
   * first so a fan-out is reported in the order it was started.
   */
  undelivered(): DelegationRecord[] {
    return this.all().filter(
      (record) => record.status !== 'running' && record.deliveredAt === undefined
    );
  }

  /** Mark outcomes as handed to the parent. Only settled records can be. */
  markDelivered(records: Iterable<DelegationRecord>, now = Date.now()): void {
    for (const record of records) {
      if (record.status === 'running' || record.deliveredAt !== undefined) continue;
      record.deliveredAt = now;
    }
  }

  /**
   * True while this run still owes the parent something: a delegate is working,
   * or one has finished and its report has not been read yet.
   */
  get busy(): boolean {
    return this.running().length > 0 || this.undelivered().length > 0;
  }

  /**
   * Take a concurrency slot, or say why not.
   *
   * Returns a record only on success. A refusal costs nothing: nothing is
   * registered, so a rejected `Task` call does not occupy a slot it never got.
   */
  admit(
    request: AdmissionRequest
  ): { ok: true; record: DelegationRecord } | { ok: false; reason: string } {
    const running = this.running().length;
    if (running >= MAX_SUBAGENT_CONCURRENCY) {
      return {
        ok: false,
        reason: `${MAX_SUBAGENT_CONCURRENCY} subagents are already running for this session. Wait for some with TaskWait or stop them with TaskStop before delegating more.`,
      };
    }
    const startedAt = request.now ?? Date.now();
    let resolveCompletion: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const record: DelegationRecord = {
      delegationId: request.delegationId,
      agentName: request.agentName,
      ...(request.label ? { label: request.label } : {}),
      status: 'running',
      startedAt,
      completion,
      abort: request.abort,
      stopRequested: false,
      turns: 0,
      toolCalls: 0,
      lastActivityAt: startedAt,
    };
    this.settleHandles.set(request.delegationId, resolveCompletion);
    this.records.set(request.delegationId, record);
    return { ok: true, record };
  }

  private readonly settleHandles = new Map<string, () => void>();

  /**
   * Record a settled run and wake everyone waiting on it.
   *
   * Guarded on `running`, which is what makes a Stop that lands at the same
   * moment as a natural completion idempotent rather than a double settlement:
   * the first one through wins and the second is a no-op.
   */
  settle(delegationId: string, result: SubagentRunResult, now = Date.now()): boolean {
    const record = this.records.get(delegationId);
    if (!record || record.status !== 'running') return false;
    // A run that knew why it was cancelled already returned the right status.
    // This only covers an `aborted` that reached us some other way — a rejected
    // run, a settlement forced from outside — and names it after what asked.
    record.status =
      result.status === 'aborted' && record.stopRequested
        ? (record.cancelReason ?? 'stopped')
        : result.status;
    record.result = result;
    record.completedAt = now;
    this.settleHandles.get(delegationId)?.();
    this.settleHandles.delete(delegationId);
    this.prune();
    return true;
  }

  /**
   * Ask a delegate to stop. Repeated calls are harmless.
   *
   * The first reason wins: a drain deadline that lands on a delegate already
   * asked to stop does not rewrite what the user did into a timeout.
   */
  requestStop(record: DelegationRecord, reason: DelegationCancelReason = 'stopped'): void {
    record.stopRequested = true;
    record.cancelReason ??= reason;
    record.abort();
  }

  /** User Stop and dispose. Not parent idle — that is the whole point of D328. */
  abortAllRunning(): void {
    for (const record of this.running()) this.requestStop(record);
  }

  noteActivity(
    delegationId: string,
    event: { type: string; toolName?: string },
    now = Date.now()
  ): void {
    const record = this.records.get(delegationId);
    if (!record) return;
    record.lastActivityAt = now;
    if (event.type === 'turn_start') {
      record.turns += 1;
      return;
    }
    if (event.type === 'tool_execution_start') {
      record.toolCalls += 1;
      if (event.toolName) record.lastToolName = event.toolName;
    }
  }

  /**
   * Cap retained history. Settled records go oldest-first; running ones never
   * go at all, because evicting one would lose the only handle that can stop it.
   *
   * Neither does an UNDELIVERED one. Retention is about history — re-reading a
   * report by id — and a report the parent model has not seen yet is not
   * history, it is work in progress. Evicting it drops it out of
   * `undelivered()`, so the auto-resume pass never hands it over and a delegate
   * that ran to completion disappears with no log line anywhere. `deliveredAt`
   * exists precisely to hold that class of record; letting the cap delete them
   * would undo it.
   *
   * The cap is still counted over every settled record, so delivery — not the
   * protection — is what keeps history bounded in the normal case.
   */
  private prune(): void {
    const settled = [...this.records.values()].filter((record) => record.status !== 'running');
    const excess = settled.length - MAX_RETAINED_DELEGATIONS;
    if (excess <= 0) return;
    const evictable = settled
      .filter((record) => record.deliveredAt !== undefined)
      .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
    for (const record of evictable.slice(0, excess)) this.records.delete(record.delegationId);
  }
}

export type WaitMode = 'all' | 'any';

/**
 * Resolve once `targetCompleted` of the targets have settled, the deadline
 * passes, or the caller aborts. Returns true when it ended early (timeout or
 * abort) rather than because the targets finished.
 *
 * `deadline: null` waits until they settle — that is the auto-resume path,
 * where there is no timeout because the run is not allowed to end first.
 */
export function waitForDelegations(
  targets: readonly DelegationRecord[],
  targetCompleted: number,
  deadline: number | null,
  signal?: AbortSignal
): Promise<boolean> {
  const settledCount = () => targets.filter((record) => record.status !== 'running').length;
  if (settledCount() >= targetCompleted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (endedEarly: boolean) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(endedEarly);
    };
    const check = () => {
      if (settledCount() >= targetCompleted) finish(false);
    };
    const onAbort = () => finish(true);
    for (const record of targets) {
      if (record.status === 'running') void record.completion.then(check);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      finish(true);
      return;
    }
    timer =
      deadline === null
        ? undefined
        : setTimeout(() => finish(true), Math.max(0, deadline - Date.now()));
  });
}
