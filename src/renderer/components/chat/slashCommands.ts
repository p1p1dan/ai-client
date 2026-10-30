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

import type { ChatEngine } from '@shared/claudeSdkEngine';
import { englishTranslate, type Translate } from '@shared/i18n';

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
  /** What it takes after its name (`[prompt]`); the composer greys it in after the name. */
  argumentHint?: string;
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
  | { type: 'model'; query: string }
  | { type: 'effort'; query: string }
  | { type: 'settings' }
  | { type: 'archive' }
  | { type: 'compact'; instructions?: string }
  /** Layout 5f (ruling L6): the side chat; an empty question opens it empty. */
  | { type: 'btw'; question: string }
  | { type: 'runtime' };

/** Commands that are actions in this window; pi has no idea these exist. */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<{ name: string; descriptionKey: string }> = [
  { name: 'new', descriptionKey: 'Start a new conversation' },
  // Decision 194 Q2 (user, 2026-10-18): the CLI's `/clear`, `/model` and `/effort` run
  // here instead, so the window and the engine never disagree. `/clear` is `/new` from
  // this conversation's folder and model; the conversation itself is kept.
  {
    name: 'clear',
    descriptionKey:
      'Start over with an empty context: a new conversation in this folder with this model; this one is kept',
  },
  { name: 'model', descriptionKey: 'Switch the model; with no name, open the model menu' },
  {
    name: 'effort',
    descriptionKey: 'Set the reasoning effort; with no level, open the model menu',
  },
  { name: 'settings', descriptionKey: 'Open settings' },
  // Layout 5f (ruling L6): asked beside the conversation, never sent into it.
  {
    name: 'btw',
    descriptionKey: 'Ask a quick side question without interrupting the conversation',
  },
  { name: 'archive', descriptionKey: 'Archive this conversation' },
  // Decision 179: instructions may follow (`/compact keep the open tasks`).
  {
    name: 'compact',
    descriptionKey: 'Compact the context of this conversation; instructions may follow',
  },
];

/**
 * Decision 175: what the menu asks Main for — the chat when there is one, and
 * the folder the menu is for (the home page's draft target, the chat's own),
 * so a workspace with no session up on the host still gets its skills.
 * Decision 194: and the engine the chat runs on, or the next send would go to
 * (`chatEngineForDisplay`), so the menu lists that engine's commands.
 */
export function slashCatalogRequest(
  sessionId: string | null,
  workspacePath: string | null,
  engine: ChatEngine = 'dsh'
): { sessionId?: string; workspacePath?: string; engine: ChatEngine } {
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    engine,
  };
}

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
 * PiLab R2 (user ruling 2026-10-30): the name a draft starts with when it reads
 * as a command the catalog does not have — a slip like `/reveiw` — so the
 * composer asks before sending it as prose. Null for a known command, for
 * prose, and for a path (`/home/pi/a.txt …`: a second `/` in the first word).
 */
export function unknownSlashCommand(
  value: string,
  catalog: readonly SlashCatalogItem[]
): string | null {
  const name = /^\/([A-Za-z][\w:.-]*)(?=$|\s)/.exec(value.trim())?.[1];
  if (!name) return null;
  return catalog.some((item) => item.name === name) ? null : name;
}

/**
 * The command a draft starts with, when the menu knows it: the composer paints
 * its name (`end` is where the name stops) and greys in its argument hint. The
 * name must sit at the first byte and be followed by whitespace or the end, the
 * same first token `extractSlashQuery` completes.
 */
export function typedSlashCommand(
  value: string,
  catalog: readonly SlashCatalogItem[]
): { item: SlashCatalogItem; end: number } | null {
  const name = /^\/(\S+)(?=$|\s)/u.exec(value)?.[1];
  if (!name) return null;
  const item = catalog.find((entry) => entry.name === name);
  return item ? { item, end: 1 + name.length } : null;
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
 *
 * Decision 166: a DSH command's description is DSH's own English sentence, so
 * it is looked up as a dictionary key; a sentence the dictionary does not
 * know stays as DSH wrote it (`translate` returns the key). Skills keep their
 * author's words.
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
  const commands = runtime.map((item) =>
    item.source === 'command' && item.description
      ? { ...item, description: translate(item.description) }
      : item
  );
  return [...commands, ...builtins].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * dsh-rebase P1-7e problem 9 (decision 144): the menu row's source tag, as a
 * catalog key. `source` is an identifier — `builtin` is this window's own,
 * `command` a DSH command, `skill` a skill, and 1.0.x's pi also sent `prompt`
 * and `extension` — so it is never printed raw. An origin this build does not
 * know is shown as it came rather than guessed at.
 */
const SLASH_SOURCE_KEYS: Readonly<Record<string, string>> = {
  builtin: 'Built in',
  command: 'Command',
  skill: 'Skill',
  prompt: 'Prompt template',
  extension: 'Extension',
};

export function slashSourceLabel(source: string, t: Translate = englishTranslate): string {
  const key = SLASH_SOURCE_KEYS[source];
  return key ? t(key) : source;
}

/**
 * The menu's rows as painted: `source` in words ({@link slashSourceLabel}).
 * Only the menu reads these. Picking a row inserts its `name`, and running a
 * command looks its `source` up in the catalog again (`resolveSlashAction`),
 * never on a painted row.
 */
export function slashRowsForDisplay(
  items: readonly SlashCatalogItem[],
  t: Translate = englishTranslate
): SlashCatalogItem[] {
  return items.map((item) => ({ ...item, source: slashSourceLabel(item.source, t) }));
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
    // Decision 194 Q2: the CLI's `/clear` and its alias `/reset`.
    case 'clear':
    case 'reset':
      return { type: 'new' };
    case 'model':
      return { type: 'model', query: args };
    case 'effort':
      return { type: 'effort', query: args };
    case 'settings':
      return { type: 'settings' };
    case 'archive':
      return { type: 'archive' };
    case 'compact':
      return args ? { type: 'compact', instructions: args } : { type: 'compact' };
    case 'btw':
      return { type: 'btw', question: args };
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
