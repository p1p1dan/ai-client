/**
 * P5-1 (K2) — turning what the user typed into what the model receives.
 *
 * On the legacy backend this is free: `session.prompt()` expands `/name` and
 * `/skill:name` itself, because we never pass `expandPromptTemplates: false`.
 * The native backend has no such layer, so a user who types `/review` today
 * sends the literal five characters to the model. This module is that missing
 * step, and it is deliberately a PURE function over an already-loaded catalog:
 * expansion happens on the send path, where a directory scan would put disk IO
 * between the user pressing Enter and the turn starting.
 *
 * Provenance: `substituteArgs` and `parseCommandArgs` are ported from pi's
 * `harness/prompt-templates.js` so a template written for the user's `pi` CLI
 * substitutes identically here. The `/skill:name` wrapper follows pi's
 * `formatSkillInvocation`.
 */

import { dirname } from 'node:path';
import type { RuntimeSkill } from './loader.ts';
import type { RuntimePromptTemplate } from './templates.ts';

/** Ported verbatim from pi: simple shell-style single and double quotes. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === ' ' || char === '\t') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/** Ported verbatim from pi: `$1`, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`. */
export function substituteArgs(content: string, args: readonly string[]): string {
  let result = content.replace(
    /\$(\d+)/g,
    (_, num: string) => args[Number.parseInt(num, 10) - 1] ?? ''
  );
  result = result.replace(
    /\$\{@:(\d+)(?::(\d+))?\}/g,
    (_, startStr: string, lengthStr?: string) => {
      const start = Math.max(0, Number.parseInt(startStr, 10) - 1);
      if (lengthStr) return args.slice(start, start + Number.parseInt(lengthStr, 10)).join(' ');
      return args.slice(start).join(' ');
    }
  );
  const allArgs = args.join(' ');
  return result.replace(/\$ARGUMENTS/g, allArgs).replace(/\$@/g, allArgs);
}

export interface SlashInvocation {
  kind: 'skill' | 'template';
  name: string;
  /** Raw text after the command, before quote splitting. */
  args: string;
}

/**
 * Recognise a leading slash command, or answer `undefined`.
 *
 * Only the FIRST line is considered, and only when the message starts with the
 * slash: a prompt that merely mentions `/usr/bin` or pastes a diff containing
 * `/dev/null` must go to the model untouched. A command with trailing lines
 * keeps them — `/review` followed by three lines of context is one invocation
 * whose argument text spans the rest of the message.
 */
export function parseSlashInvocation(text: string): SlashInvocation | undefined {
  if (!text.startsWith('/')) return undefined;
  // `\s+` rather than `[ \t]+` so a command on its own line keeps the lines
  // below it as its arguments — "/review" then three lines of context is one
  // invocation, not an unrecognised command that silently goes out verbatim.
  const match = /^\/(skill:)?([\w.-]{1,64})(?:\s+([\s\S]*))?$/.exec(text.trimEnd());
  if (!match) return undefined;
  return {
    kind: match[1] ? 'skill' : 'template',
    name: match[2],
    args: match[3] ?? '',
  };
}

export interface ExpansionCatalog {
  skills: readonly RuntimeSkill[];
  templates: readonly RuntimePromptTemplate[];
  /** Reads a skill or template body. Bounded by the caller. */
  readBody(filePath: string): Promise<string | undefined>;
  /**
   * T002 — gate a `/skill:name` invocation the same way the `skill` tool is
   * gated, before its body is read. Absent means unchecked, which is only
   * correct for a caller that has no permission system to consult (tests,
   * previews); the runtime wiring in `index.ts` always supplies this.
   */
  authorizeSkill?(skill: RuntimeSkill): Promise<void>;
}

export type ExpansionResult =
  | { expanded: true; text: string; invocation: SlashInvocation }
  /** Not a command, or a command this catalog does not know. Send the text as typed. */
  | { expanded: false; reason?: 'unknown_command' | 'unreadable' };

/**
 * Expand one prompt.
 *
 * An unknown `/name` is NOT an error: the composer's own commands (`/new`,
 * `/settings`, `/compact`) never reach the worker, and a user typing a path
 * fragment must not get a failed turn. It goes to the model verbatim, which is
 * also what pi does.
 */
export async function expandPrompt(
  text: string,
  catalog: ExpansionCatalog
): Promise<ExpansionResult> {
  const invocation = parseSlashInvocation(text);
  if (!invocation) return { expanded: false };

  if (invocation.kind === 'skill') {
    const skill = catalog.skills.find((item) => item.name === invocation.name);
    if (!skill) return { expanded: false, reason: 'unknown_command' };
    await catalog.authorizeSkill?.(skill);
    const content = await catalog.readBody(skill.filePath);
    if (content === undefined) return { expanded: false, reason: 'unreadable' };
    return {
      expanded: true,
      text: formatSkillInvocation(skill, content, invocation.args),
      invocation,
    };
  }

  const template = catalog.templates.find((item) => item.name === invocation.name);
  if (!template) return { expanded: false, reason: 'unknown_command' };
  const content = await catalog.readBody(template.filePath);
  if (content === undefined) return { expanded: false, reason: 'unreadable' };
  return {
    expanded: true,
    text: substituteArgs(content, parseCommandArgs(invocation.args)),
    invocation,
  };
}

/**
 * pi's `formatSkillInvocation`, with the body passed in rather than carried on
 * the skill: the catalog holds descriptions only, so that a hundred installed
 * skills cost a hundred short rows instead of a hundred full documents.
 */
export function formatSkillInvocation(
  skill: RuntimeSkill,
  content: string,
  additionalInstructions = ''
): string {
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirname(skill.filePath)}.\n\n${content}\n</skill>`;
  const extra = additionalInstructions.trim();
  return extra ? `${block}\n\nUser: ${extra}` : block;
}
