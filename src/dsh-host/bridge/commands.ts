/**
 * Slash commands on the DSH engine (P1-4d2; dsh-rebase decisions 099 rules
 * 9-10, 101, 103 and 113).
 *
 * The menu (`worker.commands`) lists DSH's own commands (`ctx.commands.list`)
 * and the skills a person may call with `/<name>` (`ctx.skills`), by their
 * bare name: DSH has no `skill:` spelling and no prompt templates. Three
 * commands are never offered and never run from a send: `/plan` and
 * `/permission` would be a second posture beside our gate (decision 047), and
 * `/feedback` only writes a local log nobody reads. `/compact` is not listed
 * either: the window offers it itself and runs it through `worker.compact`.
 *
 * A send whose text is a line DSH's grammar names as one of the remaining
 * commands runs through `ctx.commands.execute` and opens no model turn; any
 * other `/xxx` goes to the model as typed, so a message that starts with a
 * path is never refused (the one place this deliberately differs from DSH's
 * own adapters, which refuse unknown commands).
 *
 * No value imports from DSH: the bridge reads the services it is handed.
 */

import {
  WORKER_COMMAND_INVENTORY_MAX,
  type WorkerCommandsResult,
  type WorkerSlashCommandInfo,
} from '../../shared/types/workerRpc.ts';

// ---- the slices of the DSH services read here -------------------------------

/** `CommandDescriptor` of `@deepseek-ai/dsh-commands`, narrowed. */
export interface DshCommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string; readonly attachments?: boolean };
}

/** `CommandResult` of `@deepseek-ai/dsh-commands`. */
export type DshCommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
  | { readonly kind: 'error'; readonly text: string };

/** `CommandExecution`: the settled result and the id its `command/run` / `command/done` carry. */
export interface DshCommandExecution {
  readonly commandId: string;
  readonly result: DshCommandResult;
}

/** `ctx.commands` (dsh-commands), narrowed to what the bridge calls. */
export interface DshCommandsView {
  /** The commands an agent sees, name-sorted, after agent-scoped shadowing. */
  list(agent: unknown): readonly DshCommandDescriptor[];
  find(agent: unknown, name: string): unknown;
  /**
   * Runs a known command line against `agent`. Its `command/run` is appended
   * synchronously, before the returned promise settles; `undefined` when the
   * line is not a command DSH knows (nothing is logged then).
   */
  execute(
    agent: unknown,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal
  ): Promise<DshCommandExecution | undefined>;
}

/** `SkillSummary` of `@deepseek-ai/dsh-skill`, narrowed. */
export interface DshSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly path?: string;
  /** The discovery root (`user-agents`, `project-dsh`, `custom`, …). */
  readonly source: string;
  readonly invocation?: { readonly modelInvocable?: boolean; readonly userInvocable?: boolean };
}

/** `ctx.skills` (dsh-skill), narrowed. */
export interface DshSkillsView {
  list(options?: {
    cwd?: string;
    scope?: unknown;
    signal?: AbortSignal;
  }): Promise<DshSkillSummary[]>;
}

// ---- the rules ----------------------------------------------------------------

/** Never offered, never run from a send: a typed `/plan …` goes to the model as text. */
export const HIDDEN_DSH_COMMANDS: ReadonlySet<string> = new Set(['plan', 'permission', 'feedback']);

/** Offered by the window and run through an RPC of their own (`/compact` is `worker.compact`). */
export const WINDOW_OWNED_COMMANDS: ReadonlySet<string> = new Set(['compact']);

/** `WorkerSlashCommandInfo.source` of a DSH command. */
export const COMMAND_SOURCE = 'command';
/** `WorkerSlashCommandInfo.source` of a skill. */
export const SKILL_SOURCE = 'skill';

/** Live ids of a command send's echo and result: `dsh-command-<seq of its log event>`. */
export const DSH_COMMAND_MESSAGE_PREFIX = 'dsh-command-';
/** `custom.message.customType` of a command's result, and of a refused or failed one. */
export const DSH_COMMAND_RESULT_TYPE = 'dsh:command';
export const DSH_COMMAND_ERROR_TYPE = 'dsh:command-error';

/**
 * The command a line names, by DSH's own grammar (`parseCommand` of
 * dsh-commands): a slash at the first byte, a lowercase name, then the end or
 * whitespace. Anything else is not a command line.
 */
export function dshCommandName(line: string): string | undefined {
  return /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)?.[1];
}

/**
 * `worker.commands`: the commands the menu offers, then the skills a person
 * may call. A skill named like an offered command is left out: a `/name` at
 * the start of a line runs the command, never the skill.
 */
export function slashCommandRows(
  commands: readonly DshCommandDescriptor[],
  skills: readonly DshSkillSummary[]
): WorkerCommandsResult {
  const rows: WorkerSlashCommandInfo[] = [];
  const taken = new Set<string>(WINDOW_OWNED_COMMANDS);
  for (const command of commands) {
    if (HIDDEN_DSH_COMMANDS.has(command.name)) continue;
    taken.add(command.name);
    if (WINDOW_OWNED_COMMANDS.has(command.name)) continue;
    rows.push({ name: command.name, description: command.description, source: COMMAND_SOURCE });
  }
  for (const skill of skills) {
    if (skill.invocation?.userInvocable !== true || taken.has(skill.name)) continue;
    rows.push({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      source: SKILL_SOURCE,
      ...(skill.path ? { path: skill.path } : {}),
      ...(skill.source ? { scope: skill.source } : {}),
    });
  }
  return {
    commands: rows.slice(0, WORKER_COMMAND_INVENTORY_MAX),
    truncated: rows.length > WORKER_COMMAND_INVENTORY_MAX,
  };
}

/** `worker.compact`'s refusals (the native runtime's codes, plus DSH's own failures). */
export const WORKER_COMPACT_UNAVAILABLE = 'WORKER_COMPACT_UNAVAILABLE';
export const WORKER_COMPACT_TIMEOUT = 'WORKER_COMPACT_TIMEOUT';
export const WORKER_COMPACT_FAILED = 'WORKER_COMPACT_FAILED';

/**
 * What a settled `/compact` means to `worker.compact`: compacted only when DSH
 * names the summary it wrote (`sourceEventSeq`); a success without one is
 * DSH's "No compactable history yet."; an error is DSH's sentence.
 */
export function compactOutcome(
  execution: DshCommandExecution | undefined
): { compacted: true } | { code: string; message: string } {
  const result = execution?.result;
  if (!result) {
    return { code: WORKER_COMPACT_UNAVAILABLE, message: 'This host has no /compact command' };
  }
  if (result.kind === 'success') {
    return result.sourceEventSeq !== undefined
      ? { compacted: true }
      : {
          code: WORKER_COMPACT_UNAVAILABLE,
          message: result.text ?? 'There is nothing to compact yet',
        };
  }
  return { code: WORKER_COMPACT_FAILED, message: result.text };
}
