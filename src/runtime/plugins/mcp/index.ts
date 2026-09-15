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
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { type Context, Service } from 'cordis';
import type { TSchema } from 'typebox';
import {
  EXEC_SERVICE,
  HOST_IO_SERVICE,
  type RuntimeExecService,
  type RuntimeHostIoService,
} from '../../contracts.ts';
import { errorCode, RuntimeHostError } from '../../host/errors.ts';
import type { SettingSource } from '../../settingSources.ts';
import { PERMISSIONS_SERVICE } from '../permissions/index.ts';
import { TOOLS_SERVICE } from '../tools/index.ts';
import { McpClient, type McpToolDefinition, type McpToolResult } from './client.ts';
import {
  loadMcpConfig,
  type McpConfigDiagnostic,
  type McpServerConfig,
  mcpConfigSource,
} from './config.ts';

export const MCP_SERVICE = 'runtimeMcp';

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
/** Tool output is folded into the conversation, so it shares the tool budget. */
export const MCP_OUTPUT_BYTES = 50 * 1024;
/** Images bypass the text budget entirely, so their count is what is capped. */
export const MCP_MAX_IMAGES = 8;

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
  /** decision 008 — which of user / project / local `mcp.json` files to read. */
  settingSources?: readonly SettingSource[];
  connectTimeoutMs?: number;
  /** Ceiling for the whole connect phase. Defaults to {@link MCP_CONNECT_ALL_TIMEOUT_MS}. */
  connectAllTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Diagnostics sink. Server stderr is noisy and belongs in a log, not a card. */
  log?: (...args: unknown[]) => void;
}

/**
 * `mcp__<server>__<tool>`, clamped to what a provider accepts as a tool name.
 *
 * The alphabet is `[A-Za-z0-9_-]` because that is OpenAI's and Anthropic's rule
 * for a function name, not a local preference — and a tool definition rides
 * along with EVERY request, so one unacceptable character does not break one
 * call, it breaks every turn of the session with a 400 that names no tool.
 * A dot is the common case (`slack.postMessage`), so it is replaced rather than
 * rejected; two names that collide once replaced are caught at registration.
 */
export function mcpToolName(server: string, tool: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
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
 * One shared stopwatch caps the phase as a whole, because the per-server
 * budgets are not the number Main is holding a timer against.
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
  exec: RuntimeExecService,
  server: McpServerConfig,
  config: McpConfig,
  expired: Promise<void>,
  budgetMs: number
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
    const started = new McpClient({
      child,
      timeoutMs: config.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
      callTimeoutMs: config.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS,
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
      throw new RuntimeHostError(
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

/**
 * A server's `tools/call` result, as content the model can actually receive.
 *
 * An image comes back as `{type:'image', data, mimeType}`, which is exactly the
 * shape a tool result may carry, so it is forwarded rather than flattened: a
 * screenshot server is one of the most common MCP servers there is, and the
 * literal text `[image]` is indistinguishable to the model from a tool that
 * returned nothing.
 */
function contentOf(result: McpToolResult): {
  content: (TextContent | ImageContent)[];
  images: number;
} {
  const texts: string[] = [];
  const images: ImageContent[] = [];
  let dropped = 0;
  for (const part of result.content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text) texts.push(part.text);
      continue;
    }
    if (part.type === 'image' && typeof part.data === 'string' && part.data) {
      if (images.length >= MCP_MAX_IMAGES) {
        dropped += 1;
        continue;
      }
      images.push({
        type: 'image',
        data: part.data,
        mimeType: typeof part.mimeType === 'string' ? part.mimeType : 'image/png',
      });
      continue;
    }
    // Resource links, audio, and whatever a future revision adds: named, so the
    // model can tell "I got something I cannot read" from "I got nothing".
    texts.push(`[${part.type}]`);
  }
  if (dropped > 0) texts.push(`[${dropped} more image(s) not forwarded]`);
  const joined = texts.join('\n');
  const text =
    joined.length > MCP_OUTPUT_BYTES
      ? `${joined.slice(0, MCP_OUTPUT_BYTES)}\n[output truncated]`
      : joined;
  return {
    content: [{ type: 'text', text: text || summarize(images.length) }, ...images],
    images: images.length,
  };
}

/** The text block is never empty: a transcript renders it, and JSON of a base64 image is not a transcript line. */
function summarize(images: number): string {
  if (images === 0) return '(no output)';
  return images === 1 ? '(1 image)' : `(${images} images)`;
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
            policySurface: 'mcp',
            policyValue: `${connection.server.name}:${tool.name}`,
            preview: { label: 'Arguments', text: JSON.stringify(args, null, 2).slice(0, 4000) },
          },
          signal
        );
        signal?.throwIfAborted();
        // The signal goes all the way in, the way it does for `bash`: without
        // it a stopped turn still waits out the call budget, and the server
        // keeps working on an answer no one will read.
        const result = await client.callTool(tool.name, args, signal);
        // MCP's `isError` is the SERVER reporting a tool-level failure — a
        // missing file, a rejected query — which the model is meant to read and
        // react to. Throwing here would end the tool call as a runtime fault
        // and hide the server's own explanation, so it is labelled in the text
        // instead. A transport fault is a different thing and does throw.
        const { content, images } = contentOf(result);
        const [first, ...rest] = content;
        return {
          content: [
            result.isError && first?.type === 'text'
              ? { type: 'text', text: `[tool reported an error]\n${first.text}` }
              : first,
            ...rest,
          ].filter((part): part is TextContent | ImageContent => part !== undefined),
          details: {
            server: connection.server.name,
            tool: tool.name,
            isError: result.isError === true,
            images,
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
