/**
 * One-shot completions on the shared DSH host (dsh-rebase P1-15; decisions
 * 039 and 125): the commit message, the branch name and the code review.
 *
 * Replaces `PiUtilityService`, which forked a native utility worker per
 * operation and handed it a model catalog with keys in it. Here every
 * completion is one `complete` host control on the app's one DSH host
 * (`DshHostSupervisor.startCompletion`): the host streams it with DSH's own
 * LLM service, routes it by Main's model plan and pulls the key per request
 * (decisions 033, 034); no process is started for it, no catalog is handed
 * over, no session is opened.
 *
 * The contract the three features rely on is PiUtilityService's:
 *   capacity   two at a time; a third is refused (`COMPLETION_CAPACITY_EXCEEDED`)
 *   deadline   Main's own timer; on expiry the host is told to abort and the
 *              call fails `COMPLETION_TIMEOUT` with the message `timeout`,
 *              which the commit box and the branch dialog show as
 *              "Generation timed out"
 *   cancel     by operation id (the code review's stop); settles at once
 *   logout     `invalidateAll` cancels everything in flight, the service stays usable
 *   quit       `disposeAll` / `forceKillAllNow`
 * A failure names its code in front of the host's sentence
 * (`CREDENTIALS_UNAVAILABLE: …`), the way the UI already prints `error`.
 */

import { randomUUID } from 'node:crypto';
import type { SessionEffortLevel } from '@shared/types/agentHost';
import {
  DSH_COMPLETION_CANCELLED,
  DSH_COMPLETION_MAX_TIMEOUT_MS,
  DSH_COMPLETION_TIMEOUT,
  type DshCompletionPurpose,
  type DshHostCompleted,
} from '@shared/types/dshHostProtocol';
import {
  type DshHostCompletionCall,
  type DshHostCompletionInput,
  dshHostSupervisor,
} from './DshHostSupervisor';

export type DshCompletionErrorCode =
  | 'COMPLETION_CAPACITY_EXCEEDED'
  | 'COMPLETION_CANCELLED'
  | 'COMPLETION_FAILED'
  | 'COMPLETION_TIMEOUT'
  /** The engine could not be reached: it did not start, it exited, or the app is quitting. */
  | 'COMPLETION_UNAVAILABLE';

export class DshCompletionError extends Error {
  readonly code: DshCompletionErrorCode;
  /** The host's code, when the host answered with one (`CREDENTIALS_UNAVAILABLE`, …). */
  readonly failureCode?: string;

  constructor(code: DshCompletionErrorCode, message: string, failureCode?: string) {
    super(message);
    this.name = 'DshCompletionError';
    this.code = code;
    if (failureCode !== undefined) this.failureCode = failureCode;
  }
}

/** The message the renderer turns into "Generation timed out". */
export const COMPLETION_TIMEOUT_MESSAGE = 'timeout';

export interface DshCompletionInput {
  /** Client identity for an explicit cancel (the code review's id); generated otherwise. */
  operationId?: string;
  purpose: DshCompletionPurpose;
  prompt: string;
  /** Our `provider/modelId`; absent: the plan's default model (Automatic). */
  model?: string;
  effort?: SessionEffortLevel;
  timeoutMs: number;
  /** Text as it arrives; the host streams only when this is set. */
  onDelta?: (delta: string) => void;
}

export interface DshCompletionResult {
  text: string;
  /** Our id of the model that answered. */
  model?: string;
}

/** The supervisor as this service drives it. */
export type DshCompletionHost = {
  startCompletion(
    input: DshHostCompletionInput,
    onDelta?: (text: string) => void
  ): DshHostCompletionCall;
};

export interface DshCompletionServiceOptions {
  capacity?: number;
  createOperationId?: () => string;
  /** Defaults to the app's shared host (`dshHostSupervisor`). */
  host?: DshCompletionHost;
  log?: (...args: unknown[]) => void;
}

interface ActiveCompletion {
  readonly id: string;
  readonly call: DshHostCompletionCall;
  readonly resolve: (result: DshCompletionResult) => void;
  readonly reject: (error: DshCompletionError) => void;
  readonly timer: NodeJS.Timeout;
  settled: boolean;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DshCompletionError(
      'COMPLETION_FAILED',
      `${label} must be a positive safe integer, received ${value}`
    );
  }
  return value;
}

/** The host's `completed` failure as the error the three features show. */
function answerError(answer: DshHostCompleted): DshCompletionError {
  const code = answer.error?.code ?? 'completion_failed';
  const message = answer.error?.message || 'no reason given';
  if (code === DSH_COMPLETION_TIMEOUT) {
    return new DshCompletionError('COMPLETION_TIMEOUT', COMPLETION_TIMEOUT_MESSAGE, code);
  }
  if (code === DSH_COMPLETION_CANCELLED) {
    return new DshCompletionError('COMPLETION_CANCELLED', 'cancelled', code);
  }
  return new DshCompletionError('COMPLETION_FAILED', `${code}: ${message}`, code);
}

