/**
 * dsh-rebase decision 175 (GitHub issue #6 follow-up): the skills the DSH host
 * would offer a workspace, read from disk by DSH's own rules — for the
 * composer's slash menu while no session is up in that workspace.
 *
 * ## Why Main reads them
 *
 * The menu is a worker's answer (`worker.commands`: DSH's commands and the
 * user-invocable skills of the session's workspace). A conversation that is
 * not running on the host has no worker to ask — the home page, a chat not
 * sent to yet, one the idle sweep or a host restart took down — so its menu
 * held the window's own four commands, or on the home page the list of
 * whichever chat happened to be running, from another repository. A `/name`
 * typed there still ran the skill once sent: DSH reads the gesture off every
 * user message, a session's first included. Nothing offered it.
 *
 * ## The rules are DSH's, restated
 *
 * As installed in src/dsh-host: `@deepseek-ai/dsh-skill-filesystem` for the
 * roots, the entries and the frontmatter; `@deepseek-ai/dsh-skill` for the
 * name grammar and which of two same-named skills wins; `slashCommandRows`
 * (src/dsh-host/bridge/commands.ts) for what the menu offers. The tests run
 * DSH's own provider over the same directories and compare. Once a session is
 * up in the workspace, its worker's list replaces this one.
 *
 * Pure apart from the `SkillSource` port it reads through: `skillSource` over
 * `nodeLegacyAssetFiles` in Main (only `.md` files and directory listings,
 * which the encrypted Windows target serves to node in plaintext), temporary
 * directories in tests.
 */

import { dirname, join, resolve } from 'node:path';
import type { ChatEngine } from '@shared/claudeSdkEngine';
import { MAX_SCAN_BYTES, skillSource } from '@shared/skills/catalog';
import type { SkillFileKind, SkillSource } from '@shared/skills/loader';
import {
  isWorkerCommandsResult,
  sanitizeWorkerCommandRows,
  WORKER_COMMAND_INVENTORY_MAX,
  type WorkerCommandsResult,
  type WorkerSlashCommandInfo,
} from '@shared/types/workerRpc';
import { nodeLegacyAssetFiles } from '../legacyAssets/nodeFiles';
import type { WorkerSlashCommandsAnswer } from './WorkerManager';

// ---- what DSH accepts -------------------------------------------------------

/** `SKILL_NAME` of @deepseek-ai/dsh-skill: kebab-case. */
export const DSH_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `WINDOW_OWNED_COMMANDS` of bridge/commands.ts: the window runs `/compact`
 * itself, so no skill takes the name (`slashCommandRows`).
 */
export const WINDOW_OWNED_COMMAND_NAMES: readonly string[] = ['compact'];

/** `SKILL_SOURCE` of bridge/commands.ts: a menu row that is a skill. */
const SKILL_SOURCE = 'skill';

/** Spellings dsh-skill-filesystem refuses outright: the whole skill is dropped. */
const LEGACY_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable'];

// ---- roots --------------------------------------------------------------------

/** dsh-skill-filesystem's root labels, in its rank order. */
export type DshSkillRootSource =
  | 'project-dsh'
  | 'project-agents'
  | 'custom'
  | 'user-dsh'
  | 'user-agents';

export interface DshSkillRoot {
  path: string;
  source: DshSkillRootSource;
  /** dsh-skill-filesystem's rank: the lowest of two same-named skills wins. */
  rank: number;
  /** `user-dsh` only: its `.system` child is never a skill. */
  skipSystem?: true;
}

/**
 * Where the host's `skill-filesystem` row looks besides the project, as Main
 * launches the host (`currentDshSkillHomes` in DshHostProcess.ts).
 */
export interface DshSkillHomes {
  /** `<agentDir>`: the row's `customSkillDirs` is `<agentDir>/skills` (decision 101). */
  agentDir: string;
  /** The host's `DSH_HOME`: `<DSH_HOME>/skills`. */
  dshHome: string;
  /** DSH's default `agentsHome`, `~/.agents`: `~/.agents/skills`. */
  agentsHome: string;
}

