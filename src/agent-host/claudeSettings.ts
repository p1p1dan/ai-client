/**
 * Load Claude Code user settings (~/.claude/settings.json) for Host runtime.
 * Credentials live in settings.env — inject into process / SDK child env.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface ClaudeSettingsDiagnostics {
  settingsPath: string;
  loaded: boolean;
  hasAuthToken: boolean;
  hasApiKey: boolean;
  hasBaseUrl: boolean;
  baseHost: string | null;
  model: string | null;
  error?: string;
}

export interface ClaudeSettingsLoadResult {
  /** Merged env suitable for SDK `options.env` (includes process.env). */
  env: NodeJS.ProcessEnv;
  diagnostics: ClaudeSettingsDiagnostics;
}

function defaultSettingsPath(): string {
  return path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'),
    'settings.json'
  );
}

/**
 * Read settings.json and merge `env` into a copy of process.env.
 * Prefer ANTHROPIC_AUTH_TOKEN over a stale ANTHROPIC_API_KEY when both exist.
 */
export async function loadClaudeSettingsEnv(
  settingsPath = defaultSettingsPath()
): Promise<ClaudeSettingsLoadResult> {
  const diagnostics: ClaudeSettingsDiagnostics = {
    settingsPath,
    loaded: false,
    hasAuthToken: false,
    hasApiKey: false,
    hasBaseUrl: false,
    baseHost: null,
    model: null,
  };
  const env: NodeJS.ProcessEnv = { ...process.env };

  try {
    const raw = await readFile(settingsPath, 'utf8');
    const json = JSON.parse(raw) as {
      model?: string;
      env?: Record<string, unknown>;
    };
    diagnostics.model = typeof json.model === 'string' ? json.model : null;
    for (const [key, value] of Object.entries(json.env ?? {})) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    if (env.ANTHROPIC_AUTH_TOKEN) {
      delete env.ANTHROPIC_API_KEY;
    }
    diagnostics.loaded = true;
  } catch (err) {
    diagnostics.error = err instanceof Error ? err.message : String(err);
  }

  diagnostics.hasAuthToken = Boolean(env.ANTHROPIC_AUTH_TOKEN);
  diagnostics.hasApiKey = Boolean(env.ANTHROPIC_API_KEY);
  diagnostics.hasBaseUrl = Boolean(env.ANTHROPIC_BASE_URL);
  if (typeof env.ANTHROPIC_BASE_URL === 'string') {
    try {
      diagnostics.baseHost = new URL(env.ANTHROPIC_BASE_URL).host;
    } catch {
      diagnostics.baseHost = 'invalid-url';
    }
  }

  return { env, diagnostics };
}
