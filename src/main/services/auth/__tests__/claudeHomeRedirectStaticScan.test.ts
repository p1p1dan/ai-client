import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * File-level allowlist + per-file HIT-COUNT baseline for
 * `homedir()`-joined-with-`.claude` literals under `src/main`. Every
 * legitimate hit is enumerated below with a reason; any NEW hit (a file not
 * in the table) or any COUNT DRIFT on a listed file (higher OR lower) turns
 * this red.
 *
 * ## What it defends, before and after D60
 *
 * Before: new code had to go through a `CLAUDE_CONFIG_DIR`-aware helper
 * rather than hardcode `~/.claude`, because the variable was redirected at a
 * managed home and a hardcoded path would silently read the wrong one.
 *
 * After: we no longer redirect the variable — but the rule survives with a
 * different justification, which is why this file was kept rather than
 * deleted. A user who sets `CLAUDE_CONFIG_DIR` themselves still expects every
 * part of this app to honor it, and a fresh hardcoded `~/.claude` would
 * silently ignore them. The allowlist is now the list of places entitled to
 * spell the DEFAULT, not the list of places exempt from a redirect.
 *
 * Rebuilding this table: run the count function below over `src/main` and
 * diff against BASELINE. Do not bump a count without adding a reason.
 */

const MAIN_DIR = join(process.cwd(), 'src', 'main');

/** Absolute-repo-root-relative path -> exact expected hit count + reason. */
const BASELINE: Record<string, { count: number; reason: string }> = {
  'src/main/services/remote/RemoteHelperSource.ts': {
    count: 1,
    reason:
      'Remote-machine template segment (generates code that runs on the REMOTE host, not this process) — I8 exempt.',
  },
  'src/main/services/onboarding/OnboardingService.ts': {
    count: 2,
    reason:
      "S3 deleted the legacy WRITERS (writeClaudeConfig / ensureClaudeOnboardingComplete), taking two of the original four hits with them — no login can reach them once signing in records `credentialMode: managed`. The two that remain are `removeClaudeCredentials` (logout) and `checkCredentialsHealth` (read-only), both deliberately kept: the remover is the ONLY path that undoes what pre-S3 builds wrote into the user's own ~/.claude/settings.json, and the health check is what the local arm of the gate reads.",
  },
  'src/main/services/legacyImport/ClaudeSessionScanner.ts': {
    count: 1,
    reason:
      'T34 migration-only CLAUDE_CONFIG_DIR-aware source scanner; read-only and statically isolated from execution runtime.',
  },
  'src/main/services/cli/ClaudeRuntimeConfig.ts': {
    count: 1,
    reason: 'D47 S2a follower (this slice): settings.json base follows CLAUDE_CONFIG_DIR.',
  },
  'src/main/services/auth/claudeHome.ts': {
    count: 1,
    reason:
      "D60: getEffectiveClaudeJsonPath's `~/.claude.json` default. This is the ONE place entitled to spell it — the rule's authority, not an exemption from it. (Matched by prefix: the scanner sees `'.claude` inside `'.claude.json'`.)",
  },
  'src/main/services/auth/adoption.ts': {
    count: 1,
    reason:
      'D47 S6 §1.2 adoption reader (readClaudeHomeCredentials) — the OS-home HARDCODED path IS the point (self-adoption guard, A-m3): must never become a CLAUDE_CONFIG_DIR-aware follower, or a managed-mode process could adopt from its own redirected home instead of the real legacy one.',
  },
};

function listMainSources(): string[] {
  return (readdirSync(MAIN_DIR, { recursive: true }) as string[])
    .map(String)
    .filter((p) => p.endsWith('.ts') && !p.includes('__tests__'))
    .map((p) => join(MAIN_DIR, p));
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Counts lines that join `homedir()` (namespace or default import call form) with a `.claude`-shaped string literal on the same line — this repo's existing hardcode idiom (verified against every current hit above). */
function countHomedirClaudeHits(source: string): number {
  const code = stripComments(source);
  return code.split('\n').filter((line) => /homedir\(\)/.test(line) && /'\.claude/.test(line))
    .length;
}

function rel(path: string): string {
  return path.slice(process.cwd().length + 1).replace(/\\/g, '/');
}

describe('claude-home redirect hit-count baseline (D47 S2a §1 §3-6)', () => {
  it('every file under src/main matches its baselined hit count exactly (no new hit, no drift)', () => {
    const actual: Record<string, number> = {};
    for (const filePath of listMainSources()) {
      const count = countHomedirClaudeHits(readFileSync(filePath, 'utf-8'));
      if (count > 0) {
        actual[rel(filePath)] = count;
      }
    }

    const expected: Record<string, number> = {};
    for (const [path, entry] of Object.entries(BASELINE)) {
      expected[path] = entry.count;
    }

    expect(actual).toEqual(expected);
  });

  it('every baselined entry carries a non-empty reason', () => {
    for (const [path, entry] of Object.entries(BASELINE)) {
      expect(entry.reason.length, `${path} needs a reason`).toBeGreaterThan(0);
    }
  });

  describe('scanner self-check (positive/negative control fixtures)', () => {
    it('positive control: flags a fresh unbaselined hardcoded ~/.claude usage', () => {
      const fixture = `
        function getSomeNewPath(): string {
          return path.join(os.homedir(), '.claude', 'new-thing.json');
        }
      `;
      expect(countHomedirClaudeHits(fixture)).toBe(1);
    });

    it('positive control: flags each of two hits on separate lines independently', () => {
      const fixture = `
        const a = path.join(os.homedir(), '.claude');
        const b = path.join(os.homedir(), '.claude.json');
      `;
      expect(countHomedirClaudeHits(fixture)).toBe(2);
    });

    it('negative control: a comment mentioning both tokens is stripped, not counted', () => {
      const fixture = `
        // Legacy behavior used homedir() joined with '.claude' before this slice.
        function getManagedPath(): string {
          return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude-not-really');
        }
      `;
      // Only the code line counts, and it targets '.claude-not-really', which
      // the regex still matches as a prefix — demonstrating the scanner is
      // deliberately generous (catches near-misses too) while ignoring the
      // comment-only mention above it.
      expect(countHomedirClaudeHits(fixture)).toBe(1);
    });

    it('negative control: homedir() alone (no .claude literal on the same line) is not counted', () => {
      const fixture = `
        const base = os.homedir();
        const claudeDir = path.join(base, '.claude');
      `;
      expect(countHomedirClaudeHits(fixture)).toBe(0);
    });
  });
});