/**
 * dsh-skill-filesystem's roots, in rank order: the project's two, the custom
 * root, the two user roots. No project roots without a workspace (a temporary
 * chat before it has a directory). No bundled root: the host's environment
 * drops `DSH_BUNDLED_SKILL_DIR` with the rest of the `DSH_` family.
 */
export function dshSkillRoots(homes: DshSkillHomes, projectRoot: string | null): DshSkillRoot[] {
  const roots: DshSkillRoot[] = [];
  if (projectRoot !== null) {
    roots.push(
      { path: join(projectRoot, '.dsh', 'skills'), source: 'project-dsh', rank: 100 },
      { path: join(projectRoot, '.agents', 'skills'), source: 'project-agents', rank: 200 }
    );
  }
  roots.push(
    { path: resolve(homes.agentDir, 'skills'), source: 'custom', rank: 300 },
    {
      path: join(resolve(homes.dshHome), 'skills'),
      source: 'user-dsh',
      rank: 400,
      skipSystem: true,
    },
    { path: join(resolve(homes.agentsHome), 'skills'), source: 'user-agents', rank: 500 }
  );
  return roots;
}

/**
 * DSH's project root: the nearest ancestor of `cwd` holding a `.git` (a
 * directory, or a worktree's file), else `cwd`. Any failure to look reads as
 * "not here", as DSH's own probe does.
 */
