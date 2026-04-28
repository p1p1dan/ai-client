import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readJsonSafe(filePath: string): Record<string, unknown> {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeJson(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

/**
 * Merge `{ autoUpdates: false }` into ~/.claude/settings.json without dropping
 * any user-customised keys. Claude Code's auto-update silently pulls the
 * latest (Bun) build, which falls outside the TEC OCular Agent whitelist —
 * so we pin the runtime to the last Node release (2.1.112) and disable the
 * background updater immediately after every install/downgrade.
 */
export function disableClaudeAutoUpdates(): void {
  const settingsPath = getClaudeSettingsPath();
  const current = readJsonSafe(settingsPath);
  if (current.autoUpdates === false) {
    return;
  }
  writeJson(settingsPath, { ...current, autoUpdates: false });
}

/**
 * Merge environment variables (e.g. ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)
 * into ~/.claude/settings.json under the top-level `env` key. Claude Code reads
 * this on launch and exports the values into its child process, so the values
 * propagate to both the AiClient-spawned PTY and the standalone VSCode
 * extension without touching the Windows registry.
 *
 * Pass `null` for a key to remove it.
 */
export function mergeClaudeEnvSettings(env: Record<string, string | null>): void {
  const settingsPath = getClaudeSettingsPath();
  const current = readJsonSafe(settingsPath);
  const existingEnv =
    current.env && typeof current.env === 'object'
      ? { ...(current.env as Record<string, string>) }
      : {};

  let mutated = false;
  for (const [key, value] of Object.entries(env)) {
    if (value === null) {
      if (key in existingEnv) {
        delete existingEnv[key];
        mutated = true;
      }
    } else if (existingEnv[key] !== value) {
      existingEnv[key] = value;
      mutated = true;
    }
  }

  if (!mutated) return;

  writeJson(settingsPath, { ...current, env: existingEnv });
}

