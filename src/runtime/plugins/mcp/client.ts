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

/** A server asking US something: an id to answer plus a method, and no answer in it. */
function isRequest(value: unknown): value is { id: number | string; method: string } {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as { id?: unknown; method?: unknown };
  return (
    message.id !== undefined &&
    message.id !== null &&
    typeof message.method === 'string' &&
    !('result' in value) &&
    !('error' in value)
  );
}

/** JSON-RPC 2.0's own code for "I do not implement that". */
const METHOD_NOT_FOUND = -32601;

/**
 * The reason a cancelled call rejects with.
 *
 * `signal.reason` when the canceller supplied one, so a turn that was stopped
 * reports the stop rather than a generic MCP fault.
 */
function abortError(signal: AbortSignal | undefined, method: string): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new RuntimeHostError('mcp_aborted', `${method} was cancelled`);
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
 * every message the server sends is either a reply it owes us, a notification
 * this revision ignores, or a request it should not have sent — answered with
 * "method not found" rather than queued, which keeps a chatty server from
 * growing memory in a process that will not read it.
 */
export class McpClient {
  private readonly child: RuntimeChildProcess;
  private timeoutMs: number;
  private readonly callTimeoutMs: number | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  /**
   * Unterminated tail of the stdout stream, as BYTES.
   *
   * Buffering bytes rather than a string is what makes a multi-byte character
   * split across two pipe chunks survive: a frame is only decoded once its
   * newline has arrived, so no decoder ever sees half a character. It is also
   * what makes {@link MAX_MESSAGE_BYTES} mean bytes — `String.length` counts
   * UTF-16 units, which for CJK text is roughly a third of the real size.
   */
  private pendingChunks: Buffer[] = [];
  private pendingBytes = 0;
  private nextId = 1;
  private closed = false;
  /**
   * Told once, when this connection dies for a reason nobody asked for.
   *
   * A server that exits or overruns the frame cap leaves a record that still
   * advertises its tools and still reads as healthy; whoever owns that record
   * is the only one who can correct it.
   */
  onFailure: ((reason: string) => void) | undefined;
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
    if (this.closed) return;
    let rest = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let newline = rest.indexOf(0x0a);
    while (newline >= 0) {
      const head = rest.subarray(0, newline);
      const frame = this.pendingBytes === 0 ? head : Buffer.concat([...this.pendingChunks, head]);
      this.pendingChunks = [];
      this.pendingBytes = 0;
      const line = frame.toString('utf8').trim();
      if (line) this.dispatch(line);
      if (this.closed) return;
      rest = rest.subarray(newline + 1);
      newline = rest.indexOf(0x0a);
    }
    if (rest.length === 0) return;
    this.pendingChunks.push(rest);
    this.pendingBytes += rest.length;
    if (this.pendingBytes > MAX_MESSAGE_BYTES) {
      this.pendingChunks = [];
      this.pendingBytes = 0;
      // A server still writing into a frame this big is not going to stop on
      // its own, and nothing downstream will ever read it, so `fail` kills it.
      this.fail(`a single MCP message exceeded ${MAX_MESSAGE_BYTES} bytes`);
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
    if (!isResponse(message)) {
      // The file header promises an honest "method not found" over a
      // half-answered `sampling/createMessage`. Silence is neither: a server
      // that asks waits forever for a reply that is never coming.
      if (isRequest(message)) this.refuse(message.id, message.method);
      return;
    }
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

  private refuse(id: number | string, method: string): void {
    void this.send({
      jsonrpc: '2.0',
      id,
      error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` },
    }).catch(() => undefined);
  }

  private fail(reason: string, deliberate = false): void {
    const first = !this.closed;
    this.closed = true;
    for (const [, waiting] of [...this.pending]) {
      clearTimeout(waiting.timer);
      waiting.reject(new RuntimeHostError('mcp_disconnected', reason));
    }
    this.pending.clear();
    if (first && !deliberate) this.onFailure?.(reason);
    // Nothing will read this server again. Leaving it running leaves a process
    // writing into a pipe no one drains until the whole session is disposed.
    void this.child.kill().catch(() => undefined);
  }

  private async send(payload: Record<string, unknown>): Promise<void> {
    await this.child.write(Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8'));
  }

  private request(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new RuntimeHostError('mcp_disconnected', 'the MCP server is gone'));
    if (signal?.aborted) return Promise.reject(abortError(signal, method));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        settled = true;
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        finish();
        reject(
          new RuntimeHostError('mcp_timeout', `${method} did not answer in ${this.timeoutMs}ms`)
        );
      }, this.timeoutMs);
      const onAbort = () => {
        if (settled) return;
        finish();
        // The caller returns now; the server is told separately so it can stop
        // the work instead of finishing it into a reply nobody is waiting for.
        void this.send({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: 'the caller cancelled' },
        }).catch(() => undefined);
        reject(abortError(signal, method));
      };
      this.pending.set(id, {
        resolve: (value) => {
          finish();
          resolve(value);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
        timer,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }).catch((error) => {
        if (settled) return;
        finish();
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
    return { protocolVersion: result?.protocolVersion ?? '' };
  }

  /**
   * Switch from the connect budget to the per-call one.
   *
   * Called once the server is fully catalogued, NOT at the end of the
   * handshake. Everything before this point happens inside `createRuntime`,
   * which Main gives one bounded RPC to finish; a `tools/list` on the two
   * minute call budget would outlast that on its own.
   */
  beginCalls(): void {
    if (this.callTimeoutMs !== undefined) this.timeoutMs = this.callTimeoutMs;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    // A paging bug that re-sends page one, or two long names that clamp to the
    // same tool name, must not turn into a duplicate registration later.
    const seen = new Set<string>();
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
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
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

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<McpToolResult> {
    const result = (await this.request('tools/call', { name, arguments: args }, signal)) as {
      content?: unknown;
      isError?: unknown;
    };
    const content = Array.isArray(result?.content) ? (result.content as McpContentPart[]) : [];
    return { content, ...(result?.isError === true ? { isError: true } : {}) };
  }

  async close(): Promise<void> {
    this.fail('the MCP connection was closed', true);
    await this.child.kill();
  }
}
