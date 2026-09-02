/**
 * `env` field shape in Claude `settings.json`
 */
export interface ClaudeSettingsEnv {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
  ANTHROPIC_SMALL_FAST_MODEL?: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
  [key: string]: string | undefined;
}

/**
 * Claude `settings.json` (partial)
 */
export interface ClaudeSettings {
  env?: ClaudeSettingsEnv;
  model?: string;
  hooks?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  [key: string]: unknown;
}
