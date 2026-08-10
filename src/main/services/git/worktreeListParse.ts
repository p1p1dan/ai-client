import type { GitWorktree } from '@shared/types';

/**
 * Parser for `git worktree list --porcelain`, split out of `WorktreeService`
 * so it is unit-testable: `WorktreeService` reaches `simple-git` through
 * `./runtime`, which pulls in `PtyManager` (node-pty, a native binding) and
 * cannot be imported from a vitest node-environment test.
 *
 * Pure by construction — it reports what it saw instead of logging, and the
 * caller decides what to do with that (same split as the renderer's
 * `deriveChatWorkspaceTree` diagnostics).
 */

/**
 * Evidence attached when the parse produced zero worktrees. The field case
 * this exists for (E:\C1Algorithm) was a real repository whose `worktree.list`
 * returned `[]` with no error at all: the prefix match failed silently and
 * nothing in the process could say why, so the renderer showed "Not a Git
 * repository" and the round could only report the symptom.
 */
export interface WorktreeListEmptyDiagnostic {
  /** Byte length of the raw stdout — distinguishes "empty" from "not empty but unparsable". */
  byteLength: number;
  /** How many lines the split produced (1 for a single unterminated line). */
  lineCount: number;
  /** First 200 characters verbatim, so an unexpected prefix is readable. */
  head: string;
  /** Code point of the very first character — a BOM shows up here as 65279. */
  firstCharCode: number | null;
}

export interface WorktreeListParseResult {
  worktrees: GitWorktree[];
  /** Present only when `worktrees` is empty. */
  emptyDiagnostic?: WorktreeListEmptyDiagnostic;
}

/**
 * Strip the pollution that makes a prefix match fail while leaving the line
 * looking correct in a terminal:
 * - a UTF-8 BOM (`\uFEFF`), which git for Windows can emit ahead of the first
 *   line — `'\uFEFFworktree /repo'.startsWith('worktree ')` is false;
 * - a trailing `\r` from CRLF output, which both breaks the exact-match lines
 *   (`'bare\r' !== 'bare'`) and silently appends a carriage return to every
 *   captured branch name and path.
 *
 * Deliberately does NOT trim ordinary whitespace: a path may legitimately end
 * in a space, and git does not indent porcelain keys.
 */
function cleanPorcelainLine(line: string): string {
  return line.replace(/^\uFEFF+/, '').replace(/\r+$/, '');
}

export function parseWorktreeListPorcelain(
  stdout: string,
  /** Maps a git-reported path back to a host path (WSL UNC); identity by default. */
  fromGitPath: (inputPath: string) => string = (inputPath) => inputPath
): WorktreeListParseResult {
  const worktrees: GitWorktree[] = [];
  let current: Partial<GitWorktree> = {};

  const lines = stdout.split('\n');
  for (const rawLine of lines) {
    const line = cleanPorcelainLine(rawLine);
    if (line.startsWith('worktree ')) {
      if (current.path) {
        worktrees.push(current as GitWorktree);
      }
      current = {
        path: fromGitPath(line.substring(9)),
        isMainWorktree: false,
        isLocked: false,
        prunable: false,
      };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.substring(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.substring(7).replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.isMainWorktree = true;
    } else if (line === 'locked') {
      current.isLocked = true;
    } else if (line === 'prunable') {
      current.prunable = true;
    }
  }

  if (current.path) {
    worktrees.push(current as GitWorktree);
  }

  // Mark first worktree as main
  if (worktrees.length > 0) {
    worktrees[0].isMainWorktree = true;
    return { worktrees };
  }

  return {
    worktrees,
    emptyDiagnostic: {
      byteLength: Buffer.byteLength(stdout, 'utf8'),
      lineCount: lines.length,
      head: stdout.slice(0, 200),
      // `codePointAt` on an empty string is undefined — normalized to null so
      // the field is always present in the log line.
      firstCharCode: stdout.codePointAt(0) ?? null,
    },
  };
}
