/**
 * Create a reusable CLAUDE_CONFIG_DIR seeded with the shared test gateway
 * credentials, for GUI validation without touching ~/.claude/settings.json.
 *
 * Background: AgentHostProcess spawns the Host with {...process.env}, and the
 * Host honors CLAUDE_CONFIG_DIR (claudeSettings.ts). So launching the app with
 * this env var pointed at a seeded dir routes all GUI sessions through the
 * test gateway. See execution plan §4 "测试凭证统一约定".
 *
 * The config dir lives in a stable, non-temp location (not os.tmpdir()) so it
 * survives Windows storage-sense cleanup and reruns don't lose session
 * history evidence. See docs/plans/2026-08-11-xvqiu1-triage.md §2.
 *
 * A launch-gui-test.cmd wrapper is generated inside the config dir: copy it
 * next to AiClient.exe and double-click it. It bakes in CLAUDE_CONFIG_DIR at
 * generation time, so launching "directly" can no longer silently drop the
 * env var and route sessions to the real ~/.claude.
 *
 * Usage:
 *   node scripts/make-test-claude-config.mjs [workspacePath ...]
 *
 * Each workspacePath gets trust flags seeded in .claude.json (prevents cli.js
 * first-run onboarding/trust hangs). The repo root is always seeded. Re-running
 * merges new workspaces into the existing config dir.
 *
 * Env overrides: AICLIENT_TEST_AUTH_TOKEN / AICLIENT_TEST_BASE_URL /
 * AICLIENT_TEST_CONFIG_DIR (redirects the config dir itself, highest
 * precedence; used by CI/smoke to avoid touching the real home dir).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveConfigDir() {
  if (process.env.AICLIENT_TEST_CONFIG_DIR) {
    return path.resolve(process.env.AICLIENT_TEST_CONFIG_DIR);
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'aiclient-gui-test-config');
  }
  return path.join(os.homedir(), '.aiclient-gui-test-config');
}

const configDir = resolveConfigDir();

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

// Wrapper: bakes the absolute config dir in at generation time, so a direct
// double-click launch of AiClient.exe can no longer silently drop
// CLAUDE_CONFIG_DIR and fall back to the real ~/.claude. Copy this file next
// to AiClient.exe and double-click it; it also accepts the exe path as %1 if
// the exe isn't sitting alongside it.
const wrapperPath = path.join(configDir, 'launch-gui-test.cmd');
const wrapperLines = [
  '@echo off',
  `set "CLAUDE_CONFIG_DIR=${configDir}"`,
  'set "APP=%~dp0AiClient.exe"',
  'if exist "%APP%" goto :launch',
  'if not "%~1"=="" (',
  '  set "APP=%~1"',
  '  goto :launch',
  ')',
  'echo Usage: copy this .cmd next to AiClient.exe and double-click it,',
  'echo   or run: launch-gui-test.cmd "C:\\path\\to\\AiClient.exe"',
  'pause',
  'exit /b 1',
  '',
  ':launch',
  'start "" "%APP%"',
  '',
];
fs.writeFileSync(wrapperPath, wrapperLines.join('\r\n'));

console.log(`[make-test-claude-config] config dir ready: ${configDir}`);
console.log(`  gateway: ${baseUrl}`);
console.log(`  trusted workspaces: ${Object.keys(config.projects).join(', ')}`);
console.log(`  wrapper: ${wrapperPath}`);
console.log('');
console.log('Canonical launch (Windows, packaged): copy launch-gui-test.cmd next to');
console.log('AiClient.exe and double-click it — it bakes in CLAUDE_CONFIG_DIR, so a');
console.log("direct launch can't silently change the config dir. Or run it once with the");
console.log('exe path as an argument: launch-gui-test.cmd "C:\\path\\to\\AiClient.exe"');
console.log('');
console.log('Fallback: launch with the env var set manually, e.g.:');
console.log(`  PowerShell:  $env:CLAUDE_CONFIG_DIR='${configDir}'; pnpm dev`);
console.log(`  bash:        CLAUDE_CONFIG_DIR='${configDir}' pnpm dev`);
console.log(`  packaged:    $env:CLAUDE_CONFIG_DIR='${configDir}'; .\\AiClient.exe`);
