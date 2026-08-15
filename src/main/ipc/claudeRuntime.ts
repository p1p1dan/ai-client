import { IPC_CHANNELS } from '@shared/types';
import { app, ipcMain } from 'electron';
import { resolveManagedCredentialsEnabled } from '../services/auth/AuthStateService';
import { getManagedClaudeHomeDir } from '../services/auth/claudeHome';
import { AgentInstaller } from '../services/cli/AgentInstaller';
import {
  type ClaudeRuntimeStatus,
  claudeRuntimeChecker,
} from '../services/cli/ClaudeRuntimeChecker';
import { disableClaudeAutoUpdates } from '../services/cli/ClaudeRuntimeConfig';

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
      await disableClaudeAutoUpdates();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // D47 S2a §1-S2b-⑤ — renderer has no way to know the userData path, so it
  // can't derive `claudeHomeDir` itself; the path is not a secret, so
  // returning it directly (rather than gating it behind more IPC) is fine.
  // S2b's Provider/UI layer consumes this; preload only invokes the channel
  // and never imports a Main service symbol, so S1's staticImportBans scan
  // stays green untouched.
  ipcMain.handle(IPC_CHANNELS.AUTH_MANAGED_MODE, () => {
    const managed = resolveManagedCredentialsEnabled();
    return {
      managed,
      claudeHomeDir: managed ? getManagedClaudeHomeDir(app.getPath('userData')) : null,
    };
  });
}
