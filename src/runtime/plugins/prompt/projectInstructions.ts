/**
 * P2-2 — the project instruction chain that fills the `project-instructions`
 * prompt slot.
 *
 * Provenance (AGENTS.md requires stating it): **adapted** from PI-Desktop's
 * `packages/agent-runtime/src/project-instructions.ts` and
 * `project-instructions-prompt.ts`. The file-name list, the 32 KiB shared
 * budget and the symlink containment guard are theirs and are kept as-is. Four
 * things differ, each noted at the point it appears: global files are a list
 * rather than one hardcoded path, reading goes through a port instead of
 * `node:fs`, the assembled block is returned as a prompt segment rather than a
 * string, and only the workspace root's own file is loaded.
 *
 * ## Why there is no directory walk (decision 007)
 *
 * The reference walks root→leaf from a `targetPath` the caller supplies, and
 * this module was ported with that walk intact. No caller ever supplied one:
 * the parameter reached `RuntimeRunRequest` and stopped there, in this product
 * and in the reference alike (context-prompt-03). Decision 007 removed it
 * rather than wiring it, because the tier rule it half-implemented is not the
 * official one either — the official rule loads the workspace root and every
 * parent directory at session start, and subdirectories on demand as the agent
 * reads into them. T035 implements that; until it lands this module loads the
 * workspace root only, which is what the product has always actually done.
 *
 * ## Why reading is a port
 *
 * ARD D11: every runtime file read goes through `runtimeHostIo`, because the
 * encrypted Windows target serves plaintext per process and a module that
 * calls `node:fs` directly is the per-module compatibility patch D11 exists to
 * prevent. That service is P1-0's, so this module declares the two operations
 * it needs ({@link InstructionSource}) and P2-2's wiring step adapts
 * `runtimeHostIo` to them. The pure consequence is a happy accident: the whole
 * chain is testable against an in-memory source, with no fixture tree on disk.
 */

import { isAbsolute, join, relative, resolve } from 'node:path';
import type { PromptSegment } from './segments.ts';

/**
 * Per directory, the first name that exists wins. `AGENTS.override.md` first so
 * a checked-in `AGENTS.md` can be overridden locally without editing it;
 * `CLAUDE.md` and `.claude/CLAUDE.md` because this product's users keep both
 * conventions (this repo's own root has a `CLAUDE.md`).
 */
export const INSTRUCTION_FILE_NAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'CLAUDE.md',
  join('.claude', 'CLAUDE.md'),
] as const;

/**
 * Total budget across the whole chain, globals included.
 *
 * Shared rather than per-file on purpose: the chain is what lands in the
 * prompt, so a single 500 KiB AGENTS.md must not be able to push everything
 * else out — or, worse, quietly eat the context window the conversation needs.
 */
export const MAX_INSTRUCTION_BYTES = 32 * 1024;

export interface ProjectInstruction {
  /** What the prompt shows as the heading — a workspace-relative path or a label. */
  source: string;
  content: string;
}

/**
 * The file access this module needs, and nothing more.
 *
 * Both operations answer `undefined` instead of throwing for the expected
 * absences (no such file, unreadable, a broken link): a missing AGENTS.md is
 * the normal case, not an error worth unwinding a prompt build for.
 */
export interface InstructionSource {
  readText(path: string): Promise<string | undefined>;
  /** Resolved real path, for the containment guard. `undefined` when it cannot be resolved. */
  realpath(path: string): Promise<string | undefined>;
}

export interface InstructionChainOptions {
  /** Workspace root. Absent loads only explicitly supplied global files. */
  root?: string;
  /**
   * Global instruction files, in the order they should appear, before any
   * project file. A LIST rather than PI-Desktop's single
   * `~/.pi/agent/AGENTS.md`: the agent dir's own file is one source, and a
   * caller may supply others. Neither this module nor its tests should know
   * where any of them live.
   *
   * (It used to name H/17's borrow mechanism as the second source. That is
   * gone — H/19 copies the user's `AGENTS.md` in rather than reading it
   * through — but the list shape is still the right one.)
   */
  globals?: readonly { path: string; label: string }[];
  maxBytes?: number;
}

