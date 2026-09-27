// New in dsh-rebase P1-6a: the one place that says which tools run a shell command line.

/**
 * Tools whose request is a shell command line rather than a file operation.
 *
 * `bash` is the 1.0.x runtime's shell; `pwsh` is the only shell the DSH host
 * offers on Windows. Every rule keyed on "is this a shell call" — command-prefix
 * grants, plan-mode exploration, accept-edits, the exec card — asks this
 * instead of comparing against `'bash'`, so a second shell cannot silently fall
 * through to the file-tool rules. The 1.0.x runtime registers no `pwsh`, so for
 * it this is exactly `tool === 'bash'`.
 */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh']);

export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool);
}
