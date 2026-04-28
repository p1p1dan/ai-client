import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { AgentInstaller } from '../services/cli/AgentInstaller';
import {
  type ClaudeRuntimeStatus,
  claudeRuntimeChecker,
} from '../services/cli/ClaudeRuntimeChecker';
import {
  disableClaudeAutoUpdates,
  mergeClaudeEnvSettings,
} from '../services/cli/ClaudeRuntimeConfig';

export function registerClaudeRuntimeHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_RUNTIME_CHECK,
    async (_, force = false): Promise<ClaudeRuntimeStatus> => {
      try {
        return await claudeRuntimeChecker.detect(Boolean(force));
      } catch (error) {
        // Surface probe failures (IPC race, fs permission, transient PATH
        // lookup, etc.) as a structured status instead of throwing. The
        // renderer would otherwise see a generic IPC rejection and could not
        // distinguish "no Claude installed" from "we failed to look".
        const message = error instanceof Error ? error.message : String(error);
        console.error('[claudeRuntime] detect failed:', error);
        return { kind: 'detection-failed', error: message };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.CLAUDE_RUNTIME_DOWNGRADE, async (event) => {
    const installer = new AgentInstaller();
    try {
      await installer.downgradeClaudeToNodeVersion((message) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC_CHANNELS.CLAUDE_RUNTIME_DOWNGRADE_PROGRESS, { message });
        }
      });
      claudeRuntimeChecker.invalidate();
      const status = await claudeRuntimeChecker.detect(true);
      return { success: true, status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_RUNTIME_DISABLE_AUTO_UPDATES, async () => {
    try {
      disableClaudeAutoUpdates();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_RUNTIME_REGISTER_ENV,
    async (
      _,
      env: Record<string, string | null>
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        mergeClaudeEnvSettings(env);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );
}
