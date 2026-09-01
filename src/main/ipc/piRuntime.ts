import { IPC_CHANNELS } from '@shared/types';
import type { PiRuntimeStatus } from '@shared/types/piRuntime';
import { ipcMain } from 'electron';
import { piRuntimeChecker } from '../services/cli/PiRuntimeChecker';

export function registerPiRuntimeHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.PI_RUNTIME_CHECK,
    async (_event, force = false): Promise<PiRuntimeStatus> => {
      try {
        return await piRuntimeChecker.detect(Boolean(force));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[piRuntime] detect failed:', error);
        return { kind: 'detection-failed', error: message };
      }
    }
  );
}
