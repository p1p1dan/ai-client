/**
 * dsh-rebase P1-16e (decision 104) — Main's side of the legacy-asset notice:
 * the real agent directory, home and settings plugged into the pure detection.
 */

import { homedir } from 'node:os';
import { LEGACY_ASSET_NOTICE_SETTING_KEY, type LegacyAssetNoticeState } from '@shared/legacyAssets';
import { getAppPiAgentDir } from '../piModelConfig';
import { readSharedSettings } from '../SharedSessionState';
import { detectLegacyAssets } from './detectLegacyAssets';
import { nodeLegacyAssetFiles } from './nodeFiles';

/** Same resolution `piModelConfig` uses for `~/.agents/skills`. */
function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function legacyAssetNoticeSeen(settings: Record<string, unknown>): boolean {
  return settings[LEGACY_ASSET_NOTICE_SETTING_KEY] === true;
}

export async function inspectLegacyAssets(cwd?: unknown): Promise<LegacyAssetNoticeState> {
  const settings = readSharedSettings();
  const report = await detectLegacyAssets({
    files: nodeLegacyAssetFiles(),
    agentDir: getAppPiAgentDir(),
    home: homeDir(),
    cwd: typeof cwd === 'string' ? cwd : null,
    settings,
    log: (message) => console.warn(message),
  });
  return { report, seen: legacyAssetNoticeSeen(settings) };
}
