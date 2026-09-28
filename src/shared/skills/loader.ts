// Moved from src/runtime/plugins/skills/loader.ts (dsh-rebase P1-16 prep)

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
 *    "skill loading" as one of the surfaces that must converge on the two host
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
import { parseFrontmatter, type SkillDiagnostic } from './frontmatter.ts';

export {
  type FrontmatterReport,
  parseFrontmatter,
  type SkillDiagnostic,
  type SkillDiagnosticCode,
  type SkillFrontmatter,
} from './frontmatter.ts';

/** A directory entry's kind, as the host's listing reports it (a symlink is not followed). */
export type SkillFileKind = 'file' | 'directory' | 'symlink' | 'other';

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
  /**
   * skills-mcp-09 — the author's own `disable-model-invocation: true`. It only
   * removes the skill from the system prompt segment (see `prompt.ts`); the
   * `skill` tool and `/skill:name` expansion still honour an explicit request,
   * matching pi's `disableModelInvocation` semantics.
   */
  disableModelInvocation: boolean;
}

export type SkillScope = 'user' | 'project';

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
  list(path: string): Promise<readonly { name: string; kind: SkillFileKind }[] | undefined>;
  /**
   * skills-mcp-08 — resolve what a `symlink` directory entry points at.
   * `list()` uses the OS's Dirent, which never follows a link, so a symlinked
   * skill directory or file needs this to learn its real kind. `undefined`
   * covers every expected absence a stat can hit: broken link, a symlink
   * loop, or the target vanishing between the listing and this call.
   */
  stat(path: string): Promise<{ kind: SkillFileKind } | undefined>;
}

/** Skills past this are dropped with a diagnostic rather than silently trimmed. */
export const MAX_SKILLS = 200;
/** Per-skill description budget in the catalog block. */
export const MAX_DESCRIPTION_BYTES = 1024;
/** How deep a skill tree is walked. Deeper entries are not skills, they are assets. */
export const MAX_SKILL_DEPTH = 4;

const SKILL_FILE = 'SKILL.md';

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
  const front = parseFrontmatter(text, { diagnostics, path: filePath });
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
    disableModelInvocation: front.disableModelInvocation === true,
  };
}

/**
 * skills-mcp-08 — learn what a directory entry actually is before deciding
 * whether it is a skill directory, a skill file, or neither.
 *
 * `list()`'s Dirent kind never follows a symlink, so a symlink entry is
 * resolved with a `stat()` (which does follow it). `file`/`directory` entries
 * are already known and skip the extra call; `other` (sockets, devices, ...)
 * is never a skill and needs no diagnostic. A symlink whose target cannot be
 * resolved — broken, a loop, or vanished — gets a `read_failed` diagnostic
 * instead of vanishing silently, because from the user's side the skill
 * "does nothing" with no clue why.
 */
export async function resolveEntryKind(
  source: SkillSource,
  path: string,
  kind: SkillFileKind,
  diagnostics: SkillDiagnostic[]
): Promise<'file' | 'directory' | undefined> {
  if (kind === 'file' || kind === 'directory') return kind;
  if (kind !== 'symlink') return undefined;
  let resolved: { kind: SkillFileKind } | undefined;
  try {
    resolved = await source.stat(path);
  } catch (error) {
    diagnostics.push({
      code: 'read_failed',
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (resolved?.kind !== 'file' && resolved?.kind !== 'directory') {
    diagnostics.push({
      code: 'read_failed',
      path,
      message:
        'symlink target could not be resolved (broken link, a loop, or not a file/directory)',
    });
    return undefined;
  }
  return resolved.kind;
}

async function walkRoot(
  source: SkillSource,
  root: SkillRoot,
  found: RuntimeSkill[],
  diagnostics: SkillDiagnostic[]
): Promise<void> {
  const visit = async (directory: string, depth: number, atRoot: boolean): Promise<void> => {
    if (depth > MAX_SKILL_DEPTH || found.length >= MAX_SKILLS) return;
    let entries: readonly { name: string; kind: SkillFileKind }[] | undefined;
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

    const skillFileEntry = ordered.find(
      (entry) => entry.name === SKILL_FILE && (entry.kind === 'file' || entry.kind === 'symlink')
    );
    if (skillFileEntry && !atRoot) {
      // A directory with SKILL.md IS the skill; its subdirectories are that
      // skill's assets, not more skills. This is decisive even if the entry
      // turns out to be an unresolvable symlink: it is still not a directory
      // of more skills.
      const skillFilePath = join(directory, SKILL_FILE);
      const resolvedKind = await resolveEntryKind(
        source,
        skillFilePath,
        skillFileEntry.kind,
        diagnostics
      );
      if (resolvedKind === 'file') {
        const skill = await readSkillFile(
          source,
          skillFilePath,
          basename(directory),
          root.scope,
          true,
          diagnostics
        );
        if (skill) found.push(skill);
      }
      return;
    }

    for (const entry of ordered) {
      if (found.length >= MAX_SKILLS) return;
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      const effectiveKind = await resolveEntryKind(source, path, entry.kind, diagnostics);
      if (effectiveKind === 'directory') {
        await visit(path, depth + 1, false);
        continue;
      }
      if (effectiveKind !== 'file' || extname(entry.name).toLowerCase() !== '.md') continue;
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
 * Scan every root in order and resolve name collisions by last-wins.
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
