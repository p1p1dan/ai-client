import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Create a shadow copy of ~/.claude/settings.json with ANTHROPIC_BASE_URL
 * and ANTHROPIC_AUTH_TOKEN stripped from the env field.
 *
 * Claude CLI reads this shadow config for all other settings (model, timeout,
 * permissions, hooks, etc.), while the two stripped fields are injected via
 * process environment variables at spawn time.
 *
 * Falls back to the null config dir if the source settings.json is missing
 * or unreadable.
 */
export function prepareShadowClaudeConfig(): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const shadowDir = join(home, '.ensoai', 'claude-shadow');
  const shadowSettingsPath = join(shadowDir, 'settings.json');

  // Ensure directory exists
  if (!existsSync(shadowDir)) {
    mkdirSync(shadowDir, { recursive: true, mode: 0o700 });
  }

  // Read the user's real settings.json
  const sourceDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const sourcePath = join(sourceDir, 'settings.json');

  try {
    if (!existsSync(sourcePath)) {
      writeFileSync(shadowSettingsPath, '{}\n', { encoding: 'utf-8', mode: 0o600 });
      return shadowDir;
    }

    const raw = readFileSync(sourcePath, 'utf-8');
    const settings = JSON.parse(raw);

    // Strip the two fields that will be injected via process env
    if (settings.env) {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
    }

    writeFileSync(shadowSettingsPath, JSON.stringify(settings, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });

    return shadowDir;
  } catch (error) {
    console.warn('[claudeNullConfig] Failed to prepare shadow config, falling back to null:', error);
    return ensureClaudeNullConfigDir();
  }
}

