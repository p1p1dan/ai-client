import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * D47 S2a §1 §3-6 — file-level allowlist + per-file HIT-COUNT baseline for
 * `homedir()`-joined-with-`.claude` literals under `src/main`. Every
 * legitimate hit is enumerated below with a reason; any NEW hit (a file not
 * in the table) or any COUNT DRIFT on a listed file (higher OR lower) turns
 * this red — new code must go through `CLAUDE_CONFIG_DIR`-aware helpers
 * (matching the "9 跟随者" precedent already in this codebase), not a fresh
 * hardcoded `~/.claude` path.
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
    count: 4,
    reason:
      'Legacy double-write body (writeClaudeConfig/ensureClaudeOnboardingComplete/removeClaudeCredentials/checkCredentialsHealth) — left at ~/.claude by design until S5/S6 collapse legacy writers into the managed path.',
  },
  'src/main/services/auth/managedClaudeHomeStartup.ts': {
    count: 1,
    reason:
      'One-time CLAUDE.md adoption COPY SOURCE (D47 S2a f 裁定) — reads the legacy ~/.claude/CLAUDE.md to seed the managed home once; never a write target for this path.',
  },
  'src/main/services/claude/ClaudeIdeBridge.ts': {
    count: 1,
    reason:
      'Existing CLAUDE_CONFIG_DIR-aware follower (if/else form) — out of S2a file set, unmodified.',
  },
  'src/main/services/claude/ClaudeProviderManager.ts': {
    count: 1,
    reason:
      'Existing CLAUDE_CONFIG_DIR-aware follower (if/else form) — out of S2a file set, unmodified (S2b territory).',
  },
  'src/main/services/claude/ClaudeSessionScanner.ts': {
    count: 1,
    reason:
      'Existing CLAUDE_CONFIG_DIR-aware follower (`||` form) — S2b file set, unmodified by S2a.',
  },
  'src/main/services/claude/sessionLogReader.ts': {
    count: 1,
    reason:
      'Existing CLAUDE_CONFIG_DIR-aware follower (`||` form) — out of S2a file set, unmodified.',
  },
  'src/main/services/claude/McpManager.ts': {
    count: 1,
    reason:
      'D47 S2a follower (this slice): .claude.json base follows CLAUDE_CONFIG_DIR when set, else legacy top-level ~/.claude.json.',
  },
  'src/main/services/claude/PluginsManager.ts': {
    count: 1,
    reason:
      'D47 S2a follower (this slice): settings.json/plugins dir base follows CLAUDE_CONFIG_DIR.',
  },
  'src/main/services/claude/PromptsManager.ts': {
    count: 1,
    reason:
      'D47 S2a follower (this slice): CLAUDE.md base follows CLAUDE_CONFIG_DIR (write itself stays outside managedFileWriter — plain text, not JSON).',
  },
  'src/main/services/claude/ClaudeCompletionsManager.ts': {
    count: 2,
    reason:
      'U1 union semantics (kept as-is, D47 S2 spec §1): one follower form (getClaudeConfigDir, learned-cache path) + one always-include-home component of the union scan (getClaudeConfigDirs, commands/skills).',
  },
  'src/main/services/claude/ClaudeHookManager.ts': {
    count: 1,
    reason:
      "Existing CLAUDE_CONFIG_DIR-aware follower (if/else form) — out of S2a file set (see as-built deviation note: mother spec §1 lists HookManager as a 4th settings.json writer for managedFileWriter, but S2a's assigned file set does not include this file; left unmodified, flagged for orchestrator follow-up).",
  },
  'src/main/services/cli/ClaudeRuntimeConfig.ts': {
    count: 1,
    reason: 'D47 S2a follower (this slice): settings.json base follows CLAUDE_CONFIG_DIR.',
  },
  'src/main/ipc/claudeSessions.ts': {
    count: 1,
    reason:
      'S2b Scanner dual-source infra: literal legacy-root constant (kind:"legacy"), not a redirect follower by design — paired with a managed root elsewhere in the same file.',
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
