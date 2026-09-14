/**
 * P5-3 — the MCP bridge: declared servers become tools the model can call.
 *
 * ## Shape
 *
 * Connecting is IO, and Cordis service constructors are synchronous, so this
 * follows the same split the session store and the skills catalog use:
 * {@link connectMcpServers} does the work, the plugin wraps the result and
 * registers what it found. A server that fails to start is recorded and the
 * others still come up — one broken entry in a config file must not cost a
 * session every other tool.
 *
 * ## Naming
 *
 * `mcp__<server>__<tool>`, the convention the ecosystem already uses. The
 * prefix is not decoration: it is what tells a permission rule, an approval
 * card and a transcript row that this call leaves the machine's own tool set,
 * and what keeps two servers that both publish `search` apart.
 *
 * ## Permission
 *
 * Every call goes through `runtimePermissions.authorize` before it reaches the
 * server. An MCP tool can do anything its server can do, and unlike `read` or
 * `bash` there is nothing local to inspect — no path to check, no command to
 * parse. So the gate is asked with the workspace as the subject and the
 * arguments as the preview, which lands on `ask` under both the default and the
 * accept-edits gear, and on `allow` only under `auto`. That is deliberate: an
 * unknown-effect tool should not inherit the trust granted to edits.
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { type Context, Service } from 'cordis';
import type { TSchema } from 'typebox';
import {
  EXEC_SERVICE,
  HOST_IO_SERVICE,
  type RuntimeExecService,
  type RuntimeHostIoService,
} from '../../contracts.ts';
import { PERMISSIONS_SERVICE } from '../permissions/index.ts';
import { TOOLS_SERVICE } from '../tools/index.ts';
import { McpClient, type McpToolDefinition } from './client.ts';
import {
  loadMcpConfig,
  type McpConfigDiagnostic,
  type McpServerConfig,
  mcpConfigSource,
} from './config.ts';

export const MCP_SERVICE = 'runtimeMcp';

/** Handshake budget. A server that cannot introduce itself in this is not usable. */
export const MCP_CONNECT_TIMEOUT_MS = 30_000;
/** Per-call budget, matching the bash tool's default so one hung tool cannot outlast a turn. */
export const MCP_CALL_TIMEOUT_MS = 120_000;
/** Tool output is folded into the conversation, so it shares the tool budget. */
export const MCP_OUTPUT_BYTES = 50 * 1024;

export interface McpConnection {
  server: McpServerConfig;
  client: McpClient;
  tools: McpToolDefinition[];
  /** Populated when this server failed to start or to introduce itself. */
  error?: string;
}

export interface RuntimeMcpService {
  readonly connections: readonly McpConnection[];
  readonly diagnostics: readonly McpConfigDiagnostic[];
  /** Shut every server down. Called by the plugin's own disposal. */
  close(): Promise<void>;
}

declare module 'cordis' {
  interface Context {
    runtimeMcp: RuntimeMcpService;
  }
}

export interface McpConfig {
  agentDir?: string;
  cwd?: string;
  projectTrusted?: boolean;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Diagnostics sink. Server stderr is noisy and belongs in a log, not a card. */
  log?: (...args: unknown[]) => void;
}

/** `mcp__<server>__<tool>`, clamped to what a provider accepts as a tool name. */
export function mcpToolName(server: string, tool: string): string {
  const safe = (value: string) => value.replace(/[^\w.-]/g, '_');
  return `mcp__${safe(server)}__${safe(tool)}`.slice(0, 64);
}

export interface McpCatalog {
  connections: McpConnection[];
  diagnostics: McpConfigDiagnostic[];
}

/**
 * Start every declared server and ask each for its tools.
 *
 * Servers are started in parallel: they are independent processes and a slow
 * one must not delay a session's start by the sum of everyone's handshakes.
 */
