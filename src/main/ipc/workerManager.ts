import { piUtilityService } from '../services/agent-host/PiUtilityService';
import { scratchWorkspaceService } from '../services/agent-host/ScratchWorkspaceService';
import { workerManager } from '../services/agent-host/WorkerManager';

/** Awaited app-close cleanup for all Main-owned Pi worker processes. */
export async function cleanupWorkerManager(): Promise<void> {
  await Promise.all([workerManager.disposeAll('app-shutdown'), piUtilityService.disposeAll()]);
  // U05-a: after the workers are gone, not before — a live worker still has
  // its scratch cwd open, and removing it underneath one invites EBUSY on
  // Windows and a confusing tool failure everywhere else.
  await scratchWorkspaceService.wipeAll();
}

/**
 * U05-a startup cleanup: the app-exit wipe that a crash never got to run.
 *
 * Deliberately fire-and-forget at startup — a scratch directory left over from
 * a previous run holds nothing the app needs, so nothing should wait on it.
 */
export function sweepScratchWorkspacesOnStartup(): void {
  void scratchWorkspaceService.wipeAll();
}

/** Signal/deadline fallback: detach routing and synchronously kill every worker. */
export function cleanupWorkerManagerSync(): void {
  piUtilityService.forceKillAllNow();
  workerManager.forceKillAllNow();
}
