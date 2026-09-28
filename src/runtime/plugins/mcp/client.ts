/**
 * The runtime's view of the MCP client: a thin wrapper (dsh-rebase P1-16 prep).
 *
 * The client itself — framing, the handshake, paging, cancellation, the frame
 * cap — lives in `src/shared/mcp/client.ts`, so a DSH host row can drive the
 * same protocol after this runtime is gone. What stays here is only the error
 * type: the runtime's callers test `instanceof RuntimeHostError`, so every
 * rejection is built as one, with the same code and message as before.
 * P1-12 deletes this file with the runtime.
 */

import { type McpClientOptions, McpClient as SharedMcpClient } from '../../../shared/mcp/client.ts';
import type { McpErrorFactory } from '../../../shared/mcp/errors.ts';
import { RuntimeHostError } from '../../host/errors.ts';

export {
  MAX_MESSAGE_BYTES,
  MCP_PROTOCOL_VERSION,
  type McpChildProcess,
  type McpClientOptions,
  type McpContentPart,
  type McpToolDefinition,
  type McpToolResult,
} from '../../../shared/mcp/client.ts';

/** The shared library's error factory, answering the runtime's own error type. */
export const runtimeMcpError: McpErrorFactory = (code, message, options) =>
  new RuntimeHostError(code, message, options);

export class McpClient extends SharedMcpClient {
  constructor(options: McpClientOptions) {
    super({ ...options, createError: options.createError ?? runtimeMcpError });
  }
}
