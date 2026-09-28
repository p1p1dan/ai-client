// Moved from src/runtime/host/errors.ts (dsh-rebase P1-16 prep): only `errorCode`, for the shared skills and MCP loaders.

/**
 * The string `code` an error carries, read duck-typed so a filesystem error
 * from any host (`ENOENT`, `EACCES`) is recognised whatever class threw it.
 */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
