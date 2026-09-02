import { piUtilityService } from '../services/agent-host/PiUtilityService';
import { workerManager } from '../services/agent-host/WorkerManager';

/** Awaited app-close cleanup for all Main-owned Pi worker processes. */
export async function cleanupWorkerManager(): Promise<void> {
  await Promise.all([workerManager.disposeAll('app-shutdown'), piUtilityService.disposeAll()]);
}

/** Signal/deadline fallback: detach routing and synchronously kill every worker. */
export function cleanupWorkerManagerSync(): void {
  piUtilityService.forceKillAllNow();
  workerManager.forceKillAllNow();
}
