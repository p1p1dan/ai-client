/**
 * How each DSH tool reaches the permission gate (dsh-rebase decision 047;
 * P1-6 design shard 03 §2).
 *
 * One table for every built-in tool of the pinned DSH (0.1.7-rc.2), whether or
 * not the product composition mounts it today, and for the DSH packages the
 * host installs beside dsh-base (P1-4d3: dsh-tool-ask-user). `permissionsClassification`
 * tests fail when an installed DSH package defines a tool this table does not
 * name, so a DSH upgrade cannot slip a new tool past the gate unclassified.
 */

export type DshToolClass =
  /** File reads: `read` surface, the path is the file. */
  | 'read'
  /** glob / grep: gated on the searched root, results filtered afterwards. */
  | 'search'
  /** write / edit: the path is the file; write previews its content. */
  | 'write'
  /** bash / pwsh: command analysis, operand checks, command-prefix grants. */
  | 'shell'
  /** Programs whose effects cannot be read statically: always asks below bypass. */
  | 'opaque'
  /** Skill loads: matched on the skill name, trusted path. */
  | 'skill'
  /** Bookkeeping and delegation: never gated; delegated calls are gated themselves. */
  | 'internal'
  /** Known tools with no file target: the policy's per-tool rule, `'*': 'ask'` by default. */
  | 'generic';

export const DSH_TOOL_CLASSES: Readonly<Record<string, DshToolClass>> = Object.freeze({
  read: 'read',
  read_image: 'read',
  glob: 'search',
  grep: 'search',
  write: 'write',
  edit: 'write',
  bash: 'shell',
  pwsh: 'shell',
  // PTC programs and workflow scripts; plugin_manager installs host code.
  run_code: 'opaque',
  workflow: 'opaque',
  plugin_manager: 'opaque',
  skill: 'skill',
  todo_write: 'internal',
  job_list: 'internal',
  job_output: 'internal',
  job_kill: 'internal',
  subagent: 'internal',
  subagent_fork: 'internal',
  list_agents: 'internal',
  list_subagent_models: 'internal',
  send_message: 'internal',
  interrupt_agent: 'internal',
  structured_output: 'internal',
  ralph: 'internal',
  get_goal: 'internal',
  create_goal: 'internal',
  update_goal: 'internal',
  exit_plan_mode: 'internal',
  present: 'internal',
  // P1-4d3 (decision 098): asking the user is the interaction itself, never
  // gated, as 1.0.x's `ask` was not (dsh-tool-ask-user, a product bundle row).
  ask_user_question: 'internal',
  list_mcp_resources: 'generic',
  list_mcp_resource_templates: 'generic',
  read_mcp_resource: 'generic',
  web_search: 'generic',
  web_fetch: 'generic',
});

/** A tool's class, or `unknown` for plugin tools; `unknown` is gated like `generic`. */
export function classifyTool(name: string): DshToolClass | 'unknown' {
  return Object.hasOwn(DSH_TOOL_CLASSES, name) ? DSH_TOOL_CLASSES[name] : 'unknown';
}
