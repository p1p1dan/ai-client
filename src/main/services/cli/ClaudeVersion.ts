/**
 * Version comparison for the CLI probes.
 *
 * `classifyClaudeCliVersion` used to live here too, deciding `node-compatible`
 * vs `bun-incompatible` from a `> 2.1.112` threshold. It retired with the Bun
 * banner (2026-08-26, user decision): the threshold was stale — newer Claude
 * Code builds bundle Node again — and a verdict nobody has re-checked is worse
 * than no verdict. Nothing replaced it, deliberately; telling the two runtimes
 * apart needs a real probe of the binary, and the ruling was to stop guessing
 * rather than to guess differently.
 *
 * `compareSemver` stayed because it never had anything to do with that rule:
 * its live caller sorts VSCode extension folders by version.
 */

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
