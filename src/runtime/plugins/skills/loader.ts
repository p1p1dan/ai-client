/**
 * P5-1 — skill discovery, the loader half.
 *
 * Provenance (AGENTS.md requires stating it): the discovery RULES are pi's, as
 * documented in `docs/skills.md` of the installed `pi-coding-agent`, which in
 * turn implements the Agent Skills standard (agentskills.io). Directory layout,
 * the `SKILL.md` convention, the "root `.md` only in pi-style roots" split and
 * the name/description frontmatter are kept verbatim so a skill written for the
 * user's `pi` CLI works here unchanged.
 *
 * Three things are ours:
 *
 * 1. **Reading goes through a port, not `node:fs`.** ARD D11 point 4 names
 *    "skills 加载" as one of the surfaces that must converge on the two host
 *    service exits, because the encrypted Windows target serves plaintext per
 *    process. pi-agent-core ships `loadSkills()`, but it takes an
 *    `ExecutionEnv` whose filesystem reads bypass that exit — so this is a
 *    reimplementation rather than a call, and the reason is the carrier, not
 *    taste. The `Skill` field shape is kept identical to pi's.
 * 2. **Everything is bounded.** A skill catalog lands in the system prompt, and
 *    the prompt is what ARD D9's cache gate measures; an unbounded directory of
 *    descriptions could quietly eat the context window.
 * 3. **Diagnostics are returned, not logged.** A skill that fails to parse is
 *    invisible otherwise — the user sees "my skill does nothing" with no way to
 *    tell a typo from a missing directory.
 */

import { basename, extname, join } from 'node:path';
import type { RuntimeFileKind } from '../../contracts.ts';

/** One skill, shaped exactly like pi-agent-core's `Skill`. */
export interface RuntimeSkill {
  /** Lookup key and the name the model sees. */
  name: string;
  /** One line telling the model when to use it. */
  description: string;
  /** Absolute path to the skill file; the `skill` tool reads this and nothing else. */
  filePath: string;
  /** Which root it came from, for the command list's scope column. */
  scope: SkillScope;
}

export type SkillScope = 'user' | 'project';

export type SkillDiagnosticCode = 'read_failed' | 'parse_failed' | 'invalid_metadata' | 'too_many';

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  message: string;
  path: string;
}

/**
 * One directory to scan.
 *
 * `rootMarkdown` is the only behavioural difference between pi's two families
 * of skill root: in `<agentDir>/skills/` and `.pi/skills/` a loose `foo.md` at
 * the top level IS a skill, while in `~/.agents/skills/` and `.agents/skills/`
 * the top level is grouping folders and a loose `.md` there is ignored. Nested
 * `.md` files declare themselves through frontmatter in both.
 */
export interface SkillRoot {
  path: string;
  scope: SkillScope;
  rootMarkdown: boolean;
}

/**
 * The file access this module needs, and nothing more.
 *
 * Both answer `undefined` for the expected absences — no skills directory at
 * all is the normal case for a new user, not an error worth failing a prompt
 * build over. Unexpected host failures still propagate: on the encrypted target
 * a transport fault must not read as "the user has no skills".
 */
export interface SkillSource {
  readText(path: string): Promise<string | undefined>;
  list(path: string): Promise<readonly { name: string; kind: RuntimeFileKind }[] | undefined>;
}

/** Skills past this are dropped with a diagnostic rather than silently trimmed. */
export const MAX_SKILLS = 200;
/** Per-skill description budget in the catalog block. */
export const MAX_DESCRIPTION_BYTES = 1024;
/** How deep a skill tree is walked. Deeper entries are not skills, they are assets. */
export const MAX_SKILL_DEPTH = 4;

const SKILL_FILE = 'SKILL.md';

/** Frontmatter delimiters, tolerant of a BOM and CRLF the way pi is. */
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  /** Prompt templates use it; parsed here because both share this reader. */
  argumentHint?: string;
}

/**
 * Read the leading `---` block as a flat map of scalars.
 *
 * Deliberately NOT a YAML parser. The fields that matter here are all one-line
 * scalars, and pulling a YAML dependency into the runtime subpackage to read
 * three of them would add a parser — and its failure modes — to the trusted
 * path that composes the system prompt. A file whose frontmatter needs real
 * YAML simply does not declare a description, and is reported as such.
 */
export function parseFrontmatter(text: string): SkillFrontmatter | undefined {
  const match = FRONTMATTER.exec(text);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    // Indented lines belong to a nested structure this reader does not model;
    // skipping them is what keeps a list-valued key from being read as a scalar.
    if (separator <= 0 || /^\s/.test(line)) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }
  return {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields['argument-hint'] ? { argumentHint: fields['argument-hint'] } : {}),
  };
}

/** Collapse to one line: a description is a prompt row, and a newline breaks the block. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function limitBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

/**
 * Skill names address the `skill` tool, so they must be unambiguous.
 *
 * pi allows a name to differ from its directory (its docs say so explicitly,
 * for shared skill directories); what it cannot allow is a name that collides
 * with the command syntax. `/skill:a b` already splits on whitespace, and a
 * name with a slash would be indistinguishable from a path.
 */
