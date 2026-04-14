import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { usageService } from '../services/usage/UsageService';

export function registerUsageHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.USAGE_GET_STATS, async () => {
    return usageService.getStats();
  });
}
