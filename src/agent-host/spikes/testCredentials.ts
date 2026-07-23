/**
 * Shared test credentials for Agent Host smokes.
 *
 * Team policy: automated tests and smokes must NOT use personal/local
 * credentials from ~/.claude/settings.json — they use the shared CCH test
 * gateway below (see docs/plans/ledger-team-track.md quick-start).
 *
 * Overrides:
 *   AICLIENT_TEST_AUTH_TOKEN / AICLIENT_TEST_BASE_URL   replace the defaults
 *   AICLIENT_SMOKE_USE_LOCAL_SETTINGS=1                 keep local settings.json
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const TEST_AUTH_TOKEN =
  process.env.AICLIENT_TEST_AUTH_TOKEN ?? 'sk-4b0688c61944931297f2aee4ecfa0022';
export const TEST_BASE_URL = process.env.AICLIENT_TEST_BASE_URL ?? 'https://cch-jyw.pipidan.qzz.io';

/**
 * Build env overrides for a Host child process so it loads shared test
 * credentials instead of ~/.claude/settings.json. Uses CLAUDE_CONFIG_DIR
 * (already honored by claudeSettings.ts) pointed at a temp dir; this also
 * isolates cli.js runtime state (history JSONL etc.) from the local machine.
 *
 * The temp dir is also seeded with .claude.json onboarding/trust state —
 * a fresh config dir otherwise makes cli.js hang on first-run onboarding.
 */
export function testCredentialEnv(workspacePath?: string): Record<string, string> {
  if (process.env.AICLIENT_SMOKE_USE_LOCAL_SETTINGS === '1') return {};
  const configDir = mkdtempSync(path.join(tmpdir(), 'aiclient-smoke-config-'));
  const settings = {
    env: {
      ANTHROPIC_AUTH_TOKEN: TEST_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: TEST_BASE_URL,
    },
  };
  writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings, null, 2));
  const config: Record<string, unknown> = { hasCompletedOnboarding: true };
  if (workspacePath) {
    config.projects = {
      [workspacePath]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    };
  }
  writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify(config, null, 2));
  return { CLAUDE_CONFIG_DIR: configDir };
}
