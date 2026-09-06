import { mkdir } from 'node:fs/promises';
import {
  PI_BORROW_USER_RESOURCES_SETTING_KEY,
  type PiResourceSettings,
  type UpdatePiResourceSettingsRequest,
} from '@shared/piModelConfig';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain, shell } from 'electron';
import { workerManager } from '../services/agent-host/WorkerManager';
import { getActivePiPromptTemplatesDir, getPiResourceSettings } from '../services/piModelConfig';
import { mergeSettingsPatch } from './settings';

function readUpdateRequest(payload: unknown): UpdatePiResourceSettingsRequest {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid Pi resource settings request');
  }
  const borrowUserPiResources = (payload as Record<string, unknown>).borrowUserPiResources;
  if (typeof borrowUserPiResources !== 'boolean') {
    throw new Error('Invalid Pi resource settings request');
  }
  return { borrowUserPiResources };
}

export function registerPiResourceHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.PI_RESOURCES_GET_SETTINGS,
    async (): Promise<PiResourceSettings> => getPiResourceSettings()
  );

  ipcMain.handle(
    IPC_CHANNELS.PI_RESOURCES_UPDATE_SETTINGS,
    async (_event, payload: unknown): Promise<PiResourceSettings> => {
      const request = readUpdateRequest(payload);
      const previous = getPiResourceSettings();
      if (previous.borrowUserPiResources === request.borrowUserPiResources) return previous;

      const saved = mergeSettingsPatch({
        [PI_BORROW_USER_RESOURCES_SETTING_KEY]: request.borrowUserPiResources,
      });
      if (!saved) throw new Error('Failed to save Pi resource settings');

      // The borrow directory is process-level worker configuration. Managed
      // workers must be replaced for the switch to take effect; local mode
      // already reads the user's own Pi directory and needs no restart.
      if (previous.managed) await workerManager.invalidateAll();
      return getPiResourceSettings();
    }
  );

  ipcMain.handle(IPC_CHANNELS.PI_RESOURCES_OPEN_PROMPTS, async (): Promise<void> => {
    const promptTemplatesDir = getActivePiPromptTemplatesDir();
    await mkdir(promptTemplatesDir, { recursive: true });
    const error = await shell.openPath(promptTemplatesDir);
    if (error) throw new Error(`Failed to open prompt templates folder: ${error}`);
  });
}