export async function dshProjectRoot(source: SkillSource, cwd: string): Promise<string> {
  const start = resolve(cwd);
  let current = start;
  while (true) {
    if (await exists(source, join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function exists(source: SkillSource, path: string): Promise<boolean> {
  try {
    return (await source.stat(path)) !== undefined;
  } catch {
    return false;
  }
}

// ---- frontmatter --------------------------------------------------------------

/** A value kept but not read: a nested block, a flow collection, a tag, an anchor or an alias. */
const UNRESOLVED: unique symbol = Symbol('unresolved');
/** YAML that the `yaml` package's `parse` rejects: DSH ignores the whole file. */
const INVALID: unique symbol = Symbol('invalid');

export type FrontmatterValue = string | number | boolean | null | typeof UNRESOLVED;

/**
 * The `---` block's text, exactly as dsh-skill-filesystem's `parseFrontmatter`
 * cuts it: the first line is `---`, and the block ends at the next line that
 * is `---` (a trailing `\r` allowed on both). Undefined when there is none.
 */
function frontmatterBlock(raw: string): string | undefined {
  const firstLineEnd = raw.indexOf('\n');
  if (firstLineEnd < 0) return undefined;
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined;
  const start = firstLineEnd + 1;
  let lineStart = start;
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart);
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return raw.slice(start, lineStart);
    }
    if (nextNewline < 0) return undefined;
    lineStart = nextNewline + 1;
  }
  return undefined;
}

/**
 * The frontmatter's top-level keys as DSH reads them (`parseFrontmatter`, then
 * the `yaml` package's `parse`), or undefined where DSH ignores the file: no
 * frontmatter, a header that is not a mapping, or YAML `parse` rejects.
 *
 * A subset of YAML, not a parser. It reads the scalars skill headers are
 * written with — plain (one line or folded over several, comments, the core
 * schema's null / bool / number), single- and double-quoted, `|` and `>`
 * blocks — and rejects what `parse` rejects around them: a key twice, a stray
 * line, a `: ` inside a plain value, a value that starts with a reserved
 * character, a block line out of its column, a tab used as indentation.
 * Nested blocks, flow collections, tags, anchors and aliases are kept as
 * `UNRESOLVED`: never a string, so a `name` or `description` written that way
 * leaves the skill out. The tests compare it with DSH's own reading.
 */
export function readDshFrontmatter(text: string): Map<string, FrontmatterValue> | undefined {
  const block = frontmatterBlock(text);
  return block === undefined ? undefined : readTopLevelMapping(block);
}

const BLANK = /^[ \t]*$/;

function leadingSpaces(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

/** A tab before the first character of a content line: `parse` refuses it. */
function tabIndented(line: string): boolean {
  const trimmed = line.trimStart();
  return /^ *\t/.test(line) && trimmed !== '' && !trimmed.startsWith('#');
}

function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/** A line that ends the value above it: anything but blank, at or left of the mapping's column. */
function endsValue(line: string, base: number): boolean {
  return !BLANK.test(line) && leadingSpaces(line) <= base;
}

function readTopLevelMapping(yaml: string): Map<string, FrontmatterValue> | undefined {
  const lines = yaml.split('\n').map((line) => line.replace(/\r$/, ''));
  // The block ends with the newline before the closing `---`.
  if (lines[lines.length - 1] === '') lines.pop();
  const fields = new Map<string, FrontmatterValue>();
  let base: number | undefined;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (isCommentOrBlank(line)) {
      index += 1;
      continue;
    }
    if (tabIndented(line)) return undefined;
    const indent = leadingSpaces(line);
    base ??= indent;
    if (indent !== base) return undefined;
    const entry = readKey(line.slice(indent));
    if (!entry || fields.has(entry.key)) return undefined;
    const read = readEntryValue(entry.rest, lines, index, base);
    if (read.value === INVALID) return undefined;
    fields.set(entry.key, read.value);
    index = read.next;
  }
  // No key at all: `parse` answers null, which DSH treats as no frontmatter.
  return base === undefined ? undefined : fields;
}

/**
 * `key:` and what follows it on the line. Undefined for a line that is not a
 * mapping entry `parse` reads the same way: a sequence item, a complex or flow
 * key, a key that starts with a reserved character, or no `:` separator.
 */
function readKey(text: string): { key: string; rest: string } | undefined {
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const scalar = readQuoted(text, [], quote);
    if (scalar.value === INVALID || typeof scalar.value !== 'string') return undefined;
    const after = /^[ \t]*:(?:[ \t]+(.*)|$)/.exec(text.slice(scalar.endColumn));
    return after ? { key: scalar.value, rest: (after[1] ?? '').trimEnd() } : undefined;
  }
  if (/^[,[\]{}#&*!|>%@`]/.test(text) || /^[-?:](?:[ \t]|$)/.test(text)) return undefined;
  const match = /^(.*?)[ \t]*:(?:[ \t]+(.*)|$)/.exec(text);
  if (!match || /[ \t]#/.test(match[1] ?? '')) return undefined;
  return { key: match[1] ?? '', rest: (match[2] ?? '').trimEnd() };
}

interface ReadValue {
  value: FrontmatterValue | typeof INVALID;
  /** The index of the line after this entry. */
  next: number;
}

function readEntryValue(head: string, lines: string[], index: number, base: number): ReadValue {
  const below = head === '' || head.startsWith('#');
  // The lines that belong to this entry: up to the next line at the key's
  // column — save the items of a sequence written at that column, which YAML
  // lets a value below its key start (`allowed-tools:` then `- Read`).
  let end = index + 1;
  while (end < lines.length) {
    const line = lines[end] as string;
    const sequenceItem =
      below && leadingSpaces(line) === base && /^-(?:[ \t]|$)/.test(line.slice(base));
    if (endsValue(line, base) && !sequenceItem) break;
    end += 1;
  }
  const block = lines.slice(index + 1, end);
  const first = head[0];
  if (below) return { value: readValueBelow(block), next: end };
  if (first === '[' || first === '{') return readFlow(head, lines, index);
  let value: FrontmatterValue | typeof INVALID;
  if (first === '|' || first === '>') value = readBlockScalar(head, block, base);
  else if (first === '"' || first === "'") value = readQuotedValue(head, block, first);
  else if (first === '&' || first === '!' || first === '*') value = UNRESOLVED;
  else if (/^[,\]}@`%]/.test(head) || /^[-?:](?:[ \t]|$)/.test(head)) value = INVALID;
  else value = readPlain(head, block);
  return { value, next: end };
}

/** `key:` with the value on the lines below: nothing, a nested block, or a scalar. */
function readValueBelow(block: string[]): FrontmatterValue | typeof INVALID {
  const at = block.findIndex((line) => !isCommentOrBlank(line));
  if (at < 0) return null;
  const line = block[at] as string;
  if (tabIndented(line)) return INVALID;
  const text = line.trim();
  if (/^-(?:[ \t]|$)/.test(text) || readKey(text) !== undefined) return UNRESOLVED;
  const rest = block.slice(at + 1);
  const first = text[0];
  if (first === '"' || first === "'") return readQuotedValue(text, rest, first);
  if (/^[[{|>&!*]/.test(text)) return UNRESOLVED;
  if (/^[,\]}@`%]/.test(text) || /^[?:](?:[ \t]|$)/.test(text)) return INVALID;
  return readPlain(text, rest);
}

/** Cut a ` #comment` (or a whole-line comment) off a plain value's line. */
function stripComment(text: string): { text: string; comment: boolean } {
  const at = text.search(/(?:^|[ \t])#/);
  return at < 0 ? { text, comment: false } : { text: text.slice(0, at), comment: true };
}

/** YAML folding of a flow scalar's lines: one break is a space, each blank line a newline. */
function foldLines(parts: readonly string[]): string {
  let out = '';
  let breaks = 0;
  let started = false;
  for (const part of parts) {
    if (part === '') {
      if (started) breaks += 1;
      continue;
    }
    if (started) out += breaks > 0 ? '\n'.repeat(breaks) : ' ';
    out += part;
    breaks = 0;
    started = true;
  }
  return out;
}

/** A plain scalar: the head and its continuation lines, folded, then typed. */
function readPlain(head: string, rest: readonly string[]): FrontmatterValue | typeof INVALID {
  const parts: string[] = [];
  let closed = false;
  for (const [position, raw] of [head, ...rest].entries()) {
    if (position > 0 && tabIndented(raw)) return INVALID;
    const trimmed = raw.trim();
    if (trimmed === '') {
      parts.push('');
      continue;
    }
    // A comment ends a plain value; anything after it is a stray line.
    if (closed) return INVALID;
    const { text, comment } = stripComment(trimmed);
    if (/:(?:[ \t]|$)/.test(text)) return INVALID;
    if (text.trim() !== '') parts.push(text.trim());
    closed = comment;
  }
  return resolvePlain(foldLines(parts));
}

/** The core schema's reading of an unquoted scalar, as `parse` applies it. */
function resolvePlain(value: string): string | number | boolean | null {
  if (/^(?:~|null|Null|NULL)?$/.test(value)) return null;
  if (/^(?:true|True|TRUE)$/.test(value)) return true;
  if (/^(?:false|False|FALSE)$/.test(value)) return false;
  if (/^0o[0-7]+$/.test(value)) return Number.parseInt(value.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(value)) return Number.parseInt(value.slice(2), 16);
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(value)) {
    return Number(value);
  }
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(value)) {
    return value.startsWith('-') ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (/^\.(?:nan|NaN|NAN)$/.test(value)) return Number.NaN;
  return value;
}

const DOUBLE_QUOTED_ESCAPES: Readonly<Record<string, string>> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\u0085',
  _: ' ',
  L: ' ',
  P: ' ',
};

