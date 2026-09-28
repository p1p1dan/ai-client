/**
 * The deny list applied to what glob / grep found (dsh-rebase decision 048).
 *
 * DSH's glob lists hidden and ignored files (`--no-ignore --hidden`) and grep
 * reads whatever ripgrep's defaults let through, so `.env` names and `*.key`
 * lines reach a result the gate never saw path by path. Each entry is judged
 * with `gate.canTraverse`, the check the 1.0.x walkers made per file.
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
    const verdicts = new Map<string, boolean>();
    const matches = value.matches.filter((match) => {
      let verdict = verdicts.get(match.path);
      if (verdict === undefined) {
        verdict = allowed(match.path);
        verdicts.set(match.path, verdict);
      }
      return verdict;
    });
    const removed = value.matches.length - matches.length;
    return removed > 0 ? { value: { ...value, matches }, removed } : undefined;
  }
  return undefined;
}
