/**
 * T12-b: pi's built-in tools, taken from the SDK itself
 * (`dist/core/tools/*.js`, each file's `name:` literal) rather than guessed.
 *
 * They are LOWERCASE, and none of them collide with the capitalised Claude
 * names — which is exactly how this went unnoticed for a whole backend swap:
 * every lookup in `toolCard.ts` missed, silently and without a type error, so
 * on the pi backend every tool row read `Ran`, nothing was ever classified
 * read/search (so tool aggregation never fired at all), and paths rendered
 * proportional instead of mono.
 *
 * `powershell` is pi's Windows sibling of `bash` (same file layout, same
 * `command` argument), so it shares bash's row treatment.
 *
 * Their argument names come from the same source (the `Type.TObject` schema in
 * each tool's `.d.ts`) and differ from Claude's: pi says `path`, Claude says
 * `file_path`. Anything keyed on a field name has to read both.
 *
 * Lives in its own module so `toolCard.ts` and `toolDiff.ts` can both use it
 * without importing each other — a cycle between two chat modules is not
 * hypothetical here, it is a shape this repo has already been bitten by at
 * bundle level.
 */
export const PI_TOOL_NAMES = {
  read: 'read',
  edit: 'edit',
  write: 'write',
  bash: 'bash',
  powershell: 'powershell',
  grep: 'grep',
  find: 'find',
  ls: 'ls',
} as const;

/**
 * subagent-data-06 — the tools THIS app's runtime actually registers.
 *
 * Separate from {@link PI_TOOL_NAMES}, which is the pi SDK's own built-in set,
 * because the two are not the same list and reading one as the other is exactly
 * how this went wrong: the SDK calls its glob tool `find`, our runtime registers
 * `glob` (`src/runtime/plugins/tools/index.ts`), and every table in
 * `toolCard.ts` was keyed on `find`. The miss is silent — `TOOL_VERBS` falls
 * back to "Ran" and `formatToolArgDetail` falls into its `default:` branch,
 * whose probe order finds `path` before `pattern` — so a `glob` row read
 * "Ran src" and never said what was being looked for. That is true of the
 * delegation panel and of the main timeline, which share one derivation.
 *
 * Argument names come from each tool's own typebox schema, same source rule as
 * the SDK table above.
 */
export const RUNTIME_TOOL_NAMES = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  /** pi says `find`; we say `glob`, and both take `pattern` + `path`. */
  glob: 'glob',
  grep: 'grep',
  /** Registered only on a host with a preview surface. */
  browserPreview: 'browser_preview',
  /** Registered only on a host that can show a question card. */
  ask: 'ask',
  skill: 'skill',
  newContext: 'new_context',
  task: 'Task',
  taskWait: 'TaskWait',
  taskList: 'TaskList',
  taskStop: 'TaskStop',
} as const;

/**
 * Prefix every MCP-bridged tool carries: `mcp__<server>__<tool>`.
 *
 * The name is composed at runtime from the server and tool ids, so no table can
 * enumerate them; the tables key on this prefix instead.
 */
export const MCP_TOOL_PREFIX = 'mcp__';

/** `mcp__github__create_issue` -> `github · create_issue`, for a row's arg. */
export function mcpToolLabel(toolName: string): string | undefined {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const [server, ...rest] = toolName.slice(MCP_TOOL_PREFIX.length).split('__');
  if (!server) return undefined;
  return rest.length > 0 ? `${server} · ${rest.join('__')}` : server;
}
