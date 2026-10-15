import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getAppStateRoot } from '../appStatePaths';
import { ClaudeSdkProcessTransport } from './ClaudeSdkProcessTransport';
import { ensurePrivateDirectory, resolveDshHostLayout } from './DshHostProcess';
import type { WorkerTransport } from './WorkerTransport';

/**
 * Route-B prototype: which chats run on the Claude Agent SDK engine, and how
 * that engine's per-chat host is launched. Prototype branch only.
 *
 * The engine is fixed per chat:
 * - a NEW chat whose model is a Claude model runs on it when the dev switch
 *   `AICLIENT_CLAUDE_SDK_ENGINE=1` is set (unpackaged builds only);
 * - a REOPENED chat runs on the engine that created it, read off its session
 *   file: the SDK host's stubs end in {@link CLAUDE_SDK_STUB_SUFFIX}.
 *
 * The gateway address and key come from `AICLIENT_CLAUDE_SDK_BASE_URL` /
 * `AICLIENT_CLAUDE_SDK_API_KEY` in Main's environment and are handed to the
 * host process the same way; nothing is read from the credential vault and
 * nothing is written to disk.
 */

export type ChatEngine = 'dsh' | 'claude-sdk';

export const CLAUDE_SDK_STUB_SUFFIX = '.ccsdk.json';

export const CLAUDE_SDK_GATEWAY_MISSING = 'CLAUDE_SDK_GATEWAY_MISSING';

/** `CLAUDE_CONFIG_DIR` of every SDK chat, under the app state root. */
export const CLAUDE_SDK_HOME_DIR_NAME = 'claude-sdk-home';

export function isClaudeSdkEngineEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isPackaged: () => boolean = () => app.isPackaged
): boolean {
  // The switch is read first, so a build without it never touches `app`.
  return env.AICLIENT_CLAUDE_SDK_ENGINE?.trim() === '1' && !isPackaged();
}

/**
 * A Claude model, by its id. Model refs are `provider/modelId`; the prototype
 * keys on the model id alone. A product build would key on the route's
 * protocol instead (`anthropic-messages`, see `@shared/dshModelPlan`).
 */
export function isClaudeModelRef(model: string | undefined): boolean {
  if (!model) return false;
  const slash = model.indexOf('/');
  return /^claude-/i.test(slash >= 0 ? model.slice(slash + 1) : model);
}

export function engineForNewSession(model: string | undefined): ChatEngine {
  return isClaudeModelRef(model) && isClaudeSdkEngineEnabled() ? 'claude-sdk' : 'dsh';
}

export function engineForSessionFile(sessionFile: string | null | undefined): ChatEngine {
  return sessionFile?.endsWith(CLAUDE_SDK_STUB_SUFFIX) ? 'claude-sdk' : 'dsh';
}

/** Names the host may inherit from Main besides its own launch variables. */
const HOST_INHERITED = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'USERNAME',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'LOGNAME',
  'SHELL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'AICLIENT_GIT_BASH_PATH',
]);

/**
 * Start one SDK host for one chat. Runs on the same Node the DSH host runs on
 * (`resolveDshHostLayout`, so `AICLIENT_DSH_NODE` applies in dev); unpackaged
 * only, from `src/claude-sdk-host/host.ts`.
 */
export function openClaudeSdkTransport(input: {
  generation: number;
  cwd: string;
}): WorkerTransport {
  if (!existsSync(input.cwd)) {
    throw new Error(`WORKER_WORKSPACE_MISSING: session working directory is missing: ${input.cwd}`);
  }
  const baseUrl = process.env.AICLIENT_CLAUDE_SDK_BASE_URL?.trim();
  const apiKey = process.env.AICLIENT_CLAUDE_SDK_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    throw Object.assign(
      new Error(
        `${CLAUDE_SDK_GATEWAY_MISSING}: set AICLIENT_CLAUDE_SDK_BASE_URL and AICLIENT_CLAUDE_SDK_API_KEY for the Claude SDK engine`
      ),
      { code: CLAUDE_SDK_GATEWAY_MISSING }
    );
  }
  const { node } = resolveDshHostLayout({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
  const entry = path.join(app.getAppPath(), 'src', 'claude-sdk-host', 'host.ts');
  if (!existsSync(entry)) throw new Error(`CLAUDE_SDK_HOST_MISSING: ${entry}`);
  const configDir = path.join(getAppStateRoot(), CLAUDE_SDK_HOME_DIR_NAME);
  ensurePrivateDirectory(configDir);

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && HOST_INHERITED.has(name.toUpperCase())) env[name] = value;
  }
  Object.assign(env, {
    AICLIENT_CLAUDE_SDK_GENERATION: String(input.generation),
    AICLIENT_CLAUDE_SDK_CONFIG_DIR: configDir,
    AICLIENT_CLAUDE_SDK_BASE_URL: baseUrl,
    AICLIENT_CLAUDE_SDK_API_KEY: apiKey,
    // Decided in the prototype's conclusion: project-level CLAUDE.md and
    // settings only, never the user's ~/.claude (see the study, §settingSources).
    AICLIENT_CLAUDE_SDK_SETTING_SOURCES:
      process.env.AICLIENT_CLAUDE_SDK_SETTING_SOURCES?.trim() ?? 'project',
    AICLIENT_CLAUDE_SDK_CLIENT_APP: `pilab/${app.getVersion()}`,
    ...(process.env.AICLIENT_CLAUDE_SDK_CLI?.trim()
      ? { AICLIENT_CLAUDE_SDK_CLI: process.env.AICLIENT_CLAUDE_SDK_CLI.trim() }
      : {}),
    // Optional: PiLab's bundled `rg` (@vscode/ripgrep) instead of the CLI's built-in one.
    ...(process.env.AICLIENT_CLAUDE_SDK_RG_DIR?.trim()
      ? { AICLIENT_CLAUDE_SDK_RG_DIR: process.env.AICLIENT_CLAUDE_SDK_RG_DIR.trim() }
      : {}),
  });
  return new ClaudeSdkProcessTransport({ command: node, args: [entry], cwd: configDir, env });
}
