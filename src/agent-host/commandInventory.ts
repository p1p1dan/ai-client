/**
 * R02-a — project pi's available slash commands into something the UI can show.
 *
 * ## Why this is a projection and not a lookup
 *
 * pi exposes a single `getCommands()` that merges all three kinds, but only on
 * the *extension* context — the object handed to a plugin factory. An embedded
 * host holds the `AgentSession`, which exposes the three sources separately.
 * So this assembles the same list from the same three places pi's own RPC mode
 * uses (`modes/rpc/rpc-mode.js`, `case "get_commands"`), in the same order.
 *
 * ## What "available" means
 *
 * Execution is already wired: `session.prompt()` dispatches extension commands
 * and expands skills and prompt templates, and it does so by default because we
 * never pass `expandPromptTemplates: false`. Typing `/skill:foo` works today.
 * What is missing is discovery, which is what this list feeds.
 *
 * ## Defensive throughout
 *
 * Same policy as `extensionInventory.ts`: this reads SDK shapes across a
 * version boundary, and a command list is decoration. An unreadable entry is
 * dropped, never thrown on — a surprise here must not be able to break a
 * session that is otherwise fine.
 */

import {
  WORKER_COMMAND_INVENTORY_MAX,
  type WorkerCommandsResult,
  type WorkerSlashCommandInfo,
} from '../shared/types/workerRpc.ts';

/** The slice of `AgentSession` this module reads. All parts optional. */
export interface PiCommandSources {
  extensionRunner?: { getRegisteredCommands?: () => unknown };
  promptTemplates?: unknown;
  resourceLoader?: { getSkills?: () => { skills?: unknown } };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `sourceInfo` is the only place a command says where on disk it came from. */
function readOrigin(value: unknown): Pick<WorkerSlashCommandInfo, 'path' | 'scope'> {
  const info = readRecord(value);
  if (!info) return {};
  const path = readString(info.path);
  const scope = readString(info.scope);
  return { ...(path ? { path } : {}), ...(scope ? { scope } : {}) };
}

function entriesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Read one kind into rows.
 *
 * `nameOf` differs per kind and is the reason this is a parameter rather than a
 * field name: extension commands are keyed by `invocationName` (the name after
 * any package prefix pi applied), while templates and skills use `name`.
 */
function collect(
  entries: unknown[],
  source: string,
  nameOf: (record: Record<string, unknown>) => string | undefined
): WorkerSlashCommandInfo[] {
  const rows: WorkerSlashCommandInfo[] = [];
  for (const entry of entries) {
    const record = readRecord(entry);
    if (!record) continue;
    const name = nameOf(record);
    if (!name) continue;
    const description = readString(record.description);
    rows.push({
      name,
      source,
      ...(description ? { description } : {}),
      ...readOrigin(record.sourceInfo),
    });
  }
  return rows;
}

/**
 * Every slash command this session can run, in pi's own order.
 *
 * Skills keep pi's `skill:` prefix in the name. That prefix is what
 * `_expandSkillCommand` matches on, so a "tidier" bare name here would produce
 * a command the runtime silently does not recognise.
 */
export function readSlashCommandInventory(
  session: PiCommandSources | undefined
): WorkerCommandsResult {
  if (!session) return { commands: [], truncated: false };

  const rows: WorkerSlashCommandInfo[] = [];

  try {
    rows.push(
      ...collect(entriesOf(session.extensionRunner?.getRegisteredCommands?.()), 'extension', (r) =>
        readString(r.invocationName)
      )
    );
  } catch {
    // A plugin that throws while listing its commands must not cost the user
    // the skills and templates below.
  }

  try {
    rows.push(...collect(entriesOf(session.promptTemplates), 'prompt', (r) => readString(r.name)));
  } catch {
    // ignored for the same reason
  }

  try {
    const skills = entriesOf(session.resourceLoader?.getSkills?.()?.skills);
    rows.push(
      ...collect(skills, 'skill', (r) => {
        const name = readString(r.name);
        return name ? (name.startsWith('skill:') ? name : `skill:${name}`) : undefined;
      })
    );
  } catch {
    // ignored for the same reason
  }

  const truncated = rows.length > WORKER_COMMAND_INVENTORY_MAX;
  return {
    commands: truncated ? rows.slice(0, WORKER_COMMAND_INVENTORY_MAX) : rows,
    truncated,
  };
}