export async function connectMcpServers(
  io: RuntimeHostIoService,
  exec: RuntimeExecService,
  config: McpConfig
): Promise<McpCatalog> {
  const loaded = await loadMcpConfig(mcpConfigSource(io), {
    ...(config.agentDir ? { agentDir: config.agentDir } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    ...(config.projectTrusted ? { projectTrusted: true } : {}),
  });
  const connections = await Promise.all(
    loaded.servers.map((server) => connectOne(exec, server, config))
  );
  return { connections, diagnostics: loaded.diagnostics };
}

async function connectOne(
  exec: RuntimeExecService,
  server: McpServerConfig,
  config: McpConfig
): Promise<McpConnection> {
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
    client = new McpClient({
      child,
      timeoutMs: config.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
      callTimeoutMs: config.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
    });
    await client.initialize();
    const tools = await client.listTools();
    return { server, client, tools };
  } catch (error) {
    await client?.close().catch(() => undefined);
    return {
      server,
      client: client as McpClient,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  const parts = result.content
    .map((part) => (part.type === 'text' && part.text ? part.text : `[${part.type}]`))
    .join('\n');
  return parts.length > MCP_OUTPUT_BYTES
    ? `${parts.slice(0, MCP_OUTPUT_BYTES)}\n[output truncated]`
    : parts;
}

export class McpPlugin extends Service implements RuntimeMcpService {
  static inject = [HOST_IO_SERVICE, EXEC_SERVICE, TOOLS_SERVICE, PERMISSIONS_SERVICE];
  readonly connections: readonly McpConnection[];
  readonly diagnostics: readonly McpConfigDiagnostic[];
  private readonly cwd: string;

  constructor(ctx: Context, input: { catalog: McpCatalog; cwd: string }) {
    super(ctx, MCP_SERVICE);
    this.connections = input.catalog.connections;
    this.diagnostics = input.catalog.diagnostics;
    this.cwd = input.cwd;
    for (const connection of this.connections) {
      if (connection.error) continue;
      for (const tool of connection.tools) ctx.runtimeTools.register(this.bind(connection, tool));
    }
    ctx.effect(() => () => this.close());
  }

  private bind(connection: McpConnection, tool: McpToolDefinition): AgentTool<TSchema, unknown> {
    const name = mcpToolName(connection.server.name, tool.name);
    return {
      name,
      label: `${connection.server.name}: ${tool.name}`,
      description:
        tool.description ?? `Tool "${tool.name}" from the ${connection.server.name} MCP server.`,
      // The server's own JSON Schema, forwarded verbatim. It is what the model
      // is shown, so a rewritten copy would be a second source of truth about
      // what the server accepts — and the server validates its own arguments
      // regardless.
      parameters: tool.inputSchema as unknown as TSchema,
      execute: async (id, params, signal): Promise<AgentToolResult<unknown>> => {
        const args = (params ?? {}) as Record<string, unknown>;
        await this.ctx.runtimePermissions.authorize(
          {
            tool: name,
            toolCallId: id,
            path: this.cwd,
            // T002 — `name` is `mcp__<server>__<tool>`, sanitized and clamped
            // for the model's tool-name alphabet; it is not the ecosystem's
            // `mcp` policy surface, nor is it the `server:tool` shape a policy
            // author writes rules against. Both are passed explicitly so a
            // rule like `"mcp": "deny"` or `"mcp": {"echo:*": "deny"}` is
            // actually consulted instead of silently never matching.
            policySurface: 'mcp',
            policyValue: `${connection.server.name}:${tool.name}`,
            preview: { label: 'Arguments', text: JSON.stringify(args, null, 2).slice(0, 4000) },
          },
          signal
        );
        signal?.throwIfAborted();
        const result = await connection.client.callTool(tool.name, args);
        // MCP's `isError` is the SERVER reporting a tool-level failure — a
        // missing file, a rejected query — which the model is meant to read and
        // react to. Throwing here would end the tool call as a runtime fault
        // and hide the server's own explanation, so it is labelled in the text
        // instead. A transport fault is a different thing and does throw.
        const text = textOf(result);
        return {
          content: [
            { type: 'text', text: result.isError ? `[tool reported an error]\n${text}` : text },
          ],
          details: {
            server: connection.server.name,
            tool: tool.name,
            isError: result.isError === true,
          },
        };
      },
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      this.connections.filter((item) => !item.error).map((item) => item.client.close())
    );
  }
}
