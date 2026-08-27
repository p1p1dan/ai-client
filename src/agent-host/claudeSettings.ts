/**
 * Load Claude Code user settings (~/.claude/settings.json) for Host runtime,
 * then let Main's vault credential win over it.
 *
 * ## Why there are two sources (S0' / D60)
 *
 * Before D60 there was one: Main wrote the vault credential into
 * `<userData>/claude-home/settings.json` and pointed `CLAUDE_CONFIG_DIR` at
 * that directory, so "the settings file" and "our credential" were the same
 * thing. That only worked by making the user's real `~/.claude` invisible —
 * their CLAUDE.md, `commands/`, `skills/` and `plugins/` went with it.
 *
 * D60 took the redirection away. The file this module reads is now the USER'S
 * own `~/.claude/settings.json` again (or whatever `CLAUDE_CONFIG_DIR` they
 * set themselves — that variable is Claude Code's public convention and we
 * honor it, we just no longer set it for them), and Main hands its credential
 * over as env instead.
 *
 * So the precedence rule below is the ONE thing that replaces directory
 * control: a managed credential beats the same key in the user's file. Without
 * it, a stale `ANTHROPIC_AUTH_TOKEN` in a user's settings.json would silently
 * shadow the account they logged into our app with.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface ClaudeSettingsDiagnostics {
  settingsPath: string;
  loaded: boolean;
  hasAuthToken: boolean;
  hasApiKey: boolean;
  /** Precedence-resolved credential type actually in effect for the Host env (never the value itself). */
  authTokenType: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY' | 'none';
  hasBaseUrl: boolean;
  baseHost: string | null;
  model: string | null;
  /**
   * S0' (D60) — WHERE the credential in force came from, never its value.
   * `'managed'`: Main's vault, injected as env. `'settings'`: the user's own
   * settings.json. `'none'`: neither had one. This is the first question asked
   * when a user reports "it's using the wrong account", and before D60 it was
   * unanswerable — there was only ever one file, so the answer was always the
   * same and therefore told you nothing.
   */
  credentialSource: 'managed' | 'settings' | 'none';
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
 * Write side: `src/main/services/agent-host/hostEnv.ts`. Spelled as literals
 * on both sides on purpose — Main and the Agent Host are separate builds and
 * neither imports from the other.
 */
const MANAGED_BASE_URL_ENV_KEY = 'AICLIENT_CLAUDE_BASE_URL';
const MANAGED_AUTH_TOKEN_ENV_KEY = 'AICLIENT_CLAUDE_AUTH_TOKEN';

/**
 * Posture we used to write into the managed `settings.json` as a plain key.
 * It is ours, not the user's, so with the managed home gone it travels with
 * the managed credential as env instead of being written into a file that now
 * belongs to the user. Absent — not `'0'` — when there is no managed
 * credential, so a flag-off Host is byte-identical to what it was before.
 */
const DISABLE_NONESSENTIAL_TRAFFIC_ENV_KEY = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';

/**
 * Apply Main's vault credential over whatever the settings file supplied.
 *
 * Both halves must be present to take effect: a base URL without a token (or
 * the reverse) is a half-configured gateway, and letting one half win while
 * the other falls back to the user's file would point our URL at their token
 * — a cross-account request, which is worse than either source used whole.
 */
function applyManagedCredential(env: NodeJS.ProcessEnv): boolean {
  const baseUrl = env[MANAGED_BASE_URL_ENV_KEY];
  const authToken = env[MANAGED_AUTH_TOKEN_ENV_KEY];
  if (!baseUrl || !authToken) return false;
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = authToken;
  // Same reason the settings-file path deletes it below: a stale API key left
  // in the user's environment would otherwise race the token we just set.
  delete env.ANTHROPIC_API_KEY;
  env[DISABLE_NONESSENTIAL_TRAFFIC_ENV_KEY] = '1';
  return true;
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
    authTokenType: 'none',
    hasBaseUrl: false,
    baseHost: null,
    model: null,
    credentialSource: 'none',
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

  // S0' (D60): AFTER the file, so the managed credential wins. A failed read
  // above is not a reason to skip this — the user simply may not have a
  // settings.json, which is the normal case for someone whose only credential
  // is the one they logged into this app with.
  const managed = applyManagedCredential(env);
  diagnostics.credentialSource = managed
    ? 'managed'
    : env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY
      ? 'settings'
      : 'none';

  diagnostics.hasAuthToken = Boolean(env.ANTHROPIC_AUTH_TOKEN);
  diagnostics.hasApiKey = Boolean(env.ANTHROPIC_API_KEY);
  diagnostics.authTokenType = diagnostics.hasAuthToken
    ? 'ANTHROPIC_AUTH_TOKEN'
    : diagnostics.hasApiKey
      ? 'ANTHROPIC_API_KEY'
      : 'none';
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
