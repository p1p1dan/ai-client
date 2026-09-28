/**
 * P5-3 — the MCP bridge: declared servers become tools the model can call.
 *
 * dsh-rebase P1-16 prep: the connect phase, the client, the declarations, the
 * tool naming and the result folding moved to `src/shared/mcp/` and are
 * re-exported below under their old names. What stays here is the runtime's
 * own: the Cordis service that registers each tool with `runtimeTools` and
 * puts every call to `runtimePermissions`, and the runtime's error type.
 * P1-12 deletes this file with the runtime.
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
import type { McpClient, McpToolDefinition } from '../../../shared/mcp/client.ts';
import {
  connectMcpServers as connectSharedMcpServers,
  type McpCatalog,
  type McpConfig,
  type McpConnection,
} from '../../../shared/mcp/connect.ts';
import {
  MCP_POLICY_SURFACE,
  mcpArgumentsPreview,
  mcpPolicyValue,
  mcpToolName,
} from '../../../shared/mcp/naming.ts';
import { foldMcpToolResult } from '../../../shared/mcp/results.ts';
import {
  EXEC_SERVICE,
  HOST_IO_SERVICE,
  type RuntimeExecService,
  type RuntimeHostIoService,
} from '../../contracts.ts';
import { errorCode } from '../../host/errors.ts';
import { PERMISSIONS_SERVICE } from '../permissions/index.ts';
import { TOOLS_SERVICE } from '../tools/index.ts';
import { runtimeMcpError } from './client.ts';
import type { McpConfigDiagnostic } from './config.ts';

export {
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECT_ALL_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  type McpCatalog,
  type McpConfig,
  type McpConnection,
} from '../../../shared/mcp/connect.ts';
export { mcpToolName } from '../../../shared/mcp/naming.ts';
export {
  MCP_IMAGE_BYTES,
  MCP_IMAGE_TOTAL_BYTES,
  MCP_MAX_IMAGES,
  MCP_OUTPUT_BYTES,
} from '../../../shared/mcp/results.ts';

export const MCP_SERVICE = 'runtimeMcp';

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

/**
 * Start every declared server and ask each for its tools, through the
 * runtime's HostIo and exec exits. See `src/shared/mcp/connect.ts`; the only
 * thing added here is the runtime's error type on every client.
 */
export function connectMcpServers(
  io: RuntimeHostIoService,
  exec: RuntimeExecService,
  config: McpConfig
): Promise<McpCatalog> {
  return connectSharedMcpServers(io, exec, {
    ...config,
    createError: config.createError ?? runtimeMcpError,
  });
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
      if (connection.error || !connection.client) continue;
      for (const tool of connection.tools) {
        try {
          ctx.runtimeTools.register(this.bind(connection, connection.client, tool));
        } catch (error) {
          // The registry rejects a duplicate name outright, and two of a
          // server's tools can land on one name after clamping. Thrown from a
          // service constructor that is what kills the whole session's
          // bootstrap, so one unpublishable tool is recorded and the rest of
          // this server — and every other one — still comes up.
          const message = error instanceof Error ? error.message : String(error);
          const code = errorCode(error);
          connection.toolErrors = [
            ...(connection.toolErrors ?? []),
            `${tool.name}: ${code ? `${code} ` : ''}${message}`,
          ];
        }
      }
    }
    ctx.effect(() => () => this.close());
  }

  private bind(
    connection: McpConnection,
    client: McpClient,
    tool: McpToolDefinition
  ): AgentTool<TSchema, unknown> {
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
            policySurface: MCP_POLICY_SURFACE,
            policyValue: mcpPolicyValue(connection.server.name, tool.name),
            preview: mcpArgumentsPreview(args),
          },
          signal
        );
        signal?.throwIfAborted();
        // The signal goes all the way in, the way it does for `bash`: without
        // it a stopped turn still waits out the call budget, and the server
        // keeps working on an answer no one will read.
        const result = await client.callTool(tool.name, args, signal);
        // A server-reported `isError` is labelled in the text, not thrown; a
        // transport fault already threw above. See `foldMcpToolResult`.
        const folded = foldMcpToolResult(result);
        return {
          content: folded.content,
          details: {
            server: connection.server.name,
            tool: tool.name,
            isError: folded.isError,
            images: folded.images,
          },
        };
      },
    };
  }

  async close(): Promise<void> {
    // Keyed on the client, not on `error`: a connection can be marked failed
    // after its process is already up, and skipping it there would orphan a
    // server that keeps the worker alive.
    await Promise.allSettled(
      this.connections.map((item) => item.client?.close()).filter((item) => item !== undefined)
    );
  }
}
