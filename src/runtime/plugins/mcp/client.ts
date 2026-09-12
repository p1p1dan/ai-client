/**
 * P5-3 — a minimal MCP client over stdio.
 *
 * ## Why this is hand-written
 *
 * `@modelcontextprotocol/sdk` ships a `StdioClientTransport`, and it spawns the
 * server itself with `node:child_process`. That is exactly the thing ARD D11
 * point 4 forbids: the encrypted Windows target decides what a process may read
 * by WHICH process it is, so every child this runtime starts has to come out of
 * the one exec exit that knows the carrier rules. A transport that spawns
 * behind our back would start MCP servers under an executable the driver does
 * not know, and the symptom would be the same one D11 was written about —
 * ciphertext, or `Bad file descriptor`, from one feature only.
 *
 * So the transport is ours ({@link RuntimeChildProcess}) and the protocol is
 * the small part: JSON-RPC 2.0, newline-delimited, plus four messages.
 *
 * ## What is deliberately not implemented
 *
 * Resources, prompts, sampling, roots, notifications other than
 * `initialized`, and HTTP/SSE transports. This bridge exists to put a server's
 * TOOLS in front of the model; everything else is a separate feature with its
 * own UI questions, and a half-answered `sampling/createMessage` would be worse
 * than an honest "method not found".
 */

import type { RuntimeChildProcess } from '../../contracts.ts';
import { RuntimeHostError } from '../../host/errors.ts';

/** The revision this client speaks. Sent in `initialize`, checked on the reply. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Newline-delimited JSON has no length prefix, so a runaway server needs a cap. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpContentPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  content: McpContentPart[];
  isError?: boolean;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function isResponse(value: unknown): value is JsonRpcResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    (value as { id: unknown }).id !== null &&
    ('result' in value || 'error' in value)
  );
}

export interface McpClientOptions {
  child: RuntimeChildProcess;
  /** Per-request deadline. A hung server must not hold a turn open forever. */
  timeoutMs: number;
  /**
   * Deadline for calls made after the handshake, when different. Starting a
   * server and running one of its tools are not the same wait: a session must
   * not stall for two minutes on a server that will never introduce itself,
   * and a tool that legitimately takes a minute must not be cut off at the
   * handshake budget.
   */
  callTimeoutMs?: number;
}

/**
 * One connected MCP server.
 *
 * Deliberately not an EventEmitter: this client only ever makes requests, so
 * every message the server sends is either a reply it owes us or a notification
 * this revision ignores. Anything else is dropped rather than queued, which
 * keeps a chatty server from growing memory in a process that will not read it.
 */
export class McpClient {
  private readonly child: RuntimeChildProcess;
  private timeoutMs: number;
  private readonly callTimeoutMs: number | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private buffer = '';
  private nextId = 1;
  private closed = false;
  serverName = '';
  serverVersion = '';

  /** Resolves when the server process is gone. Never rejects. */
  get exited(): Promise<{ exitCode: number | null; signal: string | null }> {
    return this.child.exited;
  }

  constructor(options: McpClientOptions) {
    this.child = options.child;
    this.timeoutMs = options.timeoutMs;
    this.callTimeoutMs = options.callTimeoutMs;
    void this.child.exited.then(() => this.fail('the MCP server exited'));
  }

  /** Feed a stdout chunk. Wired by whoever spawned the child. */
  receive(chunk: Uint8Array): void {
    this.buffer += Buffer.from(chunk).toString('utf8');
    if (this.buffer.length > MAX_MESSAGE_BYTES) {
      this.buffer = '';
      this.fail(`a single MCP message exceeded ${MAX_MESSAGE_BYTES} bytes`);
      return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Servers print to stdout by accident all the time. Dropping a line we
      // cannot parse is right; failing the connection over it is not.
      return;
    }
    if (!isResponse(message)) return;
    const waiting = this.pending.get(Number(message.id));
    if (!waiting) return;
    this.pending.delete(Number(message.id));
    clearTimeout(waiting.timer);
    if (message.error) {
      waiting.reject(
        new RuntimeHostError('mcp_error', `${message.error.message} (code ${message.error.code})`)
      );
      return;
    }
    waiting.resolve(message.result);
  }

  private fail(reason: string): void {
    this.closed = true;
    for (const [, waiting] of [...this.pending]) {
      clearTimeout(waiting.timer);
      waiting.reject(new RuntimeHostError('mcp_disconnected', reason));
    }
    this.pending.clear();
  }

  private async send(payload: Record<string, unknown>): Promise<void> {
    await this.child.write(Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8'));
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new RuntimeHostError('mcp_disconnected', 'the MCP server is gone'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RuntimeHostError('mcp_timeout', `${method} did not answer in ${this.timeoutMs}ms`)
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }).catch((error) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /**
   * The handshake. Returns the tools the server offers.
   *
   * A protocol version we do not recognise is reported, not enforced: MCP's own
   * rule is that the client may proceed, and refusing would break every server
   * that ships a newer revision before we notice.
   */
  async initialize(): Promise<{ protocolVersion: string }> {
    const result = (await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      // Only what we actually honour. Declaring `sampling` here would promise
      // the server it may ask the model questions this client cannot answer.
      capabilities: {},
      clientInfo: { name: 'aiclient-runtime', version: '1' },
    })) as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
    };
    this.serverName = result?.serverInfo?.name ?? '';
    this.serverVersion = result?.serverInfo?.version ?? '';
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // The handshake is over; everything after it gets the call budget.
    if (this.callTimeoutMs !== undefined) this.timeoutMs = this.callTimeoutMs;
    return { protocolVersion: result?.protocolVersion ?? '' };
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.request('tools/list', cursor ? { cursor } : undefined)) as {
        tools?: unknown[];
        nextCursor?: string;
      };
      for (const entry of page?.tools ?? []) {
        if (typeof entry !== 'object' || entry === null) continue;
        const tool = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof tool.name !== 'string' || !tool.name) continue;
        tools.push({
          name: tool.name,
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          inputSchema:
            typeof tool.inputSchema === 'object' && tool.inputSchema !== null
              ? (tool.inputSchema as Record<string, unknown>)
              : { type: 'object' },
        });
      }
      cursor = typeof page?.nextCursor === 'string' ? page.nextCursor : undefined;
      // A server that keeps handing back a cursor would page forever.
      if (tools.length > 500) break;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: unknown;
      isError?: unknown;
    };
    const content = Array.isArray(result?.content) ? (result.content as McpContentPart[]) : [];
    return { content, ...(result?.isError === true ? { isError: true } : {}) };
  }

  async close(): Promise<void> {
    this.fail('the MCP connection was closed');
    await this.child.kill();
  }
}
