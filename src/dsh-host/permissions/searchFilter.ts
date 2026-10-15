/**
 * The deny list applied to what glob / grep found (dsh-rebase decision 048).
 *
 * DSH's glob lists hidden and ignored files (`--no-ignore --hidden`) and grep
 * reads whatever ripgrep's defaults let through (decision 190's grep, hidden
 * files too), so `.env` names and `*.key` lines reach a result the gate never
 * saw path by path. Each entry is judged with `gate.canTraverse`, the check
 * the 1.0.x walkers made per file.
 */

import { resolve } from 'node:path';

export interface SearchFilterGate {
  canTraverse(request: { tool: string; toolCallId: string; path: string }): boolean;
}

interface GlobValue {
  root: string;
  paths: string[];
}

interface GrepValue {
  matches: Array<{ path: string; lineNumber: number; line: string }>;
}

/**
 * Decision 190's grep (`aiclient-fs-search`): every entry names its file,
 * whatever the output mode (a printed line, a file, a file's count).
 */
interface RichGrepValue {
  entries: Array<{ path: string }>;
}

function isGlobValue(value: unknown): value is GlobValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as GlobValue).paths) &&
    (value as GlobValue).paths.every((path) => typeof path === 'string')
  );
}

function isGrepValue(value: unknown): value is GrepValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as GrepValue).matches) &&
    (value as GrepValue).matches.every((match) => typeof match?.path === 'string')
  );
}

function isRichGrepValue(value: unknown): value is RichGrepValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as RichGrepValue).entries) &&
    (value as RichGrepValue).entries.every((entry) => typeof entry?.path === 'string')
  );
}

/** Keep what `allowed` lets through, judging each path once. */
function keepAllowed<T extends { path: string }>(
  items: readonly T[],
  allowed: (path: string) => boolean
): T[] {
  const verdicts = new Map<string, boolean>();
  return items.filter((item) => {
    let verdict = verdicts.get(item.path);
    if (verdict === undefined) {
      verdict = allowed(item.path);
      verdicts.set(item.path, verdict);
    }
    return verdict;
  });
}

/**
 * The value with every entry the gate may not traverse removed, or undefined
 * when nothing was removed (or the value is not a search value). Paths are
 * workdir-relative display paths, the workdir being the session cwd.
 */
export function filterSearchValue(
  tool: string,
  toolCallId: string,
  value: unknown,
  cwd: string,
  gate: SearchFilterGate
): { value: unknown; removed: number } | undefined {
  const allowed = (path: string) =>
    gate.canTraverse({ tool, toolCallId, path: resolve(cwd, path) });
  if (tool === 'glob' && isGlobValue(value)) {
    const paths = value.paths.filter(allowed);
    const removed = value.paths.length - paths.length;
    return removed > 0 ? { value: { ...value, paths }, removed } : undefined;
  }
  if (tool === 'grep' && isGrepValue(value)) {
    const matches = keepAllowed(value.matches, allowed);
    const removed = value.matches.length - matches.length;
    return removed > 0 ? { value: { ...value, matches }, removed } : undefined;
  }
  if (tool === 'grep' && isRichGrepValue(value)) {
    const entries = keepAllowed(value.entries, allowed);
    const removed = value.entries.length - entries.length;
    return removed > 0 ? { value: { ...value, entries }, removed } : undefined;
  }
  return undefined;
}
