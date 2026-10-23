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
 *   AICLIENT_CLAUDE_SDK_CLI          the CLI binary Main chose (S-4 B-4), given to the SDK as
 *                                    pathToClaudeCodeExecutable; a .js build runs on this node
 *   AICLIENT_CLAUDE_SDK_CLIENT_APP   User-Agent suffix
 *   AICLIENT_CLAUDE_SDK_RG_DIR       optional directory with an `rg` used instead of the CLI's built-in one
 *   AICLIENT_CLAUDE_SDK_AUTO_COMPACT_PERCENT  the CLI's auto-compact percentage (default 60)
 *   AICLIENT_CLAUDE_SDK_DROP_EMPTY_SYSTEM     `0`: the auth proxy keeps empty system messages
 *
 * Catalog mode (dsh-rebase decision 194 Q1), instead of a chat:
 *   AICLIENT_CLAUDE_SDK_CATALOG_CWD      the folder whose slash menu Main wants; the host lists
 *                                        the CLI's commands there, sends one
 *                                        `claude-sdk.catalog` message and exits (`catalog.ts`).
 *                                        No gateway, no key: nothing is sent to a model.
 *   AICLIENT_CLAUDE_SDK_CATALOG_TRUSTED  `1` reads the folder's project layer (a project the
 *                                        user opened), else the user layer alone
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
 *
 * Dsh-rebase decision 196: the product proxy comes with the key (`proxy` in
 * `host.secret`) and again as `{ type: 'host.proxy', proxy }` whenever it
 * changes; the auth proxy's leg to the gateway follows it at once. Never a
 * launch variable, never logged: the URL may carry credentials.
 */

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { BridgeRpcServer } from '../dsh-host/bridge/bridgeRpcServer.ts';
import {
  CLAUDE_SDK_DROP_EMPTY_SYSTEM_ENV,
  CLAUDE_SDK_HOST_SECRET,
  isClaudeSdkHostProxyUpdate,
  isClaudeSdkHostSecret,
} from '../shared/claudeSdkEngine.ts';
import {
  describeHostProxy,
  type HostProxySetting,
  hostProxySecrets,
  inheritedNoProxy,
  readHostProxySetting,
} from '../shared/hostProxy.ts';
import { type AuthProxy, startAuthProxy } from './authProxy.ts';
import {
  CLAUDE_SDK_CATALOG_RESULT,
  type ClaudeSdkCatalogResult,
  listCliCommands,
} from './catalog.ts';
import { buildCliEnvironment, findGitBash } from './cliEnvironment.ts';
import { sanitizeHostLogLine } from './failureMapping.ts';
import { buildHostConfig } from './hostConfig.ts';
import { ClaudeSdkSessionRuntime, type SdkHostConfig } from './sdkSessionRuntime.ts';

/** The gateway key and the session token, once known: blanked out of every line that leaves. */
const logSecrets: string[] = [];
/** How long the host waits for Main's secret before it gives up (Main sends it at once). */
const SECRET_TIMEOUT_MS = 10_000;

/** How long a catalog host waits for the CLI's list (a cold start took up to 3.8 s). */
const CATALOG_TIMEOUT_MS = 20_000;

