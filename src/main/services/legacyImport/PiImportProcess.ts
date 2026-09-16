import type {
  WorkerDiscardImportedSessionPayload,
  WorkerDiscardImportedSessionResult,
  WorkerImportConversationPayload,
  WorkerImportConversationResult,
  WorkerInspectImportedSessionPayload,
  WorkerInspectImportedSessionResult,
  WorkerReconcileImportedSessionPayload,
  WorkerReconcileImportedSessionResult,
} from '@shared/types/legacyImport';
import {
  isWorkerDiscardImportedSessionResult,
  isWorkerImportResult,
  isWorkerInspectImportedSessionResult,
  isWorkerReconcileImportedSessionResult,
} from '@shared/types/workerRpc';
import { forkPiWorkerProcess } from '../agent-host/PiWorkerProcess';
import { WorkerSlot } from '../agent-host/WorkerSlot';
import type { WorkerTransport } from '../agent-host/WorkerTransport';

const IMPORT_TIMEOUT_MS = 120_000;

/**
 * concurrency-09 — how many import worker processes may exist at once.
 *
 * An import forks a worker of its own and never enters `entriesBySession`, the
 * map every capacity decision in `WorkerManager` counts, so the process peak is
 * `capacity + 1` while the application still believes it is inside its limit —
 * 33% over on the 4 GiB tier, where the tier was cut by memory in the first
 * place. WorkerManager guards its three import entry points with one boolean;
 * this is the same rule stated where the fork actually happens, so the count
 * cannot be wrong for a caller that reaches these functions another way, and so
 * there is one number to read for "how many worker processes are live".
 */
export const MAX_IMPORT_WORKERS = 1;

const liveImportWorkers = new Set<string>();

/** The live import workers, for whoever reports how many processes exist. */
export function importWorkerCount(): number {
  return liveImportWorkers.size;
}

/**
 * Reserve the import worker seat. Released when the process is gone — by the
 * caller disposing it, by the transport reporting its exit, or by the startup
 * below failing before either of those exists — whichever happens first, so a
 * caller that forgets cannot strand the seat forever.
 */
function claimImportWorker(slotKey: string): () => void {
  if (liveImportWorkers.size >= MAX_IMPORT_WORKERS) {
    throw new Error(
      `Another legacy import worker is already running; ${MAX_IMPORT_WORKERS} at a time`
    );
  }
  const token = `${slotKey}:${Date.now()}:${Math.random()}`;
  liveImportWorkers.add(token);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    liveImportWorkers.delete(token);
  };
}

interface StartedImportWorker {
  slot: WorkerSlot;
  release: () => void;
}

/**
 * Claim the seat and fork the worker behind one guard.
 *
 * `forkPiWorkerProcess` throws synchronously in cases that really happen: a
 * workspace directory that no longer exists (`WORKER_WORKSPACE_MISSING`), and a
 * packaged Windows build whose bundled node runtime is absent. A throw there
 * leaves no transport to report an exit and no slot for the caller to dispose,
 * so a seat claimed and not released here would refuse every later import for
 * the remaining life of the process — a worse failure than the one the seat
 * exists to prevent. Release on any failure before the caller owns the slot,
 * and kill the process first when one was already created, so the rollback does
 * not trade a stuck seat for a worker nobody holds a handle to.
 */
function startImportWorker(input: {
  slotKey: string;
  cwd: string;
  generation: number;
  onSlotCreated?: (slot: WorkerSlot) => void;
}): StartedImportWorker {
  const release = claimImportWorker(input.slotKey);
  let transport: WorkerTransport | undefined;
  try {
    transport = forkPiWorkerProcess({ generation: input.generation, cwd: input.cwd }).transport;
    transport.onExit(release);
    const slot = new WorkerSlot({
      slotKey: input.slotKey,
      cwd: input.cwd,
      generation: input.generation,
      transport,
      requestTimeoutMs: IMPORT_TIMEOUT_MS,
    });
    input.onSlotCreated?.(slot);
    return { slot, release };
  } catch (error) {
    transport?.kill();
    release();
    throw error;
  }
}

