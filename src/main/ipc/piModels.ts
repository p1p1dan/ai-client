import type {
  PiModelManagementSettings,
  PiModelSyncResult,
  SyncPiModelsRequest,
} from '@shared/piModelConfig';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain, shell } from 'electron';
import { workerManager } from '../services/agent-host/WorkerManager';
import { resolveManagedCredentialsEnabled } from '../services/auth/credentialMode';
import {
  getManagedPiSyncFailure,
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
      // Widened rather than given a channel of its own: the sync state file
      // describes the CATALOG, and the two credential refusals never write one
      // — so "the login-time sync failed and why" has no home in `state`, and
      // every reader of it needs `managed` from this same reply anyway.
      lastFailure: getManagedPiSyncFailure(),
    })
  );

  ipcMain.handle(
    IPC_CHANNELS.PI_MODELS_SYNC,
    async (_event, payload: SyncPiModelsRequest = {}): Promise<PiModelSyncResult> => {
      const endpointUrl = payload.endpointUrl?.trim()
        ? setPiModelManagementUrl(payload.endpointUrl)
        : getPiModelManagementUrl();
      const result = await syncManagedPiModels(endpointUrl, { force: true });
      if (result.ok) await workerManager.invalidateAll();
      return result;
    }
  );

  ipcMain.handle(IPC_CHANNELS.PI_MODELS_OPEN_ADMIN, async (_event, endpointUrl?: string) => {
    const url = endpointUrl?.trim() || getPiModelManagementUrl();
    await shell.openExternal(managementPageUrl(url));
  });
}