/**
 * A quoted scalar that starts at `head` and may run on over `rest`: its value
 * and the column after its closing quote on the line where it closes. The
 * lines are folded the way `parse` folds them; `\` escapes (double quotes)
 * and `''` (single quotes) are undone.
 */
function readQuoted(
  head: string,
  rest: readonly string[],
  quote: '"' | "'"
): { value: string | typeof INVALID; endColumn: number; endLine: number } {
  const lines = [head, ...rest];
  const parts: string[] = [];
  let current = '';
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] as string;
    // Past the opening quote; on a continuation line, past its leading white space.
    let column = lineIndex === 0 ? 1 : line.length - line.trimStart().length;
    let joined = false;
    while (column < line.length) {
      const char = line[column] as string;
      if (char === quote) {
        if (quote === "'" && line[column + 1] === "'") {
          current += "'";
          column += 2;
          continue;
        }
        parts.push(current);
        return { value: foldQuoted(parts), endColumn: column + 1, endLine: lineIndex };
      }
      if (quote === '"' && char === '\\') {
        const next = line[column + 1];
        if (next === undefined) {
          // An escaped line break: the lines join with nothing between them.
          joined = true;
          break;
        }
        const hex = next === 'x' ? 2 : next === 'u' ? 4 : next === 'U' ? 8 : 0;
        if (hex > 0) {
          const digits = line.slice(column + 2, column + 2 + hex);
          if (!new RegExp(`^[0-9a-fA-F]{${hex}}$`).test(digits)) {
            return { value: INVALID, endColumn: 0, endLine: lineIndex };
          }
          current += String.fromCodePoint(Number.parseInt(digits, 16));
          column += 2 + hex;
          continue;
        }
        const escaped = DOUBLE_QUOTED_ESCAPES[next];
        if (escaped === undefined) return { value: INVALID, endColumn: 0, endLine: lineIndex };
        current += escaped;
        column += 2;
        continue;
      }
      current += char;
      column += 1;
    }
    if (joined) continue;
    // An unescaped line break: trailing white space before it goes.
    parts.push(current.replace(/[ \t]+$/, ''));
    current = '';
  }
  return { value: INVALID, endColumn: 0, endLine: lines.length - 1 };
}

