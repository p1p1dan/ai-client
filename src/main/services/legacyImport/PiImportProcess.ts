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

const IMPORT_TIMEOUT_MS = 120_000;

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
  const generation = 1;
  const { transport } = forkPiWorkerProcess({ generation, cwd: payload.workspacePath });
  const slot = new WorkerSlot({
    slotKey: `import-inspect:${payload.logicalSessionId}`,
    cwd: payload.workspacePath,
    generation,
    transport,
    requestTimeoutMs: IMPORT_TIMEOUT_MS,
  });
  options.onSlotCreated?.(slot);
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
  }
}

export async function reconcilePiImport(
  payload: WorkerReconcileImportedSessionPayload,
  options: { onSlotCreated?: (slot: WorkerSlot) => void } = {}
): Promise<WorkerReconcileImportedSessionResult> {
  const generation = 1;
  const { transport } = forkPiWorkerProcess({ generation, cwd: payload.workspacePath });
  const slot = new WorkerSlot({
    slotKey: `import-reconcile:${payload.logicalSessionId}`,
    cwd: payload.workspacePath,
    generation,
    transport,
    requestTimeoutMs: IMPORT_TIMEOUT_MS,
  });
  options.onSlotCreated?.(slot);
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
  }
}

export async function createPiImport(
  payload: WorkerImportConversationPayload,
  options: { onSlotCreated?: (slot: WorkerSlot) => void } = {}
): Promise<CreatedPiImport> {
  const generation = 1;
  const { transport } = forkPiWorkerProcess({
    generation,
    cwd: payload.conversation.workspacePath,
  });
  const slot = new WorkerSlot({
    slotKey: `import:${payload.logicalSessionId}`,
    cwd: payload.conversation.workspacePath,
    generation,
    transport,
    requestTimeoutMs: IMPORT_TIMEOUT_MS,
  });
  options.onSlotCreated?.(slot);
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
    },
    forceKillNow() {
      disposed = true;
      return slot.forceKillNow();
    },
  };
}
