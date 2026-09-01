import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LAST_NODE_CLAUDE_VERSION } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { compareSemver } from '../ClaudeVersion';

describe('compareSemver', () => {
  it('orders patch versions numerically, not lexicographically', () => {
    expect(compareSemver('2.1.9', '2.1.10')).toBeLessThan(0);
    expect(compareSemver('2.1.112', '2.1.99')).toBeGreaterThan(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareSemver('2.1', '2.1.0')).toBe(0);
    expect(compareSemver('2', '2.0.0')).toBe(0);
  });

  it('returns equality when versions match', () => {
    expect(compareSemver('2.1.112', LAST_NODE_CLAUDE_VERSION)).toBe(0);
  });

  it('tolerates non-numeric segments by treating them as zero', () => {
    expect(compareSemver('2.1.112-rc1', '2.1.112')).toBe(0);
    expect(compareSemver('1.0.0-beta', '0.9.99')).toBeGreaterThan(0);
  });
});

/**
 * ⚠️ RETIRED (2026-08-26, user decision): the `classifyClaudeCliVersion` block.
 *
 * It asserted a `> 2.1.112 ⇒ bun-incompatible` threshold that had gone stale —
 * newer Claude Code builds bundle Node again — so the banner it drove fired on
 * a rule nobody had re-checked. The ruling was "retire, no detection": telling
 * the two runtimes apart needs a real probe of the binary, and guessing
 * differently would be the same mistake with a new number.
 *
 * `LAST_NODE_CLAUDE_VERSION` itself did NOT retire: `AgentInstaller` still pins
 * every install to it, which rests on the same assumption and is tracked
 * separately (see the constant's own note).
 */

/**
 * The order the checker asks its questions in, asserted on the source.
 *
 * A behaviour test would need the real filesystem layout and Electron's `app`,
 * neither of which exists in this node-env suite — but the load-bearing claim
 * is ORDER, and order is readable: the bundled runtime is consulted BEFORE the
 * `claude --version` probe, so a working install is never sent to onboarding to
 * install a CLI that nothing will run.
 */
describe('runtime gate checks only the Pi worker artifact (T30)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../ClaudeRuntimeChecker.ts', import.meta.url)),
    'utf8'
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('uses the neutral Pi worker entry resolver', () => {
    expect(source).toContain('resolveCurrentPiWorkerEntryPath()');
    expect(source).toContain("cliVersion: 'pi-worker'");
  });

  it('does not probe legacy Claude/Cometix runtime paths', () => {
    expect(source).not.toContain('deriveBundledCometixCliPath');
    expect(source).not.toContain('runVersionCheck');
    expect(source).not.toContain('detectVsCodeClaudeExtension');
  });
});
