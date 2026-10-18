/**
 * dsh-rebase decision 194 (ruling 193 item 29): the Claude Agent SDK engine's slash
 * commands — what the composer menu lists, and how the CLI's own transcript rows of a
 * command read in history.
 *
 * The list is the CLI's (`initializationResult().commands`, replaced by every
 * `commands_changed`): its built-in commands and the skills it ships (`builtin`), then the
 * user layer's, the project's and the plugins' skills and custom commands (the CLI counts
 * custom commands as skills). A typed `/name args` goes to the CLI as the user's message,
 * as the CLI's own terminal does (ruling 17); only the rows below are left out of the menu.
 *
 * Measured on CLI 2.1.300 (`tools/slash-inventory.ts`): a local command (`/context`,
 * `/usage`, …) answers with one `assistant` message whose model is `<synthetic>` and which
 * has no stream frames; its transcript keeps the line as a `<command-name>` user row and
 * the output as a `system` `local_command` row whose parent is that row. A skill or custom
 * command keeps the line as a `<command-message>` user row (the skill's body is an
 * `isMeta` row the SDK's reader leaves out).
 */

import {
  WORKER_COMMAND_INVENTORY_MAX,
  type WorkerCommandsResult,
  type WorkerSlashCommandInfo,
} from '../shared/types/workerRpc.ts';

/** `WorkerSlashCommandInfo.source` of the CLI's own rows (`builtin`). */
export const SDK_COMMAND_SOURCE = 'command';
/** `WorkerSlashCommandInfo.source` of the user's, the project's and the plugins' rows. */
export const SDK_SKILL_SOURCE = 'skill';

/**
 * Rows the CLI marks as bound to a terminal (`system/init.terminal_slash_commands`). The
 * CLI only says so in its first `system/init`; until then, 2.1.300's set stands in.
 */
export const SDK_TERMINAL_COMMANDS_DEFAULT: readonly string[] = [
  'doctor',
  'color',
  'focus',
  'reload-plugins',
];

/**
 * Never listed: of use to a remote session or a debugger only, removed, unavailable in the
 * Agent SDK (the CLI says so), a peer list whose tools are off (issue #22), or a report on
 * the CLI product's own use (the product UI never names it, plan §2 rule 4).
 */
export const SDK_HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  '__remote-workflow',
  'workflow-launch-exec',
  'heapdump',
  'agents',
  'fast',
  'list-agents',
  'insights',
  'team-onboarding',
]);

/**
 * The menu's words for a CLI row whose own description names the CLI product (plan §2
 * rule 4). Any other such row is listed without a description.
 */
export const SDK_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  'update-config':
    'Configure settings.json: hooks for automated behaviour, permissions and environment variables',
};

const PRODUCT_NAME = /claude code/i;

/** A CLI row's description as the menu shows it. */
function menuDescription(command: CliSlashCommand): string | undefined {
  if (command.builtin === true) {
    const override = SDK_DESCRIPTION_OVERRIDES[command.name];
    if (override) return override;
  }
  const own = command.description?.trim();
  return own && !PRODUCT_NAME.test(own) ? own : undefined;
}

/**
 * Not listed: PiLab's own controls do these, and the CLI's copy would leave the window
 * showing something else (decision 194 Q2, user 2026-10-18). `/clear` would start another
 * CLI session the chat's record does not follow, and `/model` and `/effort` would bypass
 * the pickers: the window's own `/clear`, `/model` and `/effort` take their place (a CLI
 * row of the name would win over them in the menu). `/config` and `/autocompact` change
 * settings PiLab sets: the window does not send them.
 */
export const SDK_PILAB_OWNED_COMMANDS: ReadonlySet<string> = new Set([
  'clear',
  'model',
  'effort',
  'config',
  'autocompact',
]);

/** Offered by the window and run through `worker.compact`, as on DSH. */
export const SDK_WINDOW_OWNED_COMMANDS: ReadonlySet<string> = new Set(['compact']);

/** The slice of the SDK's `SlashCommand` read here. */
export interface CliSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
}

/** The CLI's list as it came, the rows without a usable name dropped. */
export function cliSlashCommands(value: unknown): CliSlashCommand[] {
  if (!Array.isArray(value)) return [];
  const rows: CliSlashCommand[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== 'string' || row.name.trim() === '') continue;
    rows.push({
      name: row.name,
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
      ...(typeof row.argumentHint === 'string' ? { argumentHint: row.argumentHint } : {}),
      ...(row.builtin === true ? { builtin: true } : {}),
    });
  }
  return rows;
}

/** `worker.commands` of an SDK chat: the CLI's list, less the rows above. */
export function sdkSlashCommandRows(
  commands: readonly CliSlashCommand[],
  terminal: Iterable<string> = SDK_TERMINAL_COMMANDS_DEFAULT
): WorkerCommandsResult {
  const left = new Set<string>([
    ...SDK_HIDDEN_COMMANDS,
    ...SDK_PILAB_OWNED_COMMANDS,
    ...SDK_WINDOW_OWNED_COMMANDS,
    ...terminal,
  ]);
  const rows: WorkerSlashCommandInfo[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    if (left.has(command.name) || seen.has(command.name)) continue;
    seen.add(command.name);
    const builtin = command.builtin === true;
    const description = menuDescription(command);
    rows.push({
      name: command.name,
      ...(description ? { description } : {}),
      source: builtin ? SDK_COMMAND_SOURCE : SDK_SKILL_SOURCE,
      ...(!builtin && command.name.includes(':') ? { scope: 'plugin' } : {}),
    });
  }
  return {
    commands: rows.slice(0, WORKER_COMMAND_INVENTORY_MAX),
    truncated: rows.length > WORKER_COMMAND_INVENTORY_MAX,
  };
}

// ---- the transcript ------------------------------------------------------------------

const COMMAND_NAME = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * The line a command row of the CLI's transcript stands for (`/name args`), or null when
 * the row is not one. Both spellings: a local command's (`<command-name>` first) and a
 * skill's or custom command's (`<command-message>` first).
 */
export function commandRowLine(text: string): { name: string; line: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<command-name>') && !trimmed.startsWith('<command-message>')) {
    return null;
  }
  const named = COMMAND_NAME.exec(trimmed)?.[1]?.trim();
  if (!named) return null;
  const line = named.startsWith('/') ? named : `/${named}`;
  const args = COMMAND_ARGS.exec(trimmed)?.[1]?.trim() ?? '';
  return { name: line.slice(1), line: args ? `${line} ${args}` : line };
}

const LOCAL_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/;

/** A local command's output as the transcript keeps it, without its tags; null when it is not one. */
export function localCommandOutput(text: string): string | null {
  const match = LOCAL_OUTPUT.exec(text.trim());
  if (!match) return null;
  const body = (match[2] ?? '').trim();
  return body.length > 0 ? body : null;
}
