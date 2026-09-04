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
      }
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