export class DshCompletionService {
  private readonly capacity: number;
  private readonly createOperationId: () => string;
  private readonly host: DshCompletionHost;
  private readonly log: (...args: unknown[]) => void;
  private readonly operations = new Map<string, ActiveCompletion>();
  private disposed = false;

  constructor(options: DshCompletionServiceOptions = {}) {
    this.capacity = positiveInteger(options.capacity ?? 2, 'Completion capacity');
    this.createOperationId = options.createOperationId ?? randomUUID;
    this.host = options.host ?? dshHostSupervisor;
    this.log = options.log ?? (() => undefined);
  }

  get activeCount(): number {
    return this.operations.size;
  }

  complete(input: DshCompletionInput): Promise<DshCompletionResult> {
    try {
      return this.start(input);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Cancels one completion by its operation id; false when none is running under it. */
  cancel(operationId: string): boolean {
    const record = this.operations.get(operationId);
    if (!record) return false;
    return this.abort(record, 'user');
  }

  /**
   * Logout: cancel everything in flight WITHOUT marking the service disposed,
   * so completions work again after the next sign-in. The host keeps nothing
   * of a completion, and the next one pulls the key again (decision 034).
   */
  async invalidateAll(): Promise<void> {
    for (const record of [...this.operations.values()]) this.abort(record, 'dispose');
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
    for (const record of [...this.operations.values()]) this.abort(record, 'dispose');
  }

  /** Signal and deadline path: synchronous, terminal. The host itself is the supervisor's. */
  forceKillAllNow(): void {
    this.disposed = true;
    for (const record of [...this.operations.values()]) this.abort(record, 'dispose');
  }

  private start(input: DshCompletionInput): Promise<DshCompletionResult> {
    if (this.disposed) {
      throw new DshCompletionError('COMPLETION_UNAVAILABLE', 'the completion service is disposed');
    }
    if (this.operations.size >= this.capacity) {
      throw new DshCompletionError(
        'COMPLETION_CAPACITY_EXCEEDED',
        'Too many AI completions are already running'
      );
    }
    if (!input.prompt.trim()) {
      throw new DshCompletionError('COMPLETION_FAILED', 'A completion requires a prompt');
    }
    const timeoutMs = Math.min(
      positiveInteger(input.timeoutMs, 'Completion timeout'),
      DSH_COMPLETION_MAX_TIMEOUT_MS
    );
    const id = input.operationId ?? this.createOperationId();
    if (!id.trim() || this.operations.has(id)) {
      throw new DshCompletionError('COMPLETION_FAILED', 'Invalid completion operation id');
    }

    let record: ActiveCompletion | null = null;
    const onDelta = input.onDelta;
    const call = this.host.startCompletion(
      {
        purpose: input.purpose,
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        timeoutMs,
      },
      onDelta
        ? (text) => {
            if (record && !record.settled) onDelta(text);
          }
        : undefined
    );
    const result = new Promise<DshCompletionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (record) this.abort(record, 'timeout');
      }, timeoutMs);
      timer.unref?.();
      record = { id, call, resolve, reject, timer, settled: false };
      this.operations.set(id, record);
    });
    const active = record as unknown as ActiveCompletion;
    call.result.then(
      (answer) => {
        if (answer.ok) {
          this.settle(active, undefined, {
            text: answer.text ?? '',
            ...(answer.model ? { model: answer.model } : {}),
          });
        } else {
          this.settle(active, answerError(answer));
        }
      },
      (error: unknown) => {
        // Cancelled by `abort` below: already settled, nothing to add.
        if (active.settled) return;
        const code = (error as { code?: unknown } | null)?.code;
        this.settle(
          active,
          new DshCompletionError(
            'COMPLETION_UNAVAILABLE',
            error instanceof Error ? error.message : String(error),
            typeof code === 'string' ? code : undefined
          )
        );
      }
    );
    return result;
  }

  /** Settles the call now and tells the host to stop; a no-op once settled. */
  private abort(record: ActiveCompletion, reason: 'user' | 'timeout' | 'dispose'): boolean {
    if (record.settled) return false;
    this.settle(
      record,
      reason === 'timeout'
        ? new DshCompletionError('COMPLETION_TIMEOUT', COMPLETION_TIMEOUT_MESSAGE)
        : new DshCompletionError('COMPLETION_CANCELLED', 'cancelled')
    );
    try {
      record.call.cancel();
    } catch (error) {
      this.log('Completion cancel failed:', error);
    }
    return true;
  }

  private settle(
    record: ActiveCompletion,
    error: DshCompletionError | undefined,
    result?: DshCompletionResult
  ): void {
    if (record.settled) return;
    record.settled = true;
    clearTimeout(record.timer);
    if (this.operations.get(record.id) === record) this.operations.delete(record.id);
    if (error) record.reject(error);
    else record.resolve(result ?? { text: '' });
  }
}

export const dshCompletionService = new DshCompletionService();
