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

/**
 * `mcp__github__create_issue` -> `github · create_issue`, for a row's arg.
 *
 * chat-tool-09 — the separator is the LAST `__`, not the first.
 *
 * The producer composes `mcp__${server}__${tool}` after replacing every
 * character outside `[A-Za-z0-9_-]` with `_` (`plugins/mcp/index.ts`), and a
 * server name is whatever the user put in their MCP config — `^[\w.-]{1,48}$`,
 * which admits a trailing `_` and a literal `__`. So both halves can contain
 * the separator's own characters and no split is provably right; what differs
 * is which mistake it makes.
 *
 * Splitting at the FIRST pair mis-handles the server: `jira_` composes
 * `mcp__jira___createIssue` and read back as `jira · _createIssue`, which both
 * drops the server's real name and draws two different servers (`jira` and
 * `jira_`) under one label. Splitting at the LAST pair instead mis-handles a
 * tool name that itself contains `__` — rarer, because tool names come from the
 * server's own API and are conventionally single-underscore snake_case, while
 * server names are typed by hand and run through that character replacement.
 *
 * Either way this is a LABEL only: calls, grants and policy matching all use
 * the wire name verbatim, so a mis-split never changes what runs.
 */
export function mcpToolLabel(toolName: string): string | undefined {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  if (!rest) return undefined;
  const separator = rest.lastIndexOf('__');
  // No separator at all: the whole remainder is the server, and there is no
  // tool half to invent one for.
  if (separator < 0) return rest;
  // Nothing before the separator is not a server name, so there is no label to
  // give — the caller keeps the wire name rather than printing `· tool`.
  if (separator === 0) return undefined;
  return `${rest.slice(0, separator)} · ${rest.slice(separator + 2)}`;
}

/**
 * The name to SHOW for a tool call: an MCP tool by its server and tool, anything
 * else by the name it was called with.
 *
 * chat-tool-05 — three surfaces print a tool name directly rather than through
 * a row view (the delegation panel's header, the Run panel's active-tool chip,
 * the permission activity row). Each of them was printing `mcp__github__create_issue`
 * while the row one line below said `github · create_issue`, so one action had
 * two names on one screen and one of them was a protocol identifier.
 */
export function toolDisplayName(toolName: string): string {
  return mcpToolLabel(toolName) ?? toolName;
}
