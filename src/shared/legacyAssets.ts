/**
 * dsh-rebase P1-16e (decision 104) — the one-time "no longer used" notice.
 *
 * The DSH build stops reading several things a 1.0.x user may have written:
 * custom sub-agent definitions (decision 090), prompt templates (decision
 * 103), the user-layer instruction file (decision 102), `mcp.json` (decision
 * 090), skills DSH's registry rejects (decisions 064 / 101) and an explicit
 * "delegation off" switch (decision 105). Main lists what it finds on this
 * machine; the renderer shows it once on its own and on demand from
 * Settings → Extensions. Pi extensions are deliberately absent: decision 090
 * removed them without any notice entry.
 *
 * Read-only by contract: detection lists directories and reads frontmatter,
 * and nothing here ever changes, moves or deletes a user file — the 1.0.x
 * build keeps working off the same files after a downgrade.
 *
 * Import-free: Main, preload and the renderer all import it.
 */

/**
 * Main-owned top-level settings key (`MAIN_OWNED_SETTING_KEYS` in
 * ipc/settings.ts): `true` once the notice has been shown and closed, after
 * which it no longer opens by itself.
 */
export const LEGACY_ASSET_NOTICE_SETTING_KEY = 'dshLegacyAssetNoticeSeen';

/** Why DSH's skill registry will not load a skill the 1.0.x runtime loaded. */
export type LegacySkillIssue =
  /** The frontmatter has no `name`; 1.0.x fell back to the directory or file name. */
  | 'missing-name'
  /** The declared name is not lowercase-with-dashes (`^[a-z0-9]+(-[a-z0-9]+)*$`). */
  | 'invalid-name'
  /** Deeper than `<root>/<name>/SKILL.md` or `<root>/<name>.md`. */
  | 'nested'
  /** In a root DSH does not scan: `.pi/skills`, or `.agents/skills` below the repository root. */
  | 'unscanned-root';

export interface LegacySubagentAsset {
  /** The definition name as 1.0.x showed it: frontmatter `name`, else the file name. */
  name: string;
  path: string;
}

export interface LegacyTemplateAsset {
  /** The `/name` the template answered to. */
  name: string;
  path: string;
  scope: 'user' | 'project';
}

export interface LegacyMcpConfigAsset {
  path: string;
  scope: 'user' | 'project' | 'local';
  /** Server names as written in `mcpServers`; nothing else of the file is carried. */
  servers: string[];
  /** The file exists but could not be read, or has no `mcpServers` object. */
  unreadable: boolean;
}

export interface LegacySkillAsset {
  name: string;
  path: string;
  issues: LegacySkillIssue[];
}

export interface LegacyAssetReport {
  /** `<agentDir>`: where DSH reads `AGENTS.md` and `skills/` from (decision 101). */
  agentDir: string;
  /** `<agentDir>/AGENTS.md` — where user-layer rules go now (decision 102). */
  instructionTarget: string;
  /** `<agentDir>/skills` — where a rewritten template goes (decision 103). */
  skillsTarget: string;
  /** The workspace whose project-level files were looked at, or `null` for none. */
  workspace: string | null;
  subagents: LegacySubagentAsset[];
  promptTemplates: LegacyTemplateAsset[];
  /**
   * The one user-layer instruction file 1.0.x actually read — the first of
   * `~/.pilab/AGENTS.md`, `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` with
   * content — or `null`.
   */
  instructionFile: string | null;
  mcpConfigs: LegacyMcpConfigAsset[];
  skills: LegacySkillAsset[];
  /** The user explicitly turned 1.0.x delegation off (decision 105). */
  delegationSwitchOff: boolean;
}

export interface LegacyAssetNoticeState {
  report: LegacyAssetReport;
  /** The notice was shown and closed before; it does not open by itself again. */
  seen: boolean;
}

export interface InspectLegacyAssetsRequest {
  /** The workspace open right now. Project-level files are looked for here only. */
  cwd?: string;
}

/**
 * Whether the notice opens by itself: never after it was seen, and only when
 * there is something to list — an empty "nothing changed" dialog is noise.
 */
export function shouldShowLegacyAssetNotice(state: LegacyAssetNoticeState): boolean {
  return !state.seen && legacyAssetCount(state.report) > 0;
}

/** How many separate things the notice lists; `0` means there is nothing to say. */
export function legacyAssetCount(report: LegacyAssetReport): number {
  return (
    report.subagents.length +
    report.promptTemplates.length +
    (report.instructionFile ? 1 : 0) +
    report.mcpConfigs.length +
    report.skills.length +
    (report.delegationSwitchOff ? 1 : 0)
  );
}
