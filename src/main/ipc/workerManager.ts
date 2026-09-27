import { dshHostSupervisor } from '../services/agent-host/DshHostSupervisor';
import { piUtilityService } from '../services/agent-host/PiUtilityService';
import { scratchWorkspaceService } from '../services/agent-host/ScratchWorkspaceService';
import { workerManager } from '../services/agent-host/WorkerManager';

/** Chat sessions first, then the shared DSH host they run on (decision 025). */
async function disposeChatEngine(): Promise<void> {
  try {
    await workerManager.disposeAll('app-shutdown');
  } finally {
    await dshHostSupervisor.shutdown('app-quit');
  }
}

/** Awaited app-close cleanup for all Main-owned Pi worker processes. */
export async function cleanupWorkerManager(): Promise<void> {
  await Promise.all([disposeChatEngine(), piUtilityService.disposeAll()]);
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
  // After the slots detached: SIGKILL the shared DSH host itself (idempotent).
  dshHostSupervisor.forceKillNow();
}
