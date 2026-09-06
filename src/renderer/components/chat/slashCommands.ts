/**
 * R02-c — parsing, filtering and routing slash commands. Pure, no React.
 *
 * ## Two things this file keeps apart
 *
 * **Execution is already wired.** `session.prompt()` dispatches extension
 * commands and expands skills and prompt templates by default, and the worker
 * never passes `expandPromptTemplates: false`. So a runtime command needs no
 * handling at all — it goes out as ordinary text and pi does the rest. What is
 * added here is *discovery* (the menu) and the handful of commands pi cannot
 * possibly know about because they are actions in this window.
 *
 * **`/` is not `@`.** The mention popup (`fileMention.ts`) triggers on an `@`
 * anywhere a whitespace precedes it. A slash command is only a command as the
 * FIRST thing in the message — `see the /tmp path` is prose, and pi treats it
 * as prose too.
 */

/** A command as it will be shown in the menu, whatever its origin. */
export interface SlashCatalogItem {
  /** Invocation name without the leading slash; skills read `skill:<name>`. */
  name: string;
  description: string;
  /** `extension` | `prompt` | `skill` from pi, or `builtin` from this window. */
  source: string;
  /** Absolute path pi resolved it from. Absent for builtins. */
  path?: string;
  scope?: string;
}

/**
 * What a parsed command turns into.
 *
 * `runtime` is not a fallback for "unknown" — it is the answer for everything
 * pi owns, including commands this build has never heard of. An unknown name
 * also lands here, and pi reports it: that is better than this layer guessing,
 * because a newer plugin is far likelier than a typo.
 */
export type SlashAction =
  | { type: 'new' }
  | { type: 'settings' }
  | { type: 'archive' }
  | { type: 'compact'; instructions?: string }
  | { type: 'runtime' };

/** Commands that are actions in this window; pi has no idea these exist. */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<{ name: string; descriptionKey: string }> = [
  { name: 'new', descriptionKey: 'Start a new conversation' },
  { name: 'settings', descriptionKey: 'Open settings' },
  { name: 'archive', descriptionKey: 'Archive this conversation' },
  { name: 'compact', descriptionKey: 'Compact the context of this conversation' },
];

/**
 * Split a message that is entirely one command.
 *
 * Anchored at the start, and the whole message must be the command plus its
 * arguments. Returns null for prose that merely contains a slash.
 */
export function parseSlashLine(value: string): { name: string; args: string } | null {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(value.trim());
  if (!match?.[1]) return null;
  return { name: match[1], args: (match[2] ?? '').trim() };
}

/**
 * The partial command name to complete, or null when the menu should be closed.
 *
 * Open only while the caret is still inside the FIRST token of a message that
 * starts with `/`. Once the user types a space the name is settled and the menu
 * would just be in the way of typing arguments.
 */
export function extractSlashQuery(text: string, cursorPos: number): string | null {
  if (!text.startsWith('/')) return null;
  const firstBreak = text.search(/[\s]/);
  const nameEnd = firstBreak === -1 ? text.length : firstBreak;
  if (cursorPos < 1 || cursorPos > nameEnd) return null;
  return text.slice(1, nameEnd);
}

/**
 * Menu rows for a query, prefix matches first.
 *
 * Descriptions are searched as well as names: someone who remembers "the one
 * that starts a new chat" but not that it is called `new` still finds it.
 */
export function filterSlashCommands(
  items: readonly SlashCatalogItem[],
  query: string,
  limit = 24
): SlashCatalogItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return items
    .filter((item) => {
      if (!needle) return true;
      return (
        item.name.toLocaleLowerCase().includes(needle) ||
        item.description.toLocaleLowerCase().includes(needle)
      );
    })
    .sort((a, b) => {
      const aPrefix = a.name.toLocaleLowerCase().startsWith(needle) ? 0 : 1;
      const bPrefix = b.name.toLocaleLowerCase().startsWith(needle) ? 0 : 1;
      return aPrefix - bPrefix || a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

/**
 * Merge pi's commands with this window's own.
 *
 * **pi wins on a name collision.** If a plugin registered `new`, the plugin's
 * `new` is what the menu offers and what runs — see `resolveSlashAction`. A
 * client that quietly takes a name from a plugin breaks it in a way neither the
 * user nor the plugin author can see.
 */
export function buildSlashCatalog(
  runtime: readonly SlashCatalogItem[],
  translate: (key: string) => string
): SlashCatalogItem[] {
  const taken = new Set(runtime.map((item) => item.name));
  const builtins = BUILTIN_SLASH_COMMANDS.filter((builtin) => !taken.has(builtin.name)).map(
    (builtin) => ({
      name: builtin.name,
      description: translate(builtin.descriptionKey),
      source: 'builtin',
    })
  );
  return [...runtime, ...builtins].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which action a typed command maps to.
 *
 * The first line is load-bearing: **look up who owns the name before claiming
 * it**. `source` comes from the catalog, so a plugin's `new` resolves to
 * `runtime` and reaches pi untouched. Without this, adding a builtin would
 * silently shadow any plugin that had already taken the name.
 */
export function resolveSlashAction(name: string, args: string, source?: string): SlashAction {
  if (source && source !== 'builtin') return { type: 'runtime' };
  switch (name) {
    case 'new':
      return { type: 'new' };
    case 'settings':
      return { type: 'settings' };
    case 'archive':
      return { type: 'archive' };
    case 'compact':
      return args ? { type: 'compact', instructions: args } : { type: 'compact' };
    default:
      return { type: 'runtime' };
  }
}

/**
 * Text after picking `name` from the menu, and where to put the caret.
 *
 * A trailing space is appended so the next keystroke is an argument rather than
 * more of the name — and so `extractSlashQuery` closes the menu, which is the
 * same convention `replaceMention` uses.
 */
export function replaceSlashCommand(text: string, name: string): { text: string; cursor: number } {
  const firstBreak = text.search(/[\s]/);
  const rest = firstBreak === -1 ? '' : text.slice(firstBreak);
  const head = `/${name} `;
  return { text: `${head}${rest.trimStart()}`, cursor: head.length };
}
