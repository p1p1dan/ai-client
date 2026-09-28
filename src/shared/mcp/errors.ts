// New in dsh-rebase P1-16 prep: host-neutral error plumbing for the shared MCP library.

/**
 * Builds every error this library throws, keyed by a string `code`
 * (`mcp_timeout`, `mcp_disconnected`, `mcp_error`, `mcp_aborted`).
 *
 * Injected rather than fixed so each host keeps its own error type: the 1.0.x
 * runtime's callers test `instanceof RuntimeHostError`, while a DSH host maps
 * the code onto its own tool-error shape. Hosts that bring nothing get
 * {@link McpError}. Same pattern as `src/shared/permissions/errors.ts`.
 */
export type McpErrorFactory = (code: string, message: string, options?: ErrorOptions) => Error;

/** The default error type, for hosts that do not inject their own. */
export class McpError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'McpError';
  }
}

export const createMcpError: McpErrorFactory = (code, message, options) =>
  new McpError(code, message, options);