export interface CreatedPiImport {
  result: WorkerImportConversationResult;
  readonly pid?: number;
  discard(): Promise<boolean>;
  dispose(): Promise<void>;
  forceKillNow(): boolean;
}

export async function inspectPiImport(
  payload: WorkerInspectImportedSessionPayload,
  options: { onSlotCreated?: (slot: WorkerSlot) => void } = {}
): Promise<WorkerInspectImportedSessionResult> {
  const { slot, release } = startImportWorker({
    slotKey: `import-inspect:${payload.logicalSessionId}`,
    cwd: payload.workspacePath,
    generation: 1,
    onSlotCreated: options.onSlotCreated,
  });
  try {
    const response = await slot.request<
      WorkerInspectImportedSessionResult,
      WorkerInspectImportedSessionPayload
    >('worker.import.inspect', payload, { timeoutMs: IMPORT_TIMEOUT_MS });
    if (!isWorkerInspectImportedSessionResult(response)) {
      throw new Error('Pi import worker returned an invalid inspection result');
    }
    return response;
  } finally {
    await slot.dispose('slot-dispose');
    release();
  }
}

export async function reconcilePiImport(
  payload: WorkerReconcileImportedSessionPayload,
  options: { onSlotCreated?: (slot: WorkerSlot) => void } = {}
): Promise<WorkerReconcileImportedSessionResult> {
  const { slot, release } = startImportWorker({
    slotKey: `import-reconcile:${payload.logicalSessionId}`,
    cwd: payload.workspacePath,
    generation: 1,
    onSlotCreated: options.onSlotCreated,
  });
  try {
    const response = await slot.request<
      WorkerReconcileImportedSessionResult,
      WorkerReconcileImportedSessionPayload
    >('worker.import.reconcile', payload, { timeoutMs: IMPORT_TIMEOUT_MS });
    if (!isWorkerReconcileImportedSessionResult(response)) {
      throw new Error('Pi import worker returned an invalid reconciliation result');
    }
    return response;
  } finally {
    await slot.dispose('slot-dispose');
    release();
  }
}

export async function createPiImport(
  payload: WorkerImportConversationPayload,
  options: { onSlotCreated?: (slot: WorkerSlot) => void } = {}
): Promise<CreatedPiImport> {
  const { slot, release } = startImportWorker({
    slotKey: `import:${payload.logicalSessionId}`,
    cwd: payload.conversation.workspacePath,
    generation: 1,
    onSlotCreated: options.onSlotCreated,
  });
  let result: WorkerImportConversationResult;
  try {
    const response = await slot.request<
      WorkerImportConversationResult,
      WorkerImportConversationPayload
    >('worker.import', payload, { timeoutMs: IMPORT_TIMEOUT_MS });
    if (!isWorkerImportResult(response)) {
      throw new Error('Pi import worker returned an invalid result');
    }
    result = response;
  } catch (error) {
    await slot.dispose('slot-dispose').catch(() => undefined);
    release();
    throw error;
  }

  let disposed = false;
  return {
    result,
    pid: slot.pid,
    async discard() {
      if (disposed) return false;
      const response = await slot.request<
        WorkerDiscardImportedSessionResult,
        WorkerDiscardImportedSessionPayload
      >(
        'worker.import.discard',
        { logicalSessionId: payload.logicalSessionId, sessionFile: result.finalSessionFile },
        { timeoutMs: IMPORT_TIMEOUT_MS }
      );
      if (!isWorkerDiscardImportedSessionResult(response)) {
        throw new Error('Pi import worker returned an invalid discard result');
      }
      return response.discarded;
    },
    async dispose() {
      if (disposed) return;
      await slot.dispose('slot-dispose');
      disposed = true;
      release();
    },
    forceKillNow() {
      disposed = true;
      const killed = slot.forceKillNow();
      // Released whatever the kill reported: a seat held for a process nobody
      // can kill would refuse every later import for the life of the app, and
      // the kill failure is already reported through the return value.
      release();
      return killed;
    },
  };
}