/** Folding inside quotes: like a plain scalar's, but the first and last pieces may be empty. */
function foldQuoted(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0] as string;
  let out = parts[0] as string;
  let breaks = 0;
  for (const part of parts.slice(1, -1)) {
    if (part === '') {
      breaks += 1;
      continue;
    }
    out += breaks > 0 ? '\n'.repeat(breaks) : ' ';
    out += part;
    breaks = 0;
  }
  const last = parts[parts.length - 1] as string;
  out += breaks > 0 ? '\n'.repeat(breaks) : ' ';
  return out + last;
}

/** A quoted value: the scalar, then nothing but a comment on its line and blank lines after it. */
function readQuotedValue(
  head: string,
  rest: readonly string[],
  quote: '"' | "'"
): string | typeof INVALID {
  const scalar = readQuoted(head, rest, quote);
  if (scalar.value === INVALID) return INVALID;
  const lines = [head, ...rest];
  const tail = (lines[scalar.endLine] as string).slice(scalar.endColumn);
  if (!/^(?:[ \t]+#.*|[ \t]*)$/.test(tail)) return INVALID;
  for (const line of lines.slice(scalar.endLine + 1)) {
    if (!isCommentOrBlank(line)) return INVALID;
  }
  return scalar.value;
}

/** A `|` or `>` block: its lines below the key, at the block's own column. */
function readBlockScalar(
  head: string,
  block: readonly string[],
  base: number
): string | typeof INVALID {
  const header = /^([|>])(?:([1-9])([+-])?|([+-])([1-9])?)?(?:[ \t]+#.*|[ \t]*)$/.exec(head);
  if (!header) return INVALID;
  const folded = header[1] === '>';
  const explicit = header[2] ?? header[5];
  const chomping = header[3] ?? header[4] ?? '';
  const firstContent = block.find((line) => !BLANK.test(line));
  const column =
    explicit !== undefined
      ? base + Number(explicit)
      : firstContent !== undefined
        ? leadingSpaces(firstContent)
        : base + 1;
  const texts: string[] = [];
  for (const line of block) {
    if (BLANK.test(line)) {
      texts.push('');
      continue;
    }
    if (leadingSpaces(line) < column) return INVALID;
    texts.push(line.slice(column));
  }
  let trailing = 0;
  while (trailing < texts.length && texts[texts.length - 1 - trailing] === '') trailing += 1;
  const body = texts.slice(0, texts.length - trailing);
  let content = folded ? foldBlock(body) : body.join('\n');
  if (chomping === '+') content += '\n'.repeat(trailing + (body.length > 0 ? 1 : 0));
  else if (chomping === '' && body.length > 0) content += '\n';
  return content;
}

/** `>` folding: lines join with a space, a blank line is a newline, more-indented lines stay. */
function foldBlock(lines: readonly string[]): string {
  let out = '';
  let previous: 'none' | 'text' | 'kept' = 'none';
  let breaks = 0;
  for (const line of lines) {
    if (line === '') {
      breaks += 1;
      continue;
    }
    const kept = /^[ \t]/.test(line);
    if (previous !== 'none') {
      if (kept || previous === 'kept') out += '\n'.repeat(breaks + 1);
      else out += breaks > 0 ? '\n'.repeat(breaks) : ' ';
    }
    out += line;
    previous = kept ? 'kept' : 'text';
    breaks = 0;
  }
  return out;
}

/** A flow collection: kept unread, its brackets followed across lines to where it closes. */
function readFlow(head: string, lines: readonly string[], index: number): ReadValue {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let lineIndex = index; lineIndex < lines.length; lineIndex += 1) {
    const text = lineIndex === index ? head : (lines[lineIndex] as string);
    for (let column = 0; column < text.length; column += 1) {
      const char = text[column] as string;
      if (quote) {
        if (quote === '"' && char === '\\') column += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === '[' || char === '{') depth += 1;
      else if (char === ']' || char === '}') {
        depth -= 1;
        if (depth === 0) {
          const tail = text.slice(column + 1);
          return {
            value: /^(?:[ \t]+#.*|[ \t]*)$/.test(tail) ? UNRESOLVED : INVALID,
            next: lineIndex + 1,
          };
        }
      } else if (char === '#' && (column === 0 || /[ \t]/.test(text[column - 1] as string))) {
        break;
      }
    }
  }
  return { value: INVALID, next: lines.length };
}

// ---- a skill's header -----------------------------------------------------------

export interface DshSkillHeader {
  name: string;
  description: string;
  /** `disable-model-invocation` is not true. */
  modelInvocable: boolean;
  /** `user-invocable` is not false: the menu offers it, and `/name` runs it. */
  userInvocable: boolean;
}

/**
 * dsh-skill-filesystem's `frontmatterBoolean`: YAML booleans, `1` / `0`, and
 * the case-insensitive words; anything else drops the skill.
 */
function frontmatterBoolean(
  fields: ReadonlyMap<string, FrontmatterValue>,
  key: string
): boolean | undefined | typeof INVALID {
  if (!fields.has(key)) return undefined;
  const value = fields.get(key);
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true;
      case 'false':
      case 'no':
      case 'off':
        return false;
    }
  }
  return INVALID;
}

/**
 * The skill a header declares, by dsh-skill-filesystem's `parseSkillFile`:
 * `name` and `description` non-empty strings, the name kebab-case, the two
 * invocation keys strict booleans and their camel-case spellings absent.
 * Undefined where DSH skips the file.
 */
export function dshSkillHeader(
  fields: ReadonlyMap<string, FrontmatterValue> | undefined
): DshSkillHeader | undefined {
  if (!fields) return undefined;
  const name = fields.get('name');
  const description = fields.get('description');
  if (typeof name !== 'string' || name.length === 0) return undefined;
  if (typeof description !== 'string' || description.length === 0) return undefined;
  if (!DSH_SKILL_NAME.test(name)) return undefined;
  if (LEGACY_INVOCATION_KEYS.some((key) => fields.has(key))) return undefined;
  const disableModel = frontmatterBoolean(fields, 'disable-model-invocation');
  const userInvocable = frontmatterBoolean(fields, 'user-invocable');
  if (disableModel === INVALID || userInvocable === INVALID) return undefined;
  return {
    name,
    description,
    modelInvocable: disableModel !== true,
    userInvocable: userInvocable !== false,
  };
}

// ---- discovery ------------------------------------------------------------------

export interface DshSkillCandidate extends DshSkillHeader {
  source: DshSkillRootSource;
  rank: number;
  /** The instruction file: `<root>/<entry>/SKILL.md` or `<root>/<entry>.md`. */
  path: string;
}

/**
 * One root, as dsh-skill-filesystem's `discoverRoot` walks it: its direct
 * entries in `localeCompare` order, a directory as `<entry>/SKILL.md`, a file
 * ending `.md` as itself, a symbolic link as what it points at. Nothing
 * deeper. A missing root holds nothing.
 */
export async function discoverDshSkillRoot(
  source: SkillSource,
  root: DshSkillRoot
): Promise<DshSkillCandidate[]> {
  const entries = (await source.list(root.path)) ?? [];
  const found: DshSkillCandidate[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (root.skipSystem && entry.name === '.system') continue;
    const entryPath = join(root.path, entry.name);
    const kind = entry.kind === 'symlink' ? await followedKind(source, entryPath) : entry.kind;
    const file =
      kind === 'directory'
        ? join(entryPath, 'SKILL.md')
        : kind === 'file' && entry.name.endsWith('.md')
          ? entryPath
          : undefined;
    if (file === undefined) continue;
    const text = await source.readText(file);
    if (text === undefined) continue;
    const header = dshSkillHeader(readDshFrontmatter(text));
    if (header) found.push({ ...header, source: root.source, rank: root.rank, path: file });
  }
  return found;
}

async function followedKind(source: SkillSource, path: string): Promise<SkillFileKind | undefined> {
  try {
    return (await source.stat(path))?.kind;
  } catch {
    // DSH skips a link it cannot follow.
    return undefined;
  }
}

/**
 * The menu rows of the skills DSH would offer in `workspacePath` (none of the
 * project's for `null`): every root in rank order, the first of two
 * same-named skills winning (`@deepseek-ai/dsh-skill`), the user-invocable
 * ones, by name — each shaped as `slashCommandRows` shapes it.
 *
 * Any unexpected read failure rejects, the way a provider's failed discovery
 * costs every skill that provider had.
 */
export async function listDshUserSkills(
  source: SkillSource,
  homes: DshSkillHomes,
  workspacePath: string | null
): Promise<WorkerSlashCommandInfo[]> {
  const projectRoot = workspacePath === null ? null : await dshProjectRoot(source, workspacePath);
  const winners = new Map<string, DshSkillCandidate>();
  for (const root of dshSkillRoots(homes, projectRoot)) {
    for (const candidate of await discoverDshSkillRoot(source, root)) {
      if (!winners.has(candidate.name)) winners.set(candidate.name, candidate);
    }
  }
  return [...winners.values()]
    .filter((skill) => skill.userInvocable)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: SKILL_SOURCE,
      path: skill.path,
      scope: skill.source,
    }));
}

