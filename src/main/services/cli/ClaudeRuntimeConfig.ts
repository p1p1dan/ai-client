import os from 'node:os';
import path from 'node:path';
import { writeSettingsFile } from '../auth/managedFileWriter';

/** D47 S2a §1: follows `CLAUDE_CONFIG_DIR` when set (managed redirect). */
function getClaudeSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'settings.json');
}

/**
 * Merge `{ autoUpdates: false }` into the managed settings.json without
 * dropping any user-customised keys. Claude Code's auto-update silently pulls
 * the latest (Bun) build, which falls outside the TEC OCular Agent whitelist —
 * so we pin the runtime to the last Node release (2.1.112) and disable the
 * background updater immediately after every install/downgrade.
 *
 * D47 S2a §1: routed through `managedFileWriter` — the previous
 * `writeFileSync(..., { mode: undefined })` call had no explicit mode, so a
 * freshly-created settings.json could inherit the process umask instead of a
 * predictable permission; `managedFileWriter` always chmods 0600.
 */
export async function disableClaudeAutoUpdates(): Promise<void> {
  const settingsPath = getClaudeSettingsPath();
  await writeSettingsFile(settingsPath, (current) => {
    if (current.autoUpdates === false) {
      return current;
    }
    return { ...current, autoUpdates: false };
  });
}
