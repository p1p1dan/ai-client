/**
 * The text an error boundary logs and copies: message, stack, component stack.
 *
 * One formatter for both on purpose. The 2026-09-24 field crash was reported
 * as "the Retry / Reload card", with no message, path or stack left anywhere —
 * the boundary only wrote to the renderer console. The same report now goes
 * to the main-process log file (through electron-log's renderer IPC, which
 * `renderer/index.tsx` installs over `console`) and onto the clipboard, so
 * what a user pastes and what the log holds cannot drift apart.
 */

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

export function errorStackOf(error: unknown): string | null {
  if (error instanceof Error) {
    return error.stack ?? null;
  }
  return null;
}

export function formatErrorReport(input: {
  error: unknown;
  componentStack: string | null;
  /** Which boundary caught it, e.g. `root` or `editor-column`. */
  scope?: string;
}): string {
  const lines = [
    `[ErrorBoundary${input.scope ? `:${input.scope}` : ''}] ${errorMessageOf(input.error)}`,
  ];
  const stack = errorStackOf(input.error);
  if (stack) lines.push('', '[stack]', stack);
  if (input.componentStack) lines.push('', '[componentStack]', input.componentStack.trim());
  return lines.join('\n');
}