/** `listDshUserSkills` on this machine's disk, reading only as far as each header. */
export function listDshSkillsFromDisk(
  workspacePath: string | null,
  homes: DshSkillHomes
): Promise<WorkerSlashCommandInfo[]> {
  return listDshUserSkills(
    skillSource(nodeLegacyAssetFiles(), MAX_SCAN_BYTES),
    homes,
    workspacePath
  );
}

// ---- the menu -------------------------------------------------------------------

/**
 * The menu before a session is up: the host-wide command rows a worker gave,
 * then the workspace's skills — less any a command or the window's `/compact`
 * already names, as `slashCommandRows` leaves them out, since a `/name` at the
 * start of a line runs the command, never the skill. Capped the same way.
 */
export function preStartSlashRows(
  commands: readonly WorkerSlashCommandInfo[],
  skills: readonly WorkerSlashCommandInfo[]
): WorkerCommandsResult {
  const taken = new Set<string>([
    ...WINDOW_OWNED_COMMAND_NAMES,
    ...commands.map((row) => row.name),
  ]);
  const rows = [...commands, ...skills.filter((skill) => !taken.has(skill.name))];
  return {
    commands: rows.slice(0, WORKER_COMMAND_INVENTORY_MAX),
    truncated: rows.length > WORKER_COMMAND_INVENTORY_MAX,
  };
}

