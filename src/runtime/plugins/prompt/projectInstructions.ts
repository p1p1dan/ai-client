/**
 * P2-2 — the project instruction chain that fills the `project-instructions`
 * prompt slot.
 *
 * Provenance (AGENTS.md requires stating it): **adapted** from PI-Desktop's
 * `packages/agent-runtime/src/project-instructions.ts` and
 * `project-instructions-prompt.ts`. The file-name list, the 32 KiB shared
 * budget, the root→leaf walk, the "nested files get the last word" order and
 * the symlink containment guard are theirs and are kept as-is. Three things
 * differ, each noted at the point it appears: global files are a list rather
 * than one hardcoded path, reading goes through a port instead of `node:fs`,
 * and the assembled block is returned as a prompt segment rather than a string.
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

import { dirname, join, relative, resolve, sep } from 'node:path';
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
   * File the work is about, if any. Its directory chain is walked so that
   * instructions closer to it are collected; absent means the root only.
   */
  targetPath?: string;
  /**
   * Global instruction files, in the order they should appear, before any
   * project file. A list rather than PI-Desktop's single `~/.pi/agent/AGENTS.md`
   * because this product can run against a managed agent dir while also
   * borrowing the user's own (`src/agent-host/userResourcePaths.ts:93`), which
   * is two files, and neither this module nor its tests should know where
   * either lives.
   */
  globals?: readonly { path: string; label: string }[];
  maxBytes?: number;
}

function isWithinRoot(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
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

/**
 * The directories to consult, root first and the target's own directory last.
 *
 * Order is the precedence rule: later entries end up later in the prompt, and
 * the block tells the model that later entries win. `undefined` means the
 * target escapes the root, which is not a chain to be trimmed but a request to
 * refuse.
 */
export function instructionDirectories(
  root: string,
  targetPath?: string
): readonly string[] | undefined {
  const resolvedRoot = resolve(root);
  const target = targetPath?.trim() ? resolve(resolvedRoot, targetPath) : resolvedRoot;
  if (!isWithinRoot(resolvedRoot, target)) return undefined;

  const directories: string[] = [];
  for (
    let current = targetPath?.trim() ? dirname(target) : resolvedRoot;
    ;
    current = dirname(current)
  ) {
    if (!isWithinRoot(resolvedRoot, current)) return undefined;
    directories.unshift(current);
    if (current === resolvedRoot) break;
  }
  return directories;
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
 * Load globals then the project chain, sharing one byte budget.
 *
 * Globals go first so a project file, being later, can contradict them — the
 * same reason nested files come after their parents.
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

  if (!options.root) return entries;
  const directories = instructionDirectories(options.root, options.targetPath);
  if (!directories) return entries;
  const resolvedRoot = resolve(options.root);
  const canonicalRoot = (await source.realpath(resolvedRoot)) ?? resolvedRoot;
  for (const directory of directories) {
    if (remaining <= 0) break;
    const entry = await readDirectoryInstruction(
      source,
      resolvedRoot,
      canonicalRoot,
      directory,
      remaining
    );
    if (!entry?.content) continue;
    entries.push(entry);
    remaining -= Buffer.byteLength(entry.content, 'utf8');
  }
  return entries;
}

/**
 * Render the chain for the `project-instructions` slot.
 *
 * The precedence sentence is PI-Desktop's, kept because it is the only thing
 * telling the model how to resolve two instructions that contradict each other,
 * and the order it describes is the order this module produces.
 */
export function projectInstructionsSegment(
  entries: readonly ProjectInstruction[]
): PromptSegment | undefined {
  if (entries.length === 0) return undefined;
  const text = [
    '# Project instructions',
    '',
    'The following instructions are loaded from the workspace. Follow them when they apply to the task; entries later in this section are closer to the file being worked on and take precedence.',
    '',
    ...entries.flatMap((entry) => [`## ${entry.source}`, '', entry.content, '']),
  ]
    .join('\n')
    .trimEnd();
  return { slot: 'project-instructions', text };
}
