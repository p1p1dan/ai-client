// Moved from src/runtime/plugins/mcp/index.ts (dsh-rebase P1-16 prep): the connect phase — start every declared server and catalogue its tools.

/**
 * P5-3 — declared servers become connections.
 *
 * Connecting is IO, so this runs before whatever publishes the tools (the
 * 1.0.x runtime's Cordis plugin, or a DSH host row) and hands over a finished
 * {@link McpCatalog}. A server that fails to start is recorded and the others
 * still come up — one broken entry in a config file must not cost a session
 * every other tool.
 *
 * Processes come out of the host's own exec exit ({@link McpProcessLauncher}),
 * never out of `node:child_process` here: ARD D11 point 4, see `client.ts`.
 */

import type { SettingSource } from '../settingSources.ts';
import { type McpChildProcess, McpClient, type McpToolDefinition } from './client.ts';
import {
  loadMcpConfig,
  type McpConfigDiagnostic,
  type McpConfigFiles,
  type McpServerConfig,
  mcpConfigSource,
} from './config.ts';
import { createMcpError, type McpErrorFactory } from './errors.ts';

/** Handshake budget. A server that cannot introduce itself in this is not usable. */
export const MCP_CONNECT_TIMEOUT_MS = 30_000;
/**
 * Ceiling for the whole connect phase, across every declared server.
 *
 * This runs inside `createRuntime`, which Main awaits under one bounded RPC
 * (`BOOTSTRAP_REQUEST_TIMEOUT_MS`, 60s). Anything at or above that budget means
 * a single slow server does not merely lose its own tools — it fails the
 * session's creation with a generic timeout that says nothing about MCP, and it
 * does so again on every retry until the user finds and edits `mcp.json`. So it
 * is deliberately well under: what expires here is one server, not the session.
 */
export const MCP_CONNECT_ALL_TIMEOUT_MS = 45_000;
/** Per-call budget, matching the bash tool's default so one hung tool cannot outlast a turn. */
export const MCP_CALL_TIMEOUT_MS = 120_000;

export interface McpConnection {
  server: McpServerConfig;
  /** Absent when the server never started: there is no client to fake. */
  client?: McpClient;
  tools: McpToolDefinition[];
  /** Populated when this server failed to start or to introduce itself. */
  error?: string;
  /**
   * Tools this server offered that could not be published, one message each.
   *
   * Separate from {@link error} because the connection itself is fine and its
   * other tools work; folding these into `error` would report a healthy server
   * as failed and stop anything that counts failures from being meaningful.
   */
  toolErrors?: string[];
}

export interface McpCatalog {
  connections: McpConnection[];
  diagnostics: McpConfigDiagnostic[];
}

export interface McpConfig {
  agentDir?: string;
  cwd?: string;
  projectTrusted?: boolean;
  /** decision 008 — which of user / project / local `mcp.json` files to read. */
  settingSources?: readonly SettingSource[];
  connectTimeoutMs?: number;
  /** Ceiling for the whole connect phase. Defaults to {@link MCP_CONNECT_ALL_TIMEOUT_MS}. */
  connectAllTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Diagnostics sink. Server stderr is noisy and belongs in a log, not a card. */
  log?: (...args: unknown[]) => void;
  /** The error type the clients and the connect phase build. Defaults to `McpError`. */
  createError?: McpErrorFactory;
}

/** What starting one server asks of the host. */
export interface McpSpawnRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** Called with each stdout chunk, in arrival order. Framing is the client's job. */
  onStdout: (chunk: Uint8Array) => void;
  /** Called with each stderr chunk; must be drained even when unused (D11 point 5). */
  onStderr: (chunk: Uint8Array) => void;
}

/**
 * The host's exec exit for long-lived children. The runtime's
 * `RuntimeExecService` fits as is; a DSH host adapts `ctx.subprocess`.
 */
export interface McpProcessLauncher {
  spawn(request: McpSpawnRequest): Promise<McpChildProcess>;
}

/**
 * Start every declared server and ask each for its tools.
 *
 * Servers are started in parallel: they are independent processes and a slow
 * one must not delay a session's start by the sum of everyone's handshakes.
 * One shared stopwatch caps the phase as a whole, because the per-server
 * budgets are not the number Main is holding a timer against.
 */
export async function connectMcpServers(
  io: McpConfigFiles,
  exec: McpProcessLauncher,
  config: McpConfig
): Promise<McpCatalog> {
  const loaded = await loadMcpConfig(mcpConfigSource(io), {
    ...(config.agentDir ? { agentDir: config.agentDir } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.projectTrusted ? { projectTrusted: true } : {}),
    ...(config.settingSources ? { settingSources: config.settingSources } : {}),
  });
  const budgetMs = config.connectAllTimeoutMs ?? MCP_CONNECT_ALL_TIMEOUT_MS;
  const budget = connectBudget(budgetMs);
  try {
    const connections = await Promise.all(
      loaded.servers.map((server) => connectOne(exec, server, config, budget.expired, budgetMs))
    );
    return { connections, diagnostics: loaded.diagnostics };
  } finally {
    budget.cancel();
  }
}

/** A stopwatch shared by every server in one connect phase. Never rejects. */
function connectBudget(ms: number): { expired: Promise<void>; cancel: () => void } {
  let ring: () => void = () => undefined;
  const expired = new Promise<void>((resolve) => {
    ring = resolve;
  });
  const timer = setTimeout(() => ring(), ms);
  // The phase is awaited, so this timer must never be the reason a process
  // stays alive after everyone has answered.
  timer.unref?.();
  return { expired, cancel: () => clearTimeout(timer) };
}

async function connectOne(
  exec: McpProcessLauncher,
  server: McpServerConfig,
  config: McpConfig,
  expired: Promise<void>,
  budgetMs: number
): Promise<McpConnection> {
  const createError = config.createError ?? createMcpError;
  let client: McpClient | undefined;
  try {
    const child = await exec.spawn({
      command: server.command,
      args: server.args,
      cwd: config.cwd ?? process.cwd(),
      env: server.env,
      onStdout: (chunk) => client?.receive(chunk),
      // Drained and logged, never dropped: D11 point 5 — an unread pipe fills
      // and the server blocks on its own startup banner.
      onStderr: (chunk) =>
        config.log?.(`[mcp:${server.name}]`, Buffer.from(chunk).toString('utf8').trimEnd()),
    });
    const started = new McpClient({
      child,
      timeoutMs: config.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
      callTimeoutMs: config.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
      createError,
    });
    client = started;
    let tools: McpToolDefinition[] = [];
    let failure: unknown;
    const handshake = (async () => {
      await started.initialize();
      tools = await started.listTools();
      // Only now does this connection move to the per-call budget: `tools/list`
      // is part of starting up, and starting up is what Main is timing.
      started.beginCalls();
    })().then(
      () => 'ready' as const,
      (error) => {
        failure = error;
        return 'failed' as const;
      }
    );
    const outcome = await Promise.race([handshake, expired.then(() => 'expired' as const)]);
    if (outcome === 'failed') throw failure;
    if (outcome === 'expired')
      throw createError(
        'mcp_timeout',
        `${server.name} was still starting when the ${budgetMs}ms MCP connect budget ran out`
      );
    const connection: McpConnection = { server, client: started, tools };
    // A server that dies later leaves a record that still reads as healthy and
    // still lists tools. This is the only place that can correct it.
    started.onFailure = (reason) => {
      connection.error ??= reason;
    };
    return connection;
  } catch (error) {
    await client?.close().catch(() => undefined);
    return {
      server,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
