import { stopAllCodeReviews } from '../services/ai';
import { disposeClaudeIdeBridge } from '../services/claude/ClaudeIdeBridge';
import { autoUpdaterService } from '../services/updater/AutoUpdater';
import { webInspectorServer } from '../services/webInspector';
import { cleanupExecInPtys, cleanupExecInPtysSync } from '../utils/shell';
import { registerAgentHandlers } from './agent';
import { registerAgentCatalogHandlers } from './agentCatalog';
import { registerAppHandlers } from './app';
import { registerAuthHandlers } from './auth';
import { registerChatHandlers } from './chat';
import {
  registerClaudeCompletionsHandlers,
  stopClaudeCompletionsWatchers,
} from './claudeCompletions';
import { registerClaudeConfigHandlers } from './claudeConfig';
import { registerClaudeProviderHandlers } from './claudeProvider';
import { registerClaudeRuntimeHandlers } from './claudeRuntime';
import { registerClaudeSessionsHandlers } from './claudeSessions';
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
import { autoStartHapi, cleanupHapi, cleanupHapiSync, registerHapiHandlers } from './hapi';
import { cleanupWorkerManager, cleanupWorkerManagerSync } from './workerManager';

export { autoStartHapi };

import { remoteConnectionManager } from '../services/remote/RemoteConnectionManager';
import { registerLogHandlers } from './log';
import { registerNotificationHandlers } from './notification';
import { registerOnboardingHandlers } from './onboarding';
import { registerPiModelHandlers } from './piModels';
import { registerPiPermissionHandlers } from './piPermissions';
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
import { cleanupTodo, cleanupTodoSync, registerTodoHandlers } from './todo';
import { registerUpdaterHandlers } from './updater';
import { registerUsageHandlers } from './usage';
import { registerWebInspectorHandlers } from './webInspector';
import { clearAllWorktreeServices, registerWorktreeHandlers } from './worktree';

export function registerIpcHandlers(): void {
  registerAuthHandlers();
  registerGitHandlers();
  registerWorktreeHandlers();
  registerFolderHandlers();
  registerFileHandlers();
  registerSessionHandlers();
  registerSessionStorageHandlers();
  registerAgentHandlers();
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
  registerHapiHandlers();
  registerClaudeProviderHandlers();
  registerClaudeConfigHandlers();
  registerClaudeCompletionsHandlers();
  registerClaudeSessionsHandlers();
  registerClaudeRuntimeHandlers();
  registerWebInspectorHandlers();
  registerTempWorkspaceHandlers();
  registerTmuxHandlers();
  registerTodoHandlers();
  registerOnboardingHandlers();
  registerPiModelHandlers();
  registerPiPermissionHandlers();
  registerUsageHandlers();
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
      // Hapi server + runner + cloudflared
      safeRun(() => cleanupHapi(4000), 'hapi'),
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
      // Claude completions file watcher
      safeRun(() => stopClaudeCompletionsWatchers(), 'claudeCompletions'),
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
  autoUpdaterService.cleanup();
  disposeClaudeIdeBridge();
  await remoteConnectionManager.cleanup();
  await cleanupTodo();
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

  // Kill Hapi/Cloudflared processes (sync)
  cleanupHapiSync();

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

  autoUpdaterService.cleanup();

  // Dispose Claude IDE Bridge (sync)
  disposeClaudeIdeBridge();

  void remoteConnectionManager.cleanup();

  // Close Todo database (sync — just nulls the reference, no async callback)
  cleanupTodoSync();

  // Kill every Pi worker synchronously.
  cleanupWorkerManagerSync();

  // Clean up temp files (sync)
  cleanupTempFilesSync();

  console.log('[app] Sync cleanup done');
}
