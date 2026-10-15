/**
 * The deterministic layer (docs/agent-project-engineering.md §4): which files
 * changed, which must not have, patterns the agent must not introduce or the
 * answer must contain, and commands that must exit as expected. Static checks
 * read the agent's state; commands run after the case's overlay (hidden
 * acceptance tests) is copied in.
 */

import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { git, runCommand } from './proc.ts';
import type { CaseChecks, ChangedFile, CheckResult, CommandCheck, PatternCheck } from './types.ts';

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => posix.matchesGlob(path, glob));
}

function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

/** The lines each file gained in a unified diff, by repository path. */
export function addedLines(patch: string): Map<string, string[]> {
  const added = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = unquote(line.slice(4).trim());
      current = undefined;
      if (target !== '/dev/null') {
        const path = target.replace(/^b\//, '');
        current = added.get(path) ?? [];
        added.set(path, current);
      }
    } else if (line.startsWith('+') && current) {
      current.push(line.slice(1).replace(/\r$/, ''));
    }
  }
  return added;
}

export interface StaticContext {
  ws: string;
  changes: readonly ChangedFile[];
  patch: string;
  answer: string;
  env: Record<string, string>;
}

/** Stateless: `g` and `y` would make `test` remember where it stopped. */
function regexOf(check: PatternCheck): RegExp {
  return new RegExp(check.pattern, check.flags?.replace(/[gy]/g, ''));
}

/** Workspace files matching `globs`: tracked or new, ignored files left out. */
function workspaceFiles(ctx: StaticContext, globs: readonly string[]): string[] {
  const listed = git(ctx.ws, ['ls-files', '-co', '--exclude-standard', '-z'], ctx.env);
  return listed
    .split('\0')
    .filter(Boolean)
    .filter((path) => matchesAny(path, globs));
}

/** Where `check` matched, at most five places. */
function findMatches(
  check: PatternCheck,
  where: 'added' | 'content' | 'answer',
  ctx: StaticContext
) {
  const regex = regexOf(check);
  const hits: Array<{ path?: string; text: string }> = [];
  const note = (text: string, path?: string) => {
    if (hits.length < 5) hits.push({ ...(path ? { path } : {}), text: text.slice(0, 200) });
  };
  if (where === 'answer') {
    const match = regex.exec(ctx.answer);
    if (match) note(match[0]);
    return hits;
  }
  const changed = ctx.changes
    .filter((file) => !file.status.startsWith('D'))
    .map((file) => file.path);
  if (where === 'added') {
    for (const [path, lines] of addedLines(ctx.patch)) {
      if (check.paths && !matchesAny(path, check.paths)) continue;
      for (const line of lines) if (regex.test(line)) note(line, path);
    }
    return hits;
  }
  const paths = check.paths ? workspaceFiles(ctx, check.paths) : changed;
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(join(ctx.ws, path), 'utf8');
    } catch {
      continue;
    }
    const match = regex.exec(text);
    if (match) note(match[0], path);
  }
  return hits;
}

/** File and pattern checks over the agent's own state (before any overlay). */
export function staticChecks(checks: CaseChecks, ctx: StaticContext): CheckResult[] {
  const results: CheckResult[] = [];
  const changed = ctx.changes.map((file) => file.path);
  for (const glob of checks.mustChange ?? []) {
    const matched = changed.filter((path) => posix.matchesGlob(path, glob));
    results.push({
      id: `mustChange:${glob}`,
      kind: 'mustChange',
      passed: matched.length > 0,
      detail: { matched },
    });
  }
  for (const glob of checks.mustNotChange ?? []) {
    const matched = changed.filter((path) => posix.matchesGlob(path, glob));
    results.push({
      id: `mustNotChange:${glob}`,
      kind: 'mustNotChange',
      passed: matched.length === 0,
      detail: { matched },
    });
  }
  for (const check of checks.forbidden ?? []) {
    const where = check.in ?? 'added';
    const hits = findMatches(check, where, ctx);
    results.push({
      id: `forbidden:${check.id ?? check.pattern}`,
      kind: 'forbidden',
      passed: hits.length === 0,
      detail: { in: where, pattern: check.pattern, hits },
    });
  }
  for (const check of checks.required ?? []) {
    const where = check.in ?? 'content';
    const hits = findMatches(check, where, ctx);
    results.push({
      id: `required:${check.id ?? check.pattern}`,
      kind: 'required',
      passed: hits.length > 0,
      detail: { in: where, pattern: check.pattern, hits },
    });
  }
  return results;
}

function commandId(command: CommandCheck): string {
  return command.id ?? (command.argv ? command.argv.join(' ') : String(command.shell));
}

/** The case's commands, in order, in the workspace. */
export async function commandChecks(
  checks: CaseChecks,
  ws: string,
  env: Record<string, string>
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of checks.commands ?? []) {
    const expectExit = command.expectExit ?? 0;
    const [file, args, shell] = command.argv
      ? [command.argv[0], command.argv.slice(1), false]
      : [String(command.shell), [], true];
    const run = await runCommand(file, args, {
      cwd: ws,
      env,
      shell,
      timeoutMs: command.timeoutMs ?? 120_000,
    });
    results.push({
      id: `command:${commandId(command)}`,
      kind: 'command',
      passed: !run.timedOut && run.code === expectExit,
      detail: {
        ...(command.argv ? { argv: command.argv } : { shell: command.shell }),
        expectExit,
        code: run.code,
        timedOut: run.timedOut,
        ms: run.ms,
        stdoutTail: run.stdout.slice(-2000),
        stderrTail: run.stderr.slice(-2000),
      },
    });
  }
  return results;
}
