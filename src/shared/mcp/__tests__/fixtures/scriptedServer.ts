// New in dsh-rebase P1-16 prep: an in-process MCP server behind the library's ports, for seam tests.

import type { McpChildProcess } from '../../client.ts';
import type { McpProcessLauncher, McpSpawnRequest } from '../../connect.ts';

/**
 * A stand-in for a host's exec exit and the server it starts, with no process
 * at all: `write` parses each JSON-RPC line and the reply is pushed back through
 * the spawn request's `onStdout`, the way a real pipe delivers it. The real
 * stdio fixture (`src/runtime/__tests__/fixtures/mcp-echo-server.mjs`) stays
 * with the runtime's end-to-end suite; this one only proves the seams.
 */

export interface ScriptedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ScriptedServerOptions {
  tools?: ScriptedTool[];
  /** Answer nothing at all, to exercise the deadlines. */
  silent?: boolean;
  /** Answer `tools/call` with a JSON-RPC error instead of a result. */
  callError?: { code: number; message: string };
  /** The `tools/call` result; defaults to echoing the arguments as text. */
  callResult?: (name: string, args: Record<string, unknown>) => unknown;
}

export interface ScriptedChild extends McpChildProcess {
  /** Every JSON-RPC message the client wrote, parsed. */
  readonly received: Record<string, unknown>[];
  readonly killed: boolean;
  /** The server exits on its own, the way a crash looks to the client. */
  exit(): void;
}

export interface ScriptedLauncher extends McpProcessLauncher {
  readonly requests: McpSpawnRequest[];
  readonly children: ScriptedChild[];
}

export function scriptedLauncher(options: ScriptedServerOptions = {}): ScriptedLauncher {
  const requests: McpSpawnRequest[] = [];
  const children: ScriptedChild[] = [];
  return {
    requests,
    children,
    async spawn(request) {
      requests.push(request);
      const child = scriptedChild(request, options);
      children.push(child);
      return child;
    },
  };
}

function scriptedChild(request: McpSpawnRequest, options: ScriptedServerOptions): ScriptedChild {
  const received: Record<string, unknown>[] = [];
  let killed = false;
  let gone = false;
  let finish: (value: { exitCode: number | null; signal: string | null }) => void = () => undefined;
  const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    finish = resolve;
  });
  const reply = (message: Record<string, unknown>) => {
    // Asynchronous, like a pipe: the client has finished writing before it reads.
    setImmediate(() => {
      if (gone) return;
      request.onStdout(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`, 'utf8'));
    });
  };
  const answer = (message: Record<string, unknown>) => {
    const { id, method } = message as { id?: number | string; method?: string };
    if (options.silent || id === undefined || typeof method !== 'string') return;
    if (method === 'initialize') {
      reply({
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'scripted', version: '0' },
        },
      });
      return;
    }
    if (method === 'tools/list') {
      reply({
        id,
        result: {
          tools: (options.tools ?? []).map((tool) => ({
            inputSchema: { type: 'object' },
            ...tool,
          })),
        },
      });
      return;
    }
    if (method === 'tools/call') {
      const params = (message.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (options.callError) {
        reply({ id, error: options.callError });
        return;
      }
      const result = options.callResult
        ? options.callResult(params.name ?? '', params.arguments ?? {})
        : { content: [{ type: 'text', text: JSON.stringify(params.arguments ?? {}) }] };
      reply({ id, result });
      return;
    }
    reply({ id, error: { code: -32601, message: `method not found: ${method}` } });
  };
  const stop = (signal: string | null) => {
    if (gone) return;
    gone = true;
    finish({ exitCode: signal ? null : 1, signal });
  };
  return {
    received,
    get killed() {
      return killed;
    },
    exited,
    async write(bytes) {
      if (gone) throw Object.assign(new Error('write after exit'), { code: 'EPIPE' });
      for (const line of Buffer.from(bytes).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        received.push(message);
        answer(message);
      }
    },
    async kill() {
      killed = true;
      stop('SIGTERM');
    },
    exit() {
      stop(null);
    },
  };
}
