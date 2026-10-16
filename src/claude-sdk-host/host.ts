/**
 * Route-B prototype: the Claude Agent SDK worker host.
 *
 * One process per chat, started by Main (`ClaudeSdkProcessTransport.ts`) on
 * the same Node the DSH host uses, with an IPC channel. It answers the worker
 * RPC through the DSH bridge's own `BridgeRpcServer`, so Main's `WorkerSlot`
 * and everything above it are unchanged; only the session runtime behind the
 * server is new (`sdkSessionRuntime.ts`).
 *
 * Launch variables (all set by Main, none inherited from the user's shell):
 *   AICLIENT_CLAUDE_SDK_GENERATION   the slot generation this process serves
 *   AICLIENT_CLAUDE_SDK_CONFIG_DIR   app-private CLAUDE_CONFIG_DIR
 *   AICLIENT_CLAUDE_SDK_BASE_URL     gateway root
 *   AICLIENT_CLAUDE_SDK_API_KEY      gateway key (memory only, never written)
 *   AICLIENT_CLAUDE_SDK_SETTING_SOURCES  comma list of 'project' / 'local' / 'user', or empty
 *   AICLIENT_CLAUDE_SDK_CLI          optional pathToClaudeCodeExecutable (e.g. a .js build run by node)
 *   AICLIENT_CLAUDE_SDK_CLIENT_APP   User-Agent suffix
 *   AICLIENT_CLAUDE_SDK_RG_DIR       optional directory with an `rg` used instead of the CLI's built-in one
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { BridgeRpcServer } from '../dsh-host/bridge/bridgeRpcServer.ts';
import { buildCliEnvironment, buildPinnedSettingsEnv, findGitBash } from './cliEnvironment.ts';
import { sanitizeHostLogLine } from './failureMapping.ts';
import { ClaudeSdkSessionRuntime, type SdkHostConfig } from './sdkSessionRuntime.ts';

/** The gateway key, once read: blanked out of every line before it leaves the process. */
const logSecrets: string[] = [];

function log(...args: unknown[]): void {
  // stderr is Main's diagnostics channel, and Main shows it in the Host stderr
  // panel: every line, the CLI's own included, is sanitized here first.
  const line = args
    .map((a) =>
      a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a)
    )
    .join(' ');
  process.stderr.write(`[claude-sdk-host] ${sanitizeHostLogLine(line, logSecrets)}\n`);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`CLAUDE_SDK_HOST_CONFIG: ${name} is not set`);
  return value;
}

if (typeof process.send !== 'function') {
  throw new Error('CLAUDE_SDK_HOST_CONFIG: the host must be started with an IPC channel');
}

const generation = Number(required('AICLIENT_CLAUDE_SDK_GENERATION'));
const configDir = required('AICLIENT_CLAUDE_SDK_CONFIG_DIR');
// The SDK's own transcript readers (`getSessionMessages`) resolve the config dir from this process.
process.env.CLAUDE_CONFIG_DIR = configDir;
const settingSources = (process.env.AICLIENT_CLAUDE_SDK_SETTING_SOURCES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(
    (s): s is 'project' | 'local' | 'user' => s === 'project' || s === 'local' || s === 'user'
  );
const gitBashPath = process.platform === 'win32' ? findGitBash(process.env) : undefined;
// Optional: PiLab's own `rg` instead of the CLI's built-in one (see cliEnvironment.ts).
const ripgrepDir = process.env.AICLIENT_CLAUDE_SDK_RG_DIR?.trim() || undefined;
const baseUrl = required('AICLIENT_CLAUDE_SDK_BASE_URL');
const apiKey = required('AICLIENT_CLAUDE_SDK_API_KEY');
// What a repository's `.claude/settings.json` `env` may not change (decision 6); never the key.
const pinned = buildPinnedSettingsEnv({ inherited: process.env, baseUrl, gitBashPath });
const config: SdkHostConfig = {
  configDir,
  settingSources,
  cliPath: process.env.AICLIENT_CLAUDE_SDK_CLI?.trim() || undefined,
  trustRepoPolicy: process.env.AICLIENT_CLAUDE_SDK_REPO_POLICY === 'trust',
  gitBashPath,
  cliEnv: buildCliEnvironment({
    inherited: process.env,
    configDir,
    baseUrl,
    apiKey,
    clientApp: process.env.AICLIENT_CLAUDE_SDK_CLIENT_APP?.trim() || 'pilab-claude-sdk-proto/0',
    gitBashPath,
    ripgrepDir,
  }),
  settingsEnv: pinned.env,
  secrets: [apiKey],
};
// The key now lives only in `config`; drop it from this process's own environment.
delete process.env.AICLIENT_CLAUDE_SDK_API_KEY;
logSecrets.push(apiKey);

if (
  ripgrepDir &&
  !existsSync(path.join(ripgrepDir, process.platform === 'win32' ? 'rg.exe' : 'rg'))
) {
  log(`warning: no rg in ${ripgrepDir}; the CLI falls back to its built-in one`);
}
log(
  `start pid=${process.pid} generation=${generation} gitBash=${gitBashPath ?? '(none)'} rg=${ripgrepDir ?? '(built-in)'} settingSources=[${settingSources.join(',')}] cli=${config.cliPath ?? '(bundled native)'} pinned=${Object.keys(pinned.env).length}`
);
if (pinned.credentialedProxies.length > 0) {
  // Their values never reach the CLI's command line; a repository's env can override them.
  log(`warning: not pinned (proxy URL with credentials): ${pinned.credentialedProxies.join(',')}`);
}

let runtime: ClaudeSdkSessionRuntime | null = null;
const server = new BridgeRpcServer({
  port: { postMessage: (message) => process.send?.(message) },
  generation,
  projectTrusted: true,
  createRuntime: (options) => {
    runtime = new ClaudeSdkSessionRuntime(options, config, log);
    return runtime;
  },
  log,
  onDisposed: () => {
    log('disposed; exiting');
    setTimeout(() => process.exit(0), 50);
  },
});

process.on('message', (message) => server.receive(message));
process.on('disconnect', () => {
  // Main went away without a dispose: close the CLI child first so it is not orphaned.
  log('IPC channel closed; exiting');
  const done = () => process.exit(0);
  setTimeout(done, 3_000).unref();
  void (runtime?.dispose() ?? Promise.resolve()).finally(done);
});
process.on('uncaughtException', (error) => log('uncaught', error));
process.on('unhandledRejection', (error) => log('unhandled rejection', error));
