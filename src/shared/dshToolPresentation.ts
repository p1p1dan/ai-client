// New in dsh-rebase decision 131

/**
 * dsh-rebase decision 131 (decision 073 rule 1, decision 120 item 27): the
 * title a plugin tool declares for one of its calls, as far as a tool row
 * uses it.
 *
 * DSH lets a tool describe how a pending call reads in a UI through
 * `ToolDefinition.presentCall(args)`, a pure function of the call's arguments
 * meant for host-local consumers: "a UI may call it during live streaming AND
 * a session-log replay" (`dsh-tools` `lib/types/index.d.ts`). Its answer is a
 * `card`-tagged view (`generic` / `terminal` / `diff`, `lib/types/presentation.d.ts`);
 * a row keeps the card, the title, the category and a terminal's description
 * (plan P1-7 shard 03 §2) and drops the rest (raw input, content blocks, file
 * locations, a diff's whole new text).
 *
 * The bridge asks only for a tool that is not one of DSH's own
 * (`isDshBuiltinTool`): an allowlisted plugin's, or one a later DSH adds. DSH's
 * own tools keep the rows P1-7c wrote for them (decision 120), so a recording
 * of DSH's tools never carries the field.
 *
 * No imports: the bridge bundle, the history projection and the renderer all
 * read this module.
 */

/** DSH's `ToolCallKind`: what a UI picks an icon and a treatment by. */
export type ToolCallPresentationKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'fetch'
  | 'other';

/** One call's title as a tool declared it, narrowed (`narrowToolCallPresentation`). */
export interface ToolCallPresentation {
  /** `terminal`: the title is a command; `diff`: the call writes files; `generic`: anything else. */
  card: 'generic' | 'terminal' | 'diff';
  /** The tool's own words for this call (`Create report.docx`), never translated. */
  title: string;
  /** A generic card's category, when it named one. */
  kind?: ToolCallPresentationKind;
  /** A terminal card's one-line account of the command, when it gave one. */
  description?: string;
}

/** A title is a card header (DSH: "keep it short"); anything longer is cut here. */
export const TOOL_PRESENTATION_TEXT_MAX = 200;

/**
 * Every tool the pinned DSH (0.1.7-rc.2) defines, and the DSH packages the
 * host installs beside dsh-base — the keys of the permission gate's
 * `DSH_TOOL_CLASSES` (`src/dsh-host/permissions/classification.ts`), which the
 * bridge bundle may not import (decision 106 rule 3). A test pins the two
 * lists equal, and that table's own tests pin it to what DSH registers.
 */
export const DSH_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'write',
  'edit',
  'bash',
  'pwsh',
  'run_code',
  'workflow',
  'plugin_manager',
  'skill',
  'todo_write',
  'job_list',
  'job_output',
  'job_kill',
  'subagent',
  'subagent_fork',
  'list_agents',
  'list_subagent_models',
  'send_message',
  'interrupt_agent',
  'structured_output',
  'ralph',
  'get_goal',
  'create_goal',
  'update_goal',
  'exit_plan_mode',
  'present',
  'ask_user_question',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'web_search',
  'web_fetch',
]);

/** One of DSH's own tools: its row is ours (P1-7c), whatever it presents. */
export function isDshBuiltinTool(name: string): boolean {
  return DSH_BUILTIN_TOOL_NAMES.has(name);
}

const CARDS: ReadonlySet<unknown> = new Set(['generic', 'terminal', 'diff']);
const KINDS: ReadonlySet<unknown> = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'fetch',
  'other',
]);

/** One line, trimmed, at most `TOOL_PRESENTATION_TEXT_MAX` code points; empty is nothing. */
function lineOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  const points = Array.from(line);
  return points.length <= TOOL_PRESENTATION_TEXT_MAX
    ? line
    : `${points.slice(0, TOOL_PRESENTATION_TEXT_MAX - 1).join('')}…`;
}

/**
 * What a row may take from a tool's `presentCall` answer. A plugin wrote the
 * answer, so it is read defensively: an unknown card or a missing title is no
 * presentation at all, an unknown kind is left out.
 */
export function narrowToolCallPresentation(view: unknown): ToolCallPresentation | undefined {
  if (typeof view !== 'object' || view === null || Array.isArray(view)) return undefined;
  const record = view as Record<string, unknown>;
  if (!CARDS.has(record.card)) return undefined;
  const card = record.card as ToolCallPresentation['card'];
  const title = lineOf(record.title);
  if (!title) return undefined;
  const kind = card === 'generic' && KINDS.has(record.kind) ? record.kind : undefined;
  const description = card === 'terminal' ? lineOf(record.description) : undefined;
  return {
    card,
    title,
    ...(kind ? { kind: kind as ToolCallPresentationKind } : {}),
    ...(description ? { description } : {}),
  };
}

/** Two presentations say the same thing (the renderer store skips an unchanged one). */
export function sameToolCallPresentation(
  a: ToolCallPresentation | undefined,
  b: ToolCallPresentation | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.card === b.card && a.title === b.title && a.kind === b.kind && a.description === b.description
  );
}

/**
 * How the bridge asks a tool for its presentation: the tool's name and the
 * call's parsed arguments in, the narrowed answer out, or nothing (a DSH tool,
 * no such tool, no `presentCall`, an answer that does not narrow).
 */
export type DshToolPresenter = (name: string, args: unknown) => ToolCallPresentation | undefined;
