/**
 * decision 007 — the on-demand half of the instruction tiers.
 *
 * At session start `loadInstructionChain` loads the workspace and every parent.
 * The subtree BELOW the workspace is not loaded then, because a repository with
 * two hundred package directories would put two hundred files in the system
 * prompt for a session that touches three of them. Instead each subdirectory's
 * file is loaded the first time a tool actually reads, edits, writes or greps a
 * file inside it, and reaches the model as a message.
 *
 * ## Why a message and not the system prompt
 *
 * The system prompt is rebuilt per run and is the cache prefix for every
 * request in it. Appending to it mid-run would invalidate that prefix on the
 * very next turn, and a file discovered in run 3 would have to be re-derived in
 * every later run to stay there. A message is written once, rides the
 * transcript into the session file, and survives a reopen for free. It carries
 * the T005 internal mark so it is not mistaken for something the user typed.
 *
 * ## Why the state is a plain Set and is not persisted
 *
 * "Each file at most once per session" is the whole rule, and a session is one
 * runtime instance. A reopened session re-derives nothing: the messages from
 * the previous life are still in the transcript, and if a directory is touched
 * again the file is simply injected once more. Persisting the set would add a
 * migration and a staleness question to buy nothing.
 */

import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  type InstructionSource,
  instructionDirectories,
  MAX_INSTRUCTION_BYTES,
  type ProjectInstruction,
  readDirectoryInstructions,
} from './projectInstructions.ts';

export interface InstructionTrackerOptions {
  source: InstructionSource;
  /** Workspace root. Directories at or above it are already in the prompt. */
  root: string;
  /** decision 008 — off when `project` is not an enabled setting source. */
  enabled: boolean;
  /** decision 008 — whether `CLAUDE.local.md` counts. */
  local: boolean;
  /**
   * Budget for everything this tracker will ever inject, across the whole
   * session. Separate from the prompt chain's budget rather than shared with
   * it: the prompt chain is rebuilt per run and spends its budget fresh each
   * time, while these entries accumulate in the transcript and would otherwise
   * have no ceiling at all.
   */
  maxBytes?: number;
}

export class InstructionTracker {
  private readonly options: InstructionTrackerOptions;
  private readonly loaded = new Set<string>();
  private pending: ProjectInstruction[] = [];
  private remaining: number;

  constructor(options: InstructionTrackerOptions) {
    this.options = options;
    this.remaining = Math.max(0, options.maxBytes ?? MAX_INSTRUCTION_BYTES);
    // The startup chain is marked loaded up front rather than reported back by
    // the prompt plugin. Two reasons: it is the same `instructionDirectories`
    // walk, so there is nothing to disagree about, and a directory the budget
    // cut short at startup must not then be injected as a message — the user
    // asked for one instruction block, not two halves of one.
    for (const directory of instructionDirectories(options.root)) this.loaded.add(directory);
  }

  /**
   * Record that a tool touched these files, loading any instruction file that
   * newly came into scope.
   *
   * Never throws: a tool call must not fail because an AGENTS.md next to the
   * file it read was unreadable. The per-file reads already answer `undefined`
   * for the expected absences; this catch covers the rest.
   */
  async note(paths: readonly string[]): Promise<void> {
    if (!this.options.enabled || this.remaining <= 0) return;
    for (const directory of this.newDirectories(paths)) {
      this.loaded.add(directory);
      if (this.remaining <= 0) continue;
      let found: readonly ProjectInstruction[] = [];
      try {
        found = await readDirectoryInstructions(this.options.source, {
          labelRoot: this.options.root,
          directory,
          remaining: this.remaining,
          local: this.options.local,
        });
      } catch {
        continue;
      }
      for (const entry of found) {
        this.pending.push(entry);
        this.remaining -= Buffer.byteLength(entry.content, 'utf8');
      }
    }
  }

  /** Entries loaded since the last call, in least-specific-first order. */
  take(): readonly ProjectInstruction[] {
    if (this.pending.length === 0) return [];
    const entries = this.pending;
    this.pending = [];
    return entries;
  }

  /**
   * Directories between the workspace root (exclusive) and each touched file's
   * own directory (inclusive) that have not been loaded yet, outermost first.
   *
   * Outermost first so a single tool call that reaches deep into the tree
   * produces the same order the startup chain uses. Paths outside the workspace
   * contribute nothing: a file the model read in `/etc` is not a project whose
   * instructions this session agreed to follow.
   */
  private newDirectories(paths: readonly string[]): readonly string[] {
    const root = this.options.root;
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const path of paths) {
      const directory = dirname(resolve(path));
      if (!within(root, directory)) continue;
      const chain: string[] = [];
      let walk = directory;
      while (walk !== root && within(root, walk)) {
        if (this.loaded.has(walk) || seen.has(walk)) break;
        chain.push(walk);
        const parent = dirname(walk);
        if (parent === walk) break;
        walk = parent;
      }
      for (const entry of chain.reverse()) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        ordered.push(entry);
      }
    }
    return ordered;
  }
}

/** Strictly inside `root`, or `root` itself. Same shape as the prompt chain's guard. */
function within(root: string, path: string): boolean {
  if (path === root) return true;
  const offset = relative(root, path);
  return offset !== '' && !offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset);
}
