import type {
  PiModelManagementSettings,
  PiModelSyncResult,
  SyncPiModelsRequest,
} from '@shared/piModelConfig';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain, shell } from 'electron';
import { agentHostManager } from '../services/agent-host/AgentHostManager';
import { resolveManagedCredentialsEnabled } from '../services/auth/credentialMode';
import {
  getPiModelManagementUrl,
  getPiModelSyncState,
  setPiModelManagementUrl,
  syncManagedPiModels,
} from '../services/piModelConfig';

function managementPageUrl(endpointUrl: string): string {
  const parsed = new URL(endpointUrl);
  parsed.pathname = parsed.pathname.replace(/\/api\/v1\/models-config\/?$/, '/') || '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function registerPiModelHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.PI_MODELS_GET_STATUS,
    async (): Promise<PiModelManagementSettings> => ({
      endpointUrl: getPiModelManagementUrl(),
      state: getPiModelSyncState(),
      managed: resolveManagedCredentialsEnabled(),
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.PI_MODELS_SYNC,
    async (_event, payload: SyncPiModelsRequest = {}): Promise<PiModelSyncResult> => {
      const endpointUrl = payload.endpointUrl?.trim()
        ? setPiModelManagementUrl(payload.endpointUrl)
        : getPiModelManagementUrl();
      const result = await syncManagedPiModels(endpointUrl, { force: true });
      if (result.ok) await agentHostManager.shutdown();
      return result;
    }
  );

  ipcMain.handle(IPC_CHANNELS.PI_MODELS_OPEN_ADMIN, async (_event, endpointUrl?: string) => {
    const url = endpointUrl?.trim() || getPiModelManagementUrl();
    await shell.openExternal(managementPageUrl(url));
  });
}
