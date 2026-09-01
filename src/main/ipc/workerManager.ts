import { workerManager } from '../services/agent-host/WorkerManager';

/** Awaited app-close cleanup for the Main-owned bounded worker pool. */
export async function cleanupWorkerManager(): Promise<void> {
  await workerManager.disposeAll('app-shutdown');
}

/** Signal/deadline fallback: detach routing and synchronously kill every worker. */
export function cleanupWorkerManagerSync(): void {
  workerManager.forceKillAllNow();
}
