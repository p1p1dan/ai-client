import { mkdir } from 'node:fs/promises';
import {
  type InspectLegacyAssetsRequest,
  LEGACY_ASSET_NOTICE_SETTING_KEY,
  type LegacyAssetNoticeState,
} from '@shared/legacyAssets';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain, shell } from 'electron';
import { inspectLegacyAssets } from '../services/legacyAssets';
import { getAppPiAgentDir } from '../services/piModelConfig';
import { mergeSettingsPatch } from './settings';

/**
 * dsh-rebase P1-16e (decision 104) — the legacy-asset notice.
 *
 * `inspect` only reads; the workspace path the renderer sends is validated in
 * the detection (`usableWorkspace`) and anything that is not a local absolute
 * directory is ignored rather than rejected, so the notice still lists the
 * user-level items. `markSeen` is the one write, and it writes a settings key,
 * never a user file.
 */
export function registerLegacyAssetHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.LEGACY_ASSETS_INSPECT,
    async (_event, payload?: InspectLegacyAssetsRequest): Promise<LegacyAssetNoticeState> =>
      inspectLegacyAssets(payload && typeof payload === 'object' ? payload.cwd : undefined)
  );

  ipcMain.handle(IPC_CHANNELS.LEGACY_ASSETS_MARK_SEEN, async (): Promise<void> => {
    if (!mergeSettingsPatch({ [LEGACY_ASSET_NOTICE_SETTING_KEY]: true })) {
      throw new Error('Failed to save the legacy asset notice state');
    }
  });

  ipcMain.handle(IPC_CHANNELS.LEGACY_ASSETS_OPEN_AGENT_DIR, async (): Promise<void> => {
    const agentDir = getAppPiAgentDir();
    await mkdir(agentDir, { recursive: true });
    const error = await shell.openPath(agentDir);
    if (error) throw new Error(`Failed to open the agent folder: ${error}`);
  });
}
