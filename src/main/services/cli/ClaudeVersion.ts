import type { ClaudeRuntimeKind } from '@shared/types';
import { LAST_NODE_CLAUDE_VERSION } from '@shared/types';

/**
 * Compare two semver-ish versions. Returns:
 *   <0 if a < b, 0 if equal, >0 if a > b.
 * Non-numeric segments and missing parts are tolerated (treated as 0).
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const aParts = parse(a);
  const bParts = parse(b);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function classifyClaudeCliVersion(
  version: string
): Extract<ClaudeRuntimeKind, 'node-compatible' | 'bun-incompatible'> {
  return compareSemver(version, LAST_NODE_CLAUDE_VERSION) <= 0
    ? 'node-compatible'
    : 'bun-incompatible';
}