/** A loopback server that refuses every request at once: the catalog CLI's gateway. */
function startCatalogStub(): Promise<{ url: string; close: () => void }> {
  const server = createServer((request, response) => {
    log(`catalog: the CLI asked ${request.method} ${request.url}; refused`);
    response.writeHead(503, { 'content-type': 'application/json', 'x-should-retry': 'false' });
    response.end('{"type":"error","error":{"type":"api_error","message":"catalog only"}}');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

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

// Decision 194 Q1: catalog mode lists and exits; the chat below never starts.
const catalogCwd = process.env.AICLIENT_CLAUDE_SDK_CATALOG_CWD?.trim();
if (catalogCwd) await runCatalog(catalogCwd);

const baseUrl = required('AICLIENT_CLAUDE_SDK_BASE_URL');

if (
  ripgrepDir &&
  !existsSync(path.join(ripgrepDir, process.platform === 'win32' ? 'rg.exe' : 'rg'))
) {
  log(`warning: no rg in ${ripgrepDir}; the CLI falls back to its built-in one`);
}
/** The launch environment's NO_PROXY, still a bypass under the product proxy (decision 196 rule 8). */
const launchNoProxy = inheritedNoProxy(process.env);

/** A `proxy` value from Main: the setting, or off when it is malformed (said so). */
function outboundProxyOf(raw: unknown): HostProxySetting | null {
  const setting = readHostProxySetting(raw);
  if (setting === undefined) {
    log('warning: a malformed outbound proxy setting was ignored; model requests connect directly');
  }
  return setting ?? null;
}

async function runCatalog(cwd: string): Promise<never> {
  const started = Date.now();
  const answer = (outcome: Omit<ClaudeSdkCatalogResult, 'type' | 'ms'>) =>
    new Promise<void>((resolve) => {
      const message: ClaudeSdkCatalogResult = {
        type: CLAUDE_SDK_CATALOG_RESULT,
        ...outcome,
        ms: Date.now() - started,
      };
      process.send?.(message, () => resolve());
    });
  // The CLI opens a connection to its gateway as it starts. With nothing listening, Windows
  // took about 19 s to refuse it (measured); a loopback stub that answers every request
  // 503 at once lets the listing finish in under a second. No request reaches it.
  const stub = await startCatalogStub();
  try {
    const result = await listCliCommands(
      {
        cwd,
        projectTrusted: process.env.AICLIENT_CLAUDE_SDK_CATALOG_TRUSTED === '1',
        configDir,
        settingSources,
        // No gateway and no key: a listing sends nothing to a model.
        cliEnv: buildCliEnvironment({
          inherited: process.env,
          configDir,
          baseUrl: stub.url,
          apiKey: 'pilab-catalog-sends-nothing',
          clientApp:
            process.env.AICLIENT_CLAUDE_SDK_CLIENT_APP?.trim() || 'pilab-claude-sdk-proto/0',
          ...(gitBashPath ? { gitBashPath } : {}),
          ...(ripgrepDir ? { ripgrepDir } : {}),
        }),
        ...(process.env.AICLIENT_CLAUDE_SDK_CLI?.trim()
          ? { cliPath: process.env.AICLIENT_CLAUDE_SDK_CLI.trim() }
          : {}),
        timeoutMs: CATALOG_TIMEOUT_MS,
      },
      log
    );
    log(`catalog: ${result.commands.length} rows in ${Date.now() - started} ms`);
    await answer({ ok: true, result });
  } catch (error) {
    log('catalog failed', error);
    await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  stub.close();
  process.exit(0);
}

/** The host's configuration once the key is in: the CLI reaches the gateway through `proxy`. */
function hostConfig(
  proxy: AuthProxy,
  apiKey: string,
  outboundProxy: HostProxySetting | null | undefined
): SdkHostConfig {
  const { config, credentialedProxies } = buildHostConfig({
    inherited: process.env,
    configDir,
    settingSources,
    ...(gitBashPath ? { gitBashPath } : {}),
    ...(ripgrepDir ? { ripgrepDir } : {}),
    apiKey,
    proxy,
    ...(outboundProxy !== undefined ? { outboundProxy } : {}),
    // Probes only: a stand-in home directory (S-3 P-5). Main never sets it.
    ...(process.env.AICLIENT_CLAUDE_SDK_HOME?.trim()
      ? { homeDir: process.env.AICLIENT_CLAUDE_SDK_HOME.trim() }
      : {}),
  });
  log(
    `start pid=${process.pid} generation=${generation} gitBash=${gitBashPath ?? '(none)'} rg=${ripgrepDir ?? '(built-in)'} settingSources=[${settingSources.join(',')}] cli=${config.cliPath ?? '(bundled native)'} pinned=${Object.keys(config.settingsEnv).length} windows=${JSON.stringify(config.modelWindows ?? {})} proxy=${proxy.url} outbound=${outboundProxy === undefined ? '(launch environment)' : describeHostProxy(outboundProxy, launchNoProxy)}`
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
/** Decision 196: a proxy change that came while the host was starting. */
let pendingProxy: { setting: HostProxySetting | null } | undefined;

/** Decision 196: the product proxy changed; the leg to the gateway follows it now. */
function applyOutboundProxy(setting: HostProxySetting | null): void {
  logSecrets.push(...hostProxySecrets(setting));
  if (proxy) proxy.setProxy(setting);
  else pendingProxy = { setting };
}

async function start(apiKey: string, rawProxy: unknown): Promise<void> {
  logSecrets.push(apiKey);
  // Absent: Main keeps the engines off the product proxy (rule 10), and S-3 K-3 applies.
  const outboundProxy = rawProxy === undefined ? undefined : outboundProxyOf(rawProxy);
  logSecrets.push(...hostProxySecrets(outboundProxy));
  proxy = await startAuthProxy({
    upstream: baseUrl,
    apiKey,
    log,
    ...(outboundProxy !== undefined ? { proxy: outboundProxy } : {}),
    ...(launchNoProxy !== undefined ? { inheritedNoProxy: launchNoProxy } : {}),
    // User 2026-10-23: Main's developer switch; on unless it says `0`.
    dropEmptySystemMessages: process.env[CLAUDE_SDK_DROP_EMPTY_SYSTEM_ENV]?.trim() !== '0',
  });
  logSecrets.push(proxy.token);
  const config = hostConfig(proxy, apiKey, outboundProxy);
  if (pendingProxy) proxy.setProxy(pendingProxy.setting);
  pendingProxy = undefined;
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
  if (starting && isClaudeSdkHostProxyUpdate(message)) {
    applyOutboundProxy(outboundProxyOf(message.proxy));
    return;
  }
  if (server) {
    server.receive(message);
    return;
  }
  if (!starting && isClaudeSdkHostSecret(message)) {
    starting = true;
    clearTimeout(secretTimer);
    start(message.apiKey, message.proxy).catch((error) => {
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
