import { mkdir } from 'node:fs/promises';
import {
  PI_BORROW_USER_RESOURCES_SETTING_KEY,
  PI_ENABLE_SUBAGENTS_SETTING_KEY,
  type PiResourceSettings,
  type UpdatePiResourceSettingsRequest,
} from '@shared/piModelConfig';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain, shell } from 'electron';
import { workerManager } from '../services/agent-host/WorkerManager';
import { getActivePiPromptTemplatesDir, getPiResourceSettings } from '../services/piModelConfig';
import { mergeSettingsPatch } from './settings';

/**
 * A partial update, validated field by field.
 *
 * Absent is legal and means "leave it alone"; present-but-not-a-boolean is
 * rejected rather than coerced. An empty request is rejected too — it can only
 * be a caller that meant to change something and named the field wrong, and
 * answering it with a silent no-op would look like a saved setting.
 */
function readUpdateRequest(payload: unknown): UpdatePiResourceSettingsRequest {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid Pi resource settings request');
  }
  const raw = payload as Record<string, unknown>;
  const request: UpdatePiResourceSettingsRequest = {};
  for (const field of ['borrowUserPiResources', 'enableSubagents'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new Error('Invalid Pi resource settings request');
    request[field] = value;
  }
  if (Object.keys(request).length === 0) {
    throw new Error('Invalid Pi resource settings request');
  }
  return request;
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

      const patch: Record<string, boolean> = {};
      // The borrow directory is process-level worker configuration. Managed
      // workers must be replaced for the switch to take effect; local mode
      // already reads the user's own Pi directory and needs no restart.
      let restartManagedWorkers = false;
      // The extension list is read when a runtime is built, in BOTH modes, so
      // this one always needs the workers back.
      let restartAllWorkers = false;

      if (
        request.borrowUserPiResources !== undefined &&
        request.borrowUserPiResources !== previous.borrowUserPiResources
      ) {
        patch[PI_BORROW_USER_RESOURCES_SETTING_KEY] = request.borrowUserPiResources;
        restartManagedWorkers = true;
      }
      if (
        request.enableSubagents !== undefined &&
        request.enableSubagents !== previous.enableSubagents
      ) {
        patch[PI_ENABLE_SUBAGENTS_SETTING_KEY] = request.enableSubagents;
        restartAllWorkers = true;
      }
      if (Object.keys(patch).length === 0) return previous;

      const saved = mergeSettingsPatch(patch);
      if (!saved) throw new Error('Failed to save Pi resource settings');

      if (restartAllWorkers || (restartManagedWorkers && previous.managed)) {
        await workerManager.invalidateAll();
      }
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
