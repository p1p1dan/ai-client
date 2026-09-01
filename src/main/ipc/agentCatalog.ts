import { IPC_CHANNELS } from '@shared/types';
import type { AgentModelCatalog, ListPiModelsRequest } from '@shared/types/agentCatalog';
import { ipcMain } from 'electron';
import { readPiModelCatalog } from '../services/piModelConfig';

/** Pi-only catalog relay. Managed/local source selection stays in piModelConfig. */
export function registerAgentCatalogHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_LIST_PI_MODELS,
    async (_event, _payload?: ListPiModelsRequest): Promise<AgentModelCatalog> =>
      readPiModelCatalog()
  );
}