/**
 * Containment, by relative path rather than string prefix.
 *
 * context-prompt-13: `path.startsWith(root + sep)` cannot be true when `root`
 * already ends in a separator, which is what `resolve` returns for a filesystem
 * root (`/`, `C:\`). A workspace opened at one of those had its whole
 * instruction chain silently vanish — including the symlink guard's verdict on
 * a file that was in fact contained. `relative` handles both shapes, and
 * answers `''` for the root itself.
 */
function isWithinRoot(root: string, path: string): boolean {
  if (path === root) return true;
  const offset = relative(root, path);
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset);
}

/** Windows separators normalized so a recorded source path reads the same everywhere. */
function normalizeStablePath(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Truncate to a byte budget without splitting a character.
 *
 * Byte-wise truncation of UTF-8 can end mid-sequence and produce a replacement
 * character in the prompt; iterating by code point costs nothing at these sizes
 * and cannot.
 */
export function limitUtf8(content: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  let bytes = 0;
  let end = 0;
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return content.slice(0, end);
}

async function readDirectoryInstruction(
  source: InstructionSource,
  root: string,
  canonicalRoot: string,
  directory: string,
  remaining: number
): Promise<ProjectInstruction | undefined> {
  for (const name of INSTRUCTION_FILE_NAMES) {
    const file = join(directory, name);
    // A symlink pointing out of the workspace would otherwise pull arbitrary
    // files into the prompt, so containment is checked on the resolved path.
    const canonical = await source.realpath(file);
    if (!canonical || !isWithinRoot(canonicalRoot, canonical)) continue;
    const content = (await source.readText(file))?.trim();
    if (!content) continue;
    return {
      source: normalizeStablePath(relative(root, file) || name),
      content: limitUtf8(content, remaining),
    };
  }
  return undefined;
}

/**
 * Load globals then the workspace root's own file, sharing one byte budget.
 *
 * Globals go first so a project file, being later, can contradict them.
 */
export async function loadInstructionChain(
  source: InstructionSource,
  options: InstructionChainOptions
): Promise<readonly ProjectInstruction[]> {
  let remaining = Math.max(0, options.maxBytes ?? MAX_INSTRUCTION_BYTES);
  const entries: ProjectInstruction[] = [];

  for (const global of options.globals ?? []) {
    if (remaining <= 0) break;
    const content = (await source.readText(global.path))?.trim();
    if (!content) continue;
    const limited = limitUtf8(content, remaining);
    if (!limited) continue;
    entries.push({ source: global.label, content: limited });
    remaining -= Buffer.byteLength(limited, 'utf8');
  }

  if (!options.root || remaining <= 0) return entries;
  const resolvedRoot = resolve(options.root);
  const canonicalRoot = (await source.realpath(resolvedRoot)) ?? resolvedRoot;
  const entry = await readDirectoryInstruction(
    source,
    resolvedRoot,
    canonicalRoot,
    resolvedRoot,
    remaining
  );
  if (entry?.content) entries.push(entry);
  return entries;
}

/**
 * The rendered chain as plain text, for a consumer that is not building the
 * parent's prompt.
 *
 * P5-2-2's delegates need the workspace's own rules, but not the slot machinery
 * around them: a delegate's prompt is assembled by
 * `plugins/subagent/prompt.ts`, not by `composeSystemPrompt`. Sharing the
 * loader and the rendering — rather than re-deriving the chain there — is what
 * keeps a delegate reading the same instructions the parent does.
 */
export async function projectInstructionsText(
  source: InstructionSource,
  options: InstructionChainOptions
): Promise<string | undefined> {
  const entries = await loadInstructionChain(source, options);
  return projectInstructionsSegment(entries)?.text;
}

export function projectInstructionsSegment(
  entries: readonly ProjectInstruction[]
): PromptSegment | undefined {
  if (entries.length === 0) return undefined;
  const text = [
    '# Project instructions',
    '',
    'The following instructions are loaded from the workspace. Follow them when they apply to the task; where two entries conflict, the more specific file says so itself.',
    '',
    ...entries.flatMap((entry) => [`## ${entry.source}`, '', entry.content, '']),
  ]
    .join('\n')
    .trimEnd();
  return { slot: 'project-instructions', text };
}
