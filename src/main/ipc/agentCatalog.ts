/**
 * D48 S2 §4.1 — `chat:listAgentModels`.
 *
 * A thin relay by design: every decision (credentials, cache, fallback rung,
 * family filter) belongs to `AgentCatalogService`, which is testable without
 * `electron`. The handler's own job is to refuse a malformed `agent` before it
 * reaches a `Record<AgentWireName, …>` lookup — an unknown slug arriving over
 * IPC would otherwise index that table with `undefined` and throw inside the
 * service.
 */

import { IPC_CHANNELS } from '@shared/types';
import type { AgentModelCatalog, ListAgentModelsRequest } from '@shared/types/agentCatalog';
import { isAgentWireName } from '@shared/types/agentWire';
import { ipcMain } from 'electron';
import { getAgentCatalogService } from '../services/agentCatalog';

export function registerAgentCatalogHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_LIST_AGENT_MODELS,
    async (_e, payload: ListAgentModelsRequest): Promise<AgentModelCatalog> => {
      const agent = payload?.agent;
      if (!isAgentWireName(agent)) {
        throw new Error(`chat:listAgentModels: unknown agent ${String(agent)}`);
      }
      return getAgentCatalogService().list({ agent, force: payload.force === true });
    }
  );
}
