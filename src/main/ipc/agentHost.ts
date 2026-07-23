import { CLAUDE_AGENT_SDK_PIN_VERSION, COMETIX_PIN } from '@shared/agentHost/cometixPin';
import type { AgentHostDriver } from '@shared/types/agentHost';
import { ipcMain } from 'electron';
import { agentHostManager } from '../services/agent-host/AgentHostManager';
import { resolveNode24Runtime } from '../services/agent-host/NodeRuntimeResolver';

export function registerAgentHostHandlers(): void {
  ipcMain.handle('agentHost:resolveNode', async () => {
    return resolveNode24Runtime();
  });

  ipcMain.handle('agentHost:getStatus', async () => {
    return {
      ...agentHostManager.getStatus(),
      cometixPin: COMETIX_PIN,
      agentSdkVersion: CLAUDE_AGENT_SDK_PIN_VERSION,
      tsdDecryptVerified: false,
      tsdNote: 'TSD decrypt verification requires a real encrypted machine — pending',
    };
  });

  ipcMain.handle('agentHost:start', async (_e, driver?: AgentHostDriver) => {
    await agentHostManager.ensureStarted(driver);
    return agentHostManager.getStatus();
  });

  ipcMain.handle('agentHost:stop', async () => {
    await agentHostManager.shutdown();
    return agentHostManager.getStatus();
  });
}

export async function cleanupAgentHost(): Promise<void> {
  await agentHostManager.shutdown();
}

export function cleanupAgentHostSync(): void {
  void agentHostManager.shutdown();
}
