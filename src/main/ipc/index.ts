import { stopAllCodeReviews } from '../services/ai';
import { remoteConnectionManager } from '../services/remote/RemoteConnectionManager';
import { webInspectorServer } from '../services/webInspector';
import { cleanupExecInPtys, cleanupExecInPtysSync } from '../utils/shell';
import { registerAgentCatalogHandlers } from './agentCatalog';
import { registerAppHandlers } from './app';
import { registerAuthHandlers } from './auth';
import { registerChatHandlers } from './chat';
import { registerCliHandlers } from './cli';
import { registerDialogHandlers } from './dialog';
import {
  cleanupTempFiles,
  cleanupTempFilesSync,
  registerFileHandlers,
  stopAllFileWatchers,
  stopAllFileWatchersSync,
} from './files';
import { registerFolderHandlers } from './folder';
import { clearAllGitServices, registerGitHandlers } from './git';
import { registerLegacyImportHandlers } from './legacyImport';
import { registerLogHandlers } from './log';
import { registerNotificationHandlers } from './notification';
import { registerOnboardingHandlers } from './onboarding';
import { registerPiModelHandlers } from './piModels';
import { registerPiPermissionHandlers } from './piPermissions';
import { registerPiRuntimeHandlers } from './piRuntime';
import {
  disposeAllPiTuiControllers,
  disposeAllPiTuiControllersSync,
  registerPiTuiHandlers,
} from './piTui';
import { registerRemoteHandlers } from './remote';
import { registerSearchHandlers } from './search';
import {
  destroyAllTerminals,
  destroyAllTerminalsAndWait,
  registerSessionHandlers,
} from './session';
import { registerSessionStorageHandlers } from './sessionStorage';
import { registerSettingsHandlers } from './settings';
import { registerShellHandlers } from './shell';
import { registerTempWorkspaceHandlers } from './tempWorkspace';
import { cleanupTmuxSync, registerTmuxHandlers } from './tmux';
import { registerUpdaterHandlers } from './updater';
import { registerUsageHandlers } from './usage';
import { registerWebInspectorHandlers } from './webInspector';
import { cleanupWorkerManager, cleanupWorkerManagerSync } from './workerManager';
import { clearAllWorktreeServices, registerWorktreeHandlers } from './worktree';

export function registerIpcHandlers(): void {
  registerAuthHandlers();
  registerGitHandlers();
  registerWorktreeHandlers();
  registerFolderHandlers();
  registerFileHandlers();
  registerSessionHandlers();
  registerSessionStorageHandlers();
  registerChatHandlers();
  registerAgentCatalogHandlers();
  registerDialogHandlers();
  registerAppHandlers();
  registerCliHandlers();
  registerShellHandlers();
  registerSettingsHandlers();
  registerLogHandlers();
  registerNotificationHandlers();
  registerRemoteHandlers();
  registerUpdaterHandlers();
  registerSearchHandlers();
  registerLegacyImportHandlers();
  registerPiRuntimeHandlers();
  registerWebInspectorHandlers();
  registerTempWorkspaceHandlers();
  registerTmuxHandlers();
  registerOnboardingHandlers();
  registerPiModelHandlers();
  registerPiPermissionHandlers();
  registerUsageHandlers();
  registerPiTuiHandlers();
}

export async function cleanupAllResources(): Promise<void> {
  // Single global deadline well within FORCE_EXIT_TIMEOUT_MS (8000ms).
  // Previous approach ran steps serially with per-step 3000ms timeouts, which
  // could stack up to ~15s total — triggering the force-exit while async cleanup
  // was still running and causing double-cleanup of node-pty native resources.
  // WorkerSlot's worst graceful path is 3s dispose ACK + 3s exit confirmation.
  // Keep this above that 6s contract and below Main's 8s force-exit timer.
  const TOTAL_ASYNC_TIMEOUT = 7000;
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => {
      // Graceful worker disposal exhausted its ACK+exit budget. Detach routing
      // and kill synchronously before Main's outer 8s force-exit timer fires.
      cleanupWorkerManagerSync();
      resolve();
    }, TOTAL_ASYNC_TIMEOUT);
  });

  const safeRun = async (fn: () => Promise<void>, label: string): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      console.warn(`[cleanup] ${label} warning:`, err);
    }
  };

  // Run all independent async cleanup steps in parallel, bounded by a single deadline.
  await Promise.race([
    Promise.allSettled([
      // node-pty PTYs used by short-lived commands (exec-in-pty pool)
      safeRun(() => cleanupExecInPtys(4000), 'execInPty'),
      // Interactive terminal PTY sessions
      safeRun(async () => {
        try {
          await destroyAllTerminalsAndWait();
        } catch (err) {
          console.warn('[cleanup] terminals warning:', err);
          // Fallback: force-kill without waiting
          destroyAllTerminals();
        }
      }, 'terminals'),
      // File system watchers
      safeRun(() => stopAllFileWatchers(), 'fileWatchers'),
      // Embedded Pi TUI PTYs are independent from generic shell sessions.
      safeRun(() => disposeAllPiTuiControllers(), 'piTui'),
      // Main-owned Pi WorkerManager. Pool disposal is parallel, so every slot
      // receives the same global deadline and app quit leaves no utility process.
      safeRun(() => cleanupWorkerManager(), 'workerManager'),
      // Temp files
      safeRun(() => cleanupTempFiles(), 'tempFiles'),
    ]),
    deadline,
  ]);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  // Fast synchronous cleanup (runs after async steps or deadline)
  try {
    cleanupTmuxSync();
  } catch (err) {
    console.warn('[cleanup] tmux warning:', err);
  }
  webInspectorServer.stop();
  stopAllCodeReviews();
  clearAllGitServices();
  clearAllWorktreeServices();
  await remoteConnectionManager.cleanup();
}

/**
 * Synchronous cleanup for signal handlers (SIGINT/SIGTERM).
 * Kills child processes immediately without waiting for graceful shutdown.
 * This ensures clean exit when electron-vite terminates quickly.
 */
export function cleanupAllResourcesSync(): void {
  console.log('[app] Sync cleanup starting...');

  // Kill any in-flight execInPty commands first (sync)
  cleanupExecInPtysSync();

  // Kill tmux aiclient server (sync)
  cleanupTmuxSync();

  // Stop Web Inspector server (sync)
  webInspectorServer.stop();

  // Kill all PTY sessions immediately (sync)
  destroyAllTerminals();

  // Stop all code review processes (sync)
  stopAllCodeReviews();

  // Stop file watchers (sync)
  stopAllFileWatchersSync();

  // Clear service caches (sync)
  clearAllGitServices();
  clearAllWorktreeServices();

  void remoteConnectionManager.cleanup();

  // Embedded Pi TUI PTYs are independent from generic shell sessions.
  disposeAllPiTuiControllersSync();

  // Kill every Pi worker synchronously.
  cleanupWorkerManagerSync();

  // Clean up temp files (sync)
  cleanupTempFilesSync();

  console.log('[app] Sync cleanup done');
}
