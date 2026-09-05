import {
  isWorkerBootstrapResult,
  type WorkerBootstrapPayload,
  type WorkerBootstrapResult,
} from '@shared/types/workerRpc';
import { forkPiWorkerProcess } from './PiWorkerProcess';
import { WorkerSlot, type WorkerSlotOptions } from './WorkerSlot';
import type { WorkerTransport } from './WorkerTransport';

export interface CreatePiWorkerSlotOptions
  extends Omit<
      WorkerSlotOptions,
      | 'transport'
      | 'generation'
      | 'slotKey'
      | 'cwd'
      | 'onEvent'
      | 'onDiagnostic'
      | 'onLifecycle'
      | 'onStderr'
    >,
    WorkerBootstrapPayload {
  slotKey: string;
  generation?: number;
  /** Cold-start budget for `worker.bootstrap` only; warm RPCs keep `requestTimeoutMs`. */
  bootstrapTimeoutMs?: number;
  createTransport?: (input: { generation: number; cwd: string }) => WorkerTransport;
  /** Exposes process ownership before bootstrap awaits, for app-close force kill. */
  onSlotCreated?: (slot: WorkerSlot) => void;
  onEvent?: WorkerSlotOptions['onEvent'];
  onDiagnostic?: WorkerSlotOptions['onDiagnostic'];
  onLifecycle?: WorkerSlotOptions['onLifecycle'];
  onStderr?: WorkerSlotOptions['onStderr'];
}

export interface CreatedPiWorkerSlot {
  slot: WorkerSlot;
  bootstrap: WorkerBootstrapResult;
}

/**
 * Bootstrap gets its own, much larger budget than a warm RPC.
 *
 * `WorkerSlot`'s 10s default is sized for requests answered by a process that
 * is already up. `worker.bootstrap` is the opposite: it is the cold start, and
 * everything that only happens once is inside it — forking the utility process,
 * loading the agent-host module graph (type-stripped from source in dev),
 * parsing the session file, loading pi's extensions and binding the approval UI.
 *
 * Reusing the warm budget here made a slow-but-healthy cold start indis-
 * tinguishable from a wedged worker: on a busy machine `chat:resumeSession`
 * failed with `worker.bootstrap timed out after 10000ms` and left the session
 * unopenable until the user retried. Losing a healthy session to a 10s cutoff
 * is worse than waiting longer for a genuinely stuck one, which still fails —
 * just later.
 */
export const BOOTSTRAP_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Spawn and bootstrap one per-slot Pi utility process.
 *
 * A bootstrap failure tears the slot down before the error escapes, so callers
 * never receive a running utility process without an authoritative AgentSession.
 */
export async function createPiWorkerSlot(
  options: CreatePiWorkerSlotOptions
): Promise<CreatedPiWorkerSlot> {
  const generation = options.generation ?? 1;
  const transport = options.createTransport
    ? options.createTransport({ generation, cwd: options.cwd })
    : forkPiWorkerProcess({ generation, cwd: options.cwd }).transport;
  const slot = new WorkerSlot({
    slotKey: options.slotKey,
    cwd: options.cwd,
    transport,
    generation,
    requestTimeoutMs: options.requestTimeoutMs,
    disposeTimeoutMs: options.disposeTimeoutMs,
    exitTimeoutMs: options.exitTimeoutMs,
    onEvent: options.onEvent,
    onDiagnostic: options.onDiagnostic,
    onLifecycle: options.onLifecycle,
    onStderr: options.onStderr,
  });
  options.onSlotCreated?.(slot);

  try {
    const result = await slot.request<WorkerBootstrapResult, WorkerBootstrapPayload>(
      'worker.bootstrap',
      {
        logicalSessionId: options.logicalSessionId,
        cwd: options.cwd,
        ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.leafCheckpoint ? { leafCheckpoint: options.leafCheckpoint } : {}),
        // U05-c: only ever sent as `true`. Omitting it for a normal session
        // keeps `sameBootstrap`'s undefined === undefined comparison intact.
        ...(options.unbound ? { unbound: true } : {}),
        // U12 fix: the tier the worker must come up on. Omitted when the
        // session is on the default, so an untouched session's bootstrap
        // payload is byte-identical to what it was before this fix.
        ...(options.tier ? { tier: options.tier } : {}),
      },
      { timeoutMs: options.bootstrapTimeoutMs ?? BOOTSTRAP_REQUEST_TIMEOUT_MS }
    );
    if (!isWorkerBootstrapResult(result)) {
      throw new Error('Pi worker returned an invalid bootstrap acknowledgement');
    }
    return { slot, bootstrap: result };
  } catch (error) {
    try {
      await slot.dispose('slot-dispose');
    } catch {
      // The original bootstrap error is the actionable failure. WorkerSlot has
      // already killed the transport and attempted to confirm process exit.
    }
    throw error;
  }
}
