/**
 * Pure helpers for the two Claude Code JSON files this app touches. Zero
 * `electron` import: every path is passed in by the caller.
 *
 * ## What changed in S0' (D60)
 *
 * This module used to generate a whole managed claude-home — a directory
 * `<userData>/claude-home` that Main pointed `CLAUDE_CONFIG_DIR` at, holding
 * our own `settings.json`, `.claude.json`, a generated-artifact sidecar, and
 * empty `commands/` + `skills/` folders. That directory is gone: it was the
 * mechanism that made the user's real `~/.claude` invisible (their CLAUDE.md,
 * commands, skills and plugins went with it), and the only thing it actually
 * bought — getting our credential to the runtime — is now done by handing the
 * credential over as env (`hostEnv.ts`).
 *
 * What remains is the one file we still legitimately need to touch: the
 * user's own `.claude.json`, and only for trust/onboarding state, which is a
 * MERGE into their file (their existing keys always win), never a rewrite.
 * `settings.json` is now entirely theirs — we neither read it for credentials
 * with priority nor write it at all.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeSettingsFile } from './managedFileWriter';

/**
 * Where Claude Code keeps `.claude.json`.
 *
 * Note the asymmetry with `settings.json`, which lives INSIDE `~/.claude`:
 * `.claude.json` normally sits at the top level as `~/.claude.json`, and
 * Claude Code's own `CLAUDE_CONFIG_DIR` handling relocates it to
 * `$CLAUDE_CONFIG_DIR/.claude.json` — not `$CLAUDE_CONFIG_DIR/.claude/…`.
 * Same rule as `McpManager.ts`'s reader, deliberately duplicated rather than
 * shared: that module reads MCP config and this one writes trust state, and
 * coupling them would make either one's move drag the other along.
 *
 * We honor `CLAUDE_CONFIG_DIR` but no longer SET it (D60) — it is Claude
 * Code's public convention, so a user who sets it deliberately still gets
 * what they asked for.
 */
export function getEffectiveClaudeJsonPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    return join(configDir, '.claude.json');
  }
  return join(homedir(), '.claude.json');
}

/**
 * A Claude credential pair, wherever it came from. Named for what it IS, not
 * for the directory it used to be written into — `adoption.ts` reads one out
 * of the user's own `settings.json`, and nothing writes one to disk any more.
 */
export interface ClaudeCredentials {
  baseUrl: string;
  authToken: string;
}

/** Minimal fresh `.claude.json`: pre-completed onboarding, empty project trust map. */
export function generateClaudeJson(): Record<string, unknown> {
  return { hasCompletedOnboarding: true, projects: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * D47 S2a trust call matrix — marks `wsPath` as trusted in `claudeJsonPath`'s
 * `projects` map, going through `managedFileWriter.writeSettingsFile` so
 * concurrent trust writes for different workspaces serialize instead of
 * racing. `wsPath` must already be `path.resolve`-normalized by the caller
 * (Windows case/separator differences are the caller's job, not this one's).
 */
export async function ensureWorkspaceTrusted(
  claudeJsonPath: string,
  wsPath: string
): Promise<void> {
  await writeSettingsFile(claudeJsonPath, (current) => {
    // `{ ...generateClaudeJson(), ...current }`: when `current` is `{}`
    // (file absent, or just rebuilt from a corrupt-JSON degrade), this fills
    // in the minimal managed shape; when `current` already has content,
    // its own keys win over the defaults.
    const base = { ...generateClaudeJson(), ...current };
    const projects = isRecord(base.projects) ? { ...base.projects } : {};
    const existingEntry = isRecord(projects[wsPath])
      ? (projects[wsPath] as Record<string, unknown>)
      : {};

    return {
      ...base,
      projects: {
        ...projects,
        [wsPath]: {
          ...existingEntry,
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    };
  });
}
