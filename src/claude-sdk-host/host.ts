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
 *   AICLIENT_CLAUDE_SDK_SETTING_SOURCES  comma list of 'project' / 'local' / 'user', or empty
 *   AICLIENT_CLAUDE_SDK_CLI          optional pathToClaudeCodeExecutable (e.g. a .js build run by node)
 *   AICLIENT_CLAUDE_SDK_CLIENT_APP   User-Agent suffix
 *   AICLIENT_CLAUDE_SDK_RG_DIR       optional directory with an `rg` used instead of the CLI's built-in one
 *
 * Probes only, never set by Main:
 *   AICLIENT_CLAUDE_SDK_HOME         a stand-in home directory whose `.claude` is excluded
 *                                    besides the user's own (S-3 P-5)
 *
 * The gateway key is never a launch variable (route B S-3, topic
 * s3-project-config.md K-5): on Linux a process's initial environment stays
 * readable in /proc/<pid>/environ. Main sends it as the first IPC message,
 * `{ type: 'host.secret', apiKey }`; worker requests that arrive before it wait.
 * The CLI never gets it either: it talks to this host's loopback auth proxy
 * with a session token (`authProxy.ts`).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { BridgeRpcServer } from '../dsh-host/bridge/bridgeRpcServer.ts';
import { CLAUDE_SDK_HOST_SECRET, isClaudeSdkHostSecret } from '../shared/claudeSdkEngine.ts';
import { type AuthProxy, startAuthProxy } from './authProxy.ts';
import { findGitBash } from './cliEnvironment.ts';
import { sanitizeHostLogLine } from './failureMapping.ts';
import { buildHostConfig } from './hostConfig.ts';
import { ClaudeSdkSessionRuntime, type SdkHostConfig } from './sdkSessionRuntime.ts';

/** The gateway key and the session token, once known: blanked out of every line that leaves. */
const logSecrets: string[] = [];
/** How long the host waits for Main's secret before it gives up (Main sends it at once). */
const SECRET_TIMEOUT_MS = 10_000;

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

if (
  ripgrepDir &&
  !existsSync(path.join(ripgrepDir, process.platform === 'win32' ? 'rg.exe' : 'rg'))
) {
  log(`warning: no rg in ${ripgrepDir}; the CLI falls back to its built-in one`);
}
/** The host's configuration once the key is in: the CLI reaches the gateway through `proxy`. */
function hostConfig(proxy: AuthProxy, apiKey: string): SdkHostConfig {
  const { config, credentialedProxies } = buildHostConfig({
    inherited: process.env,
    configDir,
    settingSources,
    ...(gitBashPath ? { gitBashPath } : {}),
    ...(ripgrepDir ? { ripgrepDir } : {}),
    apiKey,
    proxy,
    // Probes only: a stand-in home directory (S-3 P-5). Main never sets it.
    ...(process.env.AICLIENT_CLAUDE_SDK_HOME?.trim()
      ? { homeDir: process.env.AICLIENT_CLAUDE_SDK_HOME.trim() }
      : {}),
  });
  log(
    `start pid=${process.pid} generation=${generation} gitBash=${gitBashPath ?? '(none)'} rg=${ripgrepDir ?? '(built-in)'} settingSources=[${settingSources.join(',')}] cli=${config.cliPath ?? '(bundled native)'} pinned=${Object.keys(config.settingsEnv).length} proxy=${proxy.url}`
  );
  if (credentialedProxies.length > 0) {
    // Their values never reach the CLI's command line; a repository's env can override them.
    log(`warning: not pinned (proxy URL with credentials): ${credentialedProxies.join(',')}`);
  }
  return config;
}

let runtime: ClaudeSdkSessionRuntime | null = null;
let proxy: AuthProxy | null = null;
let server: BridgeRpcServer | null = null;
/** Worker requests that came before the secret, answered once the host is up. */
const early: unknown[] = [];

async function start(apiKey: string): Promise<void> {
  logSecrets.push(apiKey);
  proxy = await startAuthProxy({ upstream: baseUrl, apiKey, log });
  logSecrets.push(proxy.token);
  const config = hostConfig(proxy, apiKey);
  server = new BridgeRpcServer({
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
      void proxy?.close();
      setTimeout(() => process.exit(0), 50);
    },
  });
  for (const message of early.splice(0)) server.receive(message);
}

const secretTimer = setTimeout(() => {
  log(`no ${CLAUDE_SDK_HOST_SECRET} from Main within ${SECRET_TIMEOUT_MS} ms; exiting`);
  process.exit(1);
}, SECRET_TIMEOUT_MS);
let starting = false;
process.on('message', (message) => {
  if (server) {
    server.receive(message);
    return;
  }
  if (!starting && isClaudeSdkHostSecret(message)) {
    starting = true;
    clearTimeout(secretTimer);
    start(message.apiKey).catch((error) => {
      log('the host could not start', error);
      process.exit(1);
    });
    return;
  }
  // Never logged: before the secret, a message may be anything Main sends first.
  early.push(message);
});
process.on('disconnect', () => {
  // Main went away without a dispose: close the CLI child first so it is not orphaned.
  log('IPC channel closed; exiting');
  const done = () => process.exit(0);
  setTimeout(done, 3_000).unref();
  void (runtime?.dispose() ?? Promise.resolve()).finally(() => {
    void proxy?.close();
    done();
  });
});
process.on('uncaughtException', (error) => log('uncaught', error));
process.on('unhandledRejection', (error) => log('unhandled rejection', error));