export interface ComposerSlashCommandsDeps {
  workers: {
    getSlashCommands(input: {
      sessionId?: string;
      workspacePath?: string | null;
      engine?: ChatEngine;
    }): Promise<WorkerSlashCommandsAnswer>;
  };
  /**
   * Decision 194: the DSH host's own listing for a folder no session runs in
   * (`DshHostSupervisor.listSlashCommands`): its commands and every skill, a
   * plugin's included. Rejects when no host is ready.
   */
  dshHost?: { listSlashCommands(cwd: string | null): Promise<WorkerCommandsResult> };
  /**
   * Decision 194 Q1: the Agent SDK CLI's own list for a folder no SDK chat runs in
   * (`ClaudeSdkCommandCatalog`); never rejects.
   */
  sdkCatalog?: { list(cwd: string | null): Promise<WorkerCommandsResult> };
  /** The workspace's skills from disk (`listDshSkillsFromDisk`), when the host cannot answer. */
  listSkills(workspacePath: string | null): Promise<WorkerSlashCommandInfo[]>;
  log?: (message: string, error: unknown) => void;
}

/**
 * `chat:getSlashCommands`: a worker of the chat (or, for DSH, of its workspace)
 * answers when one is up. Otherwise, for DSH, the host lists the folder's
 * commands and skills (decision 194), and when it cannot, the skills are read
 * from disk (decision 175). For a Claude Agent SDK chat that is not up, a
 * catalog CLI lists the folder (decision 194 Q1); DSH's skill roots are never
 * the CLI's.
 */
