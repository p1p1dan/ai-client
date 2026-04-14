import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getClaudeNullConfigDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(home, '.ensoai', 'claude-null');
}

export function ensureClaudeNullConfigDir(): string {
  const dirPath = getClaudeNullConfigDir();
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }

  const settingsPath = join(dirPath, 'settings.json');
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, '{}\n', { encoding: 'utf-8', mode: 0o600 });
  }

  return dirPath;
}