function isValidName(name: string): boolean {
  return /^[\w.-]{1,64}$/.test(name);
}

async function readSkillFile(
  source: SkillSource,
  filePath: string,
  fallbackName: string,
  scope: SkillScope,
  /** Root-level loose `.md` in an `.agents`-style root is not a skill declaration. */
  required: boolean,
  diagnostics: SkillDiagnostic[]
): Promise<RuntimeSkill | undefined> {
  let text: string | undefined;
  try {
    text = await source.readText(filePath);
  } catch (error) {
    diagnostics.push({
      code: 'read_failed',
      path: filePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (text === undefined) return undefined;
  const front = parseFrontmatter(text);
  if (!front) {
    // Silent for an undeclared file — pi ignores those on purpose, and a
    // README.md next to a skill is not a mistake worth reporting.
    if (required) {
      diagnostics.push({
        code: 'parse_failed',
        path: filePath,
        message: 'no frontmatter block; a skill file starts with a --- delimited header',
      });
    }
    return undefined;
  }
  const description = front.description ? oneLine(front.description) : '';
  if (!description) {
    if (required) {
      diagnostics.push({
        code: 'invalid_metadata',
        path: filePath,
        message: 'frontmatter has no non-empty description',
      });
    }
    return undefined;
  }
  const name = front.name ? oneLine(front.name) : fallbackName;
  if (!isValidName(name)) {
    diagnostics.push({
      code: 'invalid_metadata',
      path: filePath,
      message: `skill name "${name}" is not usable as a command; use letters, digits, dot, dash or underscore`,
    });
    return undefined;
  }
  return {
    name,
    description: limitBytes(description, MAX_DESCRIPTION_BYTES),
    filePath,
    scope,
  };
}

async function walkRoot(
  source: SkillSource,
  root: SkillRoot,
  found: RuntimeSkill[],
  diagnostics: SkillDiagnostic[]
): Promise<void> {
  const visit = async (directory: string, depth: number, atRoot: boolean): Promise<void> => {
    if (depth > MAX_SKILL_DEPTH || found.length >= MAX_SKILLS) return;
    let entries: readonly { name: string; kind: RuntimeFileKind }[] | undefined;
    try {
      entries = await source.list(directory);
    } catch (error) {
      diagnostics.push({
        code: 'read_failed',
        path: directory,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!entries) return;
    // Sorted so two machines with the same skills produce the same catalog, and
    // therefore the same cacheable system prompt prefix (ARD D9).
    const ordered = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const skillFile = ordered.find((entry) => entry.name === SKILL_FILE && entry.kind === 'file');
    if (skillFile && !atRoot) {
      // A directory with SKILL.md IS the skill; its subdirectories are that
      // skill's assets, not more skills.
      const skill = await readSkillFile(
        source,
        join(directory, SKILL_FILE),
        basename(directory),
        root.scope,
        true,
        diagnostics
      );
      if (skill) found.push(skill);
      return;
    }

    for (const entry of ordered) {
      if (found.length >= MAX_SKILLS) return;
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.kind === 'directory') {
        await visit(path, depth + 1, false);
        continue;
      }
      if (entry.kind !== 'file' || extname(entry.name).toLowerCase() !== '.md') continue;
      // Below the root a `SKILL.md` was already consumed by the branch above as
      // the whole directory's skill. At the root there is no directory to name
      // it after, so it is just another loose `.md` and follows that rule.
      if (entry.name === SKILL_FILE && !atRoot) continue;
      // pi's split: a loose `.md` at the top of an `.agents`-style root is
      // ignored outright; anywhere else it is a skill if it declares itself.
      if (atRoot && !root.rootMarkdown) continue;
      const skill = await readSkillFile(
        source,
        path,
        basename(entry.name, extname(entry.name)),
        root.scope,
        false,
        diagnostics
      );
      if (skill) found.push(skill);
    }
  };
  await visit(root.path, 0, true);
}

export interface LoadedSkills {
  skills: readonly RuntimeSkill[];
  diagnostics: readonly SkillDiagnostic[];
}

/**
 * Scan every root in order and resolve name collisions by first-wins.
 *
 * Roots are passed most-general first (user before project), and the LAST one
 * to claim a name wins — the same precedence the instruction chain uses, where
 * something closer to the work overrides something further from it. A dropped
 * duplicate is not reported: overriding a user skill from a project is a
 * feature, not a mistake.
 */
export async function loadSkills(
  source: SkillSource,
  roots: readonly SkillRoot[]
): Promise<LoadedSkills> {
  const found: RuntimeSkill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const root of roots) {
    if (found.length >= MAX_SKILLS) {
      diagnostics.push({
        code: 'too_many',
        path: root.path,
        message: `stopped after ${MAX_SKILLS} skills; this root was not scanned`,
      });
      continue;
    }
    await walkRoot(source, root, found, diagnostics);
  }
  const byName = new Map<string, RuntimeSkill>();
  for (const skill of found) byName.set(skill.name, skill);
  return {
    skills: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    diagnostics,
  };
}
