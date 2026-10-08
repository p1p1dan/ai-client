/**
 * Parser for `git branch -a -v` output that reproduces simple-git's
 * `parseBranchSummary` (simple-git 3.x, src/lib/parsers/parse-branch.ts) line
 * for line, so a listing recovered by the node-runner fallback becomes exactly
 * the same `GitBranch[]` as the primary `this.git.branch(['-a', '-v'])` path:
 * same names (`remotes/origin/x` for remotes), same `current` flag, same
 * detached-HEAD entry named after its target, same `[ahead N] subject` label.
 *
 * Pure, so it is unit-testable without loading `./runtime` (node-pty).
 * The detached pattern only matches English text; the fallback runs git with
 * `LC_ALL=C` for that reason.
 */

/** Shape of simple-git's `BranchSummary.branches[name]` that GitService reads. */
export type BranchSummaryEntry = {
  current: boolean;
  commit: string;
  label: string;
};

const DETACHED_LINE = /^([*+]\s)?\((?:HEAD )?detached (?:from|at) (\S+)\)\s+([a-z0-9]+)\s(.*)$/;
const BRANCH_LINE = /^([*+]\s)?(\S+)\s+([a-z0-9]+)\s?(.*)$/s;
// `  remotes/origin/HEAD -> origin/main`. BRANCH_LINE rejects these anyway
// ("->" is not a commit); the explicit skip only documents it. It must not be
// a plain "contains ->" test: commit subjects can contain "->".
const SYMREF_LINE = /^[*+ ] \S+\s+-> /;

/**
 * Keyed by branch name like simple-git's `BranchSummary.branches`, so the
 * caller's `Object.entries` mapping yields the same order and de-duplication.
 */
export function parseBranchVerbose(stdout: string): Record<string, BranchSummaryEntry> {
  const branches: Record<string, BranchSummaryEntry> = {};
  for (const rawLine of stdout.split('\n')) {
    if (SYMREF_LINE.test(rawLine)) continue;
    const line = rawLine.trim();
    if (!line) continue;
    const match = DETACHED_LINE.exec(line) ?? BRANCH_LINE.exec(line);
    if (!match) continue;
    const [, marker, name, commit, label] = match;
    branches[name] = { current: marker?.charAt(0) === '*', commit, label };
  }
  return branches;
}
