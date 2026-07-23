/**
 * Create a reusable CLAUDE_CONFIG_DIR seeded with the shared test gateway
 * credentials, for GUI validation without touching ~/.claude/settings.json.
 *
 * Background: AgentHostProcess spawns the Host with {...process.env}, and the
 * Host honors CLAUDE_CONFIG_DIR (claudeSettings.ts). So launching the app with
 * this env var pointed at a seeded dir routes all GUI sessions through the
 * test gateway. See execution plan §4 "测试凭证统一约定".
 *
 * Usage:
 *   node scripts/make-test-claude-config.mjs [workspacePath ...]
 *
 * Each workspacePath gets trust flags seeded in .claude.json (prevents cli.js
 * first-run onboarding/trust hangs). The repo root is always seeded. Re-running
 * merges new workspaces into the existing config dir.
 *
 * Env overrides: AICLIENT_TEST_AUTH_TOKEN / AICLIENT_TEST_BASE_URL
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configDir = path.join(os.tmpdir(), 'aiclient-gui-test-config');

const authToken = process.env.AICLIENT_TEST_AUTH_TOKEN ?? 'sk-4b0688c61944931297f2aee4ecfa0022';
const baseUrl = process.env.AICLIENT_TEST_BASE_URL ?? 'https://cch-jyw.pipidan.qzz.io';

fs.mkdirSync(configDir, { recursive: true });

fs.writeFileSync(
  path.join(configDir, 'settings.json'),
  `${JSON.stringify(
    { env: { ANTHROPIC_AUTH_TOKEN: authToken, ANTHROPIC_BASE_URL: baseUrl } },
    null,
    2
  )}\n`
);

const claudeJsonPath = path.join(configDir, '.claude.json');
let config = { hasCompletedOnboarding: true, projects: {} };
if (fs.existsSync(claudeJsonPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    config = { ...existing, hasCompletedOnboarding: true, projects: existing.projects ?? {} };
  } catch {
    // rewrite from scratch
  }
}
for (const workspace of [repoRoot, ...process.argv.slice(2)]) {
  const absolute = path.resolve(workspace);
  config.projects[absolute] = {
    ...config.projects[absolute],
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
}
fs.writeFileSync(claudeJsonPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`[make-test-claude-config] config dir ready: ${configDir}`);
console.log(`  gateway: ${baseUrl}`);
console.log(`  trusted workspaces: ${Object.keys(config.projects).join(', ')}`);
console.log('');
console.log('Launch the app with the env var set, e.g.:');
console.log(`  PowerShell:  $env:CLAUDE_CONFIG_DIR='${configDir}'; pnpm dev`);
console.log(`  bash:        CLAUDE_CONFIG_DIR='${configDir}' pnpm dev`);
console.log(`  packaged:    $env:CLAUDE_CONFIG_DIR='${configDir}'; .\\AiClient.exe`);