export async function composerSlashCommands(
  input: { sessionId?: string; workspacePath: string | null; engine?: ChatEngine },
  deps: ComposerSlashCommandsDeps
): Promise<WorkerCommandsResult> {
  const answer = await deps.workers.getSlashCommands(input);
  if (answer.origin !== 'none') return { commands: answer.commands, truncated: answer.truncated };
  if (answer.engine !== 'dsh') {
    return deps.sdkCatalog
      ? deps.sdkCatalog.list(answer.workspacePath)
      : { commands: [], truncated: false };
  }
  if (deps.dshHost) {
    try {
      const listed = await deps.dshHost.listSlashCommands(answer.workspacePath);
      if (isWorkerCommandsResult(listed)) {
        return {
          commands: sanitizeWorkerCommandRows(listed.commands),
          truncated: listed.truncated === true,
        };
      }
    } catch (error) {
      deps.log?.(
        '[slash-menu] the DSH host could not list the menu; reading skills from disk',
        error
      );
    }
  }
  let skills: WorkerSlashCommandInfo[] = [];
  try {
    skills = await deps.listSkills(answer.workspacePath);
  } catch (error) {
    // As a DSH provider whose discovery failed: no skills, the menu stands.
    deps.log?.('[slash-menu] the workspace skills could not be read from disk', error);
  }
  return preStartSlashRows(answer.commands, skills);
}
