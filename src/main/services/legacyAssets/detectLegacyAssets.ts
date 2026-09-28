/**
 * dsh-rebase P1-16e (decision 104) — find what a 1.0.x user wrote that the DSH
 * build no longer uses.
 *
 * ## Read-only
 *
 * Directory listings, `stat`, and bounded reads of `.md` frontmatter and
 * `mcp.json` — nothing else. No file is created, changed, moved or deleted, so
 * a downgrade to 1.0.x finds everything exactly where it was (decisions 102,
 * 103, 105: "only a notice, no migration").
 *
 * ## Rules come from the 1.0.x code, not a re-description of it
 *
 * Where 1.0.x looked is answered by the same shared functions its runtime
 * called: `subagentRoots` (decision 087 kept it for this), `templateRoots` /
 * `loadPromptTemplates`, `skillRoots` / `loadSkills`, `mcpConfigFiles`. Skills
 * are then re-judged by DSH's own rules (`dsh-skill-filesystem`): direct
 * children of a scanned root only, required `name`, kebab-case names.
 *
 * ## Injectable
 *
 * The file access, the home directory, the agent directory and the settings
 * object are all parameters, so tests run against temporary directories and
 * never touch the developer's real home.
 *
 * Pi extensions are not looked for at all: decision 090 removed them "without
 * a notice entry".
 */

import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { APP_STATE_DIR } from '@shared/defaultPaths';
import { errorCode } from '@shared/errorCode';
import type {
  LegacyAssetReport,
  LegacyMcpConfigAsset,
  LegacySkillAsset,
  LegacySkillIssue,
  LegacySubagentAsset,
  LegacyTemplateAsset,
} from '@shared/legacyAssets';
import { mcpConfigFiles, mcpConfigSource } from '@shared/mcp/config';
import {
  PI_ENABLE_SUBAGENTS_SETTING_KEY,
  PI_OPT_IN_FEATURE_SETTINGS_KEY,
  PI_SUBAGENTS_FEATURE_ID,
} from '@shared/piModelConfig';
import { MAX_SCAN_BYTES, skillRoots, skillSource, templateRoots } from '@shared/skills/catalog';
import { loadSkills, parseFrontmatter } from '@shared/skills/loader';
import { loadPromptTemplates } from '@shared/skills/templates';
import { subagentRoots } from '@shared/subagentCatalogRoots';
import { normalizeSubagentName } from '@shared/subagentDefinition';
import { isRemoteVirtualPath } from '@shared/utils/remotePath';
import type { LegacyAssetFiles } from './nodeFiles';

/**
 * The home-directory instruction files 1.0.x read, in its order; the first
 * with content won (`runtime/plugins/prompt/projectInstructions.ts`,
 * `HOME_INSTRUCTION_FILE_NAMES`). Spelled here rather than imported: the
 * runtime is deleted in P1-12, so Main must not depend on it.
 */
const HOME_INSTRUCTION_FILES: readonly (readonly string[])[] = [
  [APP_STATE_DIR, 'AGENTS.md'],
  ['.claude', 'CLAUDE.md'],
  ['.codex', 'AGENTS.md'],
];

/** `dsh-skill/lib/index.js` `SKILL_NAME`: what DSH's registry accepts as a skill name. */
const DSH_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Same bound as the 1.0.x skills loader's repo-root climb. */
const MAX_ANCESTOR_LEVELS = 64;

const ABSENT = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP']);

export interface DetectLegacyAssetsOptions {
  files: LegacyAssetFiles;
  /** `<agentDir>` (`~/.pilab/<profile>/pi-agent`). */
  agentDir: string;
  /** The user's home; injected so tests never read the real one. */
  home: string;
  /** The workspace open right now; project-level files are looked for only here. */
  cwd?: string | null;
  /** The shared settings object (top-level, Main-owned keys included). */
  settings: Record<string, unknown>;
  /** Where a category that failed to scan is reported. */
  log?: (message: string) => void;
}

/**
 * A workspace path the renderer handed over, or `null` when it is not a local
 * directory this machine can list: absent, relative, the temporary-workspace
 * sentinel, or a remote (SSH) virtual path.
 */
export function usableWorkspace(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !isAbsolute(trimmed) || isRemoteVirtualPath(trimmed)) return null;
  return trimmed;
}

/**
 * Whether the user explicitly turned 1.0.x delegation off (decision 105).
 *
 * Mirrors `nativeSubagentSettings` (`services/agent-host/nativeSubagentSettings.ts`):
 * the per-feature override wins over the older boolean, and only an explicit
 * `false` is a refusal — absent meant ON in 1.0.x, so it is not reported.
 * Copied rather than imported because that module goes with native in P1-12.
 */
export function delegationSwitchExplicitlyOff(settings: Record<string, unknown>): boolean {
  const overrides = settings[PI_OPT_IN_FEATURE_SETTINGS_KEY];
  const override =
    overrides && typeof overrides === 'object' && !Array.isArray(overrides)
      ? (overrides as Record<string, unknown>)[PI_SUBAGENTS_FEATURE_ID]
      : undefined;
  const chosen =
    typeof override === 'boolean' ? override : settings[PI_ENABLE_SUBAGENTS_SETTING_KEY];
  return chosen === false;
}

async function detectSubagents(
  files: LegacyAssetFiles,
  agentDir: string,
  home: string
): Promise<LegacySubagentAsset[]> {
  const source = skillSource(files, MAX_SCAN_BYTES);
  const found: LegacySubagentAsset[] = [];
  // Only user roots exist; the four builtins live in code, so they can never
  // appear here — a user file that overrides one by name is still the user's.
  for (const root of subagentRoots({ agentDir, home })) {
    const entries = await source.list(root);
    if (!entries) continue;
    // Same filter 1.0.x's catalog applied: regular `.md` files, sorted.
    const names = entries
      .filter((entry) => entry.kind === 'file' && /\.md$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const fileName of names) {
      const path = join(root, fileName);
      let text: string | undefined;
      try {
        text = await source.readText(path);
      } catch {
        // Unreadable is still a file the user wrote; it keeps its file name.
        text = undefined;
      }
      const declared = text === undefined ? undefined : parseFrontmatter(text)?.name;
      found.push({ name: normalizeSubagentName(declared ?? fileName), path });
    }
  }
  return found;
}

async function detectPromptTemplates(
  files: LegacyAssetFiles,
  agentDir: string,
  cwd: string | null
): Promise<LegacyTemplateAsset[]> {
  const source = skillSource(files, MAX_SCAN_BYTES);
  const found: LegacyTemplateAsset[] = [];
  // `projectTrusted: true`: this lists names, it loads nothing, so the 1.0.x
  // trust gate (which kept an untrusted checkout from ADDING commands) does
  // not apply — see decision 116.
  for (const root of templateRoots({ agentDir, cwd: cwd ?? undefined, projectTrusted: true })) {
    // One root at a time: a project template that shadowed a user one by name
    // is still a separate file the user wrote.
    const loaded = await loadPromptTemplates(source, [root]);
    for (const template of loaded.templates) {
      found.push({ name: template.name, path: template.filePath, scope: template.scope });
    }
  }
  return found;
}

async function detectInstructionFile(
  files: LegacyAssetFiles,
  home: string
): Promise<string | null> {
  const source = skillSource(files, MAX_SCAN_BYTES);
  for (const segments of HOME_INSTRUCTION_FILES) {
    const path = join(home, ...segments);
    // 1.0.x skipped a missing or blank file and moved on to the next name.
    const text = await source.readText(path);
    if (text?.trim()) return path;
  }
  return null;
}

async function detectMcpConfigs(
  files: LegacyAssetFiles,
  agentDir: string,
  cwd: string | null
): Promise<LegacyMcpConfigAsset[]> {
  const source = mcpConfigSource(files);
  const found: LegacyMcpConfigAsset[] = [];
  for (const file of mcpConfigFiles({ agentDir, cwd: cwd ?? undefined, projectTrusted: true })) {
    let text: string | undefined;
    try {
      text = await source.readText(file.path);
    } catch {
      found.push({ path: file.path, scope: file.scope, servers: [], unreadable: true });
      continue;
    }
    if (text === undefined) continue;
    let servers: string[] = [];
    let unreadable = false;
    try {
      const parsed = JSON.parse(text) as { mcpServers?: unknown } | null;
      const declared = parsed?.mcpServers;
      if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
        servers = Object.keys(declared);
      } else {
        unreadable = true;
      }
    } catch {
      unreadable = true;
    }
    found.push({ path: file.path, scope: file.scope, servers, unreadable });
  }
  return found;
}

/**
 * DSH's project root: the nearest ancestor of `cwd` holding `.git`, else `cwd`
 * (`dsh-skill-filesystem` README, "Roots and priority").
 */
async function dshProjectRoot(files: LegacyAssetFiles, cwd: string): Promise<string> {
  let dir = cwd;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level++) {
    try {
      await files.stat(join(dir, '.git'));
      return dir;
    } catch (error) {
      if (!ABSENT.has(errorCode(error) ?? '')) throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

/** DSH finds `<root>/<name>/SKILL.md` and `<root>/<name>.md`, nothing deeper. */
function dshCanReach(rootPath: string, filePath: string): boolean {
  const segments = relative(rootPath, filePath).split(sep);
  return segments.length === 1 || (segments.length === 2 && segments[1] === 'SKILL.md');
}

async function detectUnloadableSkills(
  files: LegacyAssetFiles,
  agentDir: string,
  home: string,
  cwd: string | null
): Promise<LegacySkillAsset[]> {
  const source = skillSource(files, MAX_SCAN_BYTES);
  // The roots DSH scans that 1.0.x also had: `customSkillDirs` =
  // `<agentDir>/skills` (decision 101), `~/.agents/skills`, and the project
  // root's `.agents/skills`. Its `.dsh/skills` and `$DSH_HOME/skills` are new
  // and hold nothing from 1.0.x.
  const dshRoots = new Set([join(agentDir, 'skills'), join(home, '.agents', 'skills')]);
  if (cwd) dshRoots.add(join(await dshProjectRoot(files, cwd), '.agents', 'skills'));

  const roots = await skillRoots(files, {
    agentDir,
    home,
    cwd: cwd ?? undefined,
    // Listing, not loading: see `detectPromptTemplates`.
    projectTrusted: true,
  });
  const found: LegacySkillAsset[] = [];
  for (const root of roots) {
    // Per root, for the same reason as templates: 1.0.x's cross-root
    // last-wins would hide a shadowed skill that is still a real file.
    const loaded = await loadSkills(source, [root]);
    for (const skill of loaded.skills) {
      const issues: LegacySkillIssue[] = [];
      if (!dshRoots.has(root.path)) issues.push('unscanned-root');
      if (!dshCanReach(root.path, skill.filePath)) issues.push('nested');
      // 1.0.x fell back to the directory name when `name` was missing, so the
      // loaded skill's name cannot tell; the frontmatter can.
      const text = await source.readText(skill.filePath);
      const declared = text === undefined ? undefined : parseFrontmatter(text)?.name?.trim();
      if (!declared) issues.push('missing-name');
      else if (!DSH_SKILL_NAME.test(declared)) issues.push('invalid-name');
      if (issues.length > 0) found.push({ name: skill.name, path: skill.filePath, issues });
    }
  }
  return found;
}

/**
 * One category failing (an `EIO` on a network home, say) must not cost the
 * user the rest of the notice. The failure is logged, and the category reads
 * as empty — the notice is advice, not an inventory anyone relies on.
 */
async function settle<T>(
  category: string,
  run: () => Promise<T>,
  fallback: T,
  log: (message: string) => void
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    log(
      `[legacy-assets] ${category} not scanned: ${error instanceof Error ? error.message : String(error)}`
    );
    return fallback;
  }
}

export async function detectLegacyAssets(
  options: DetectLegacyAssetsOptions
): Promise<LegacyAssetReport> {
  const { files, agentDir, home, settings } = options;
  const cwd = usableWorkspace(options.cwd);
  const log = options.log ?? (() => undefined);
  return {
    agentDir,
    instructionTarget: join(agentDir, 'AGENTS.md'),
    skillsTarget: join(agentDir, 'skills'),
    workspace: cwd,
    subagents: await settle('subagents', () => detectSubagents(files, agentDir, home), [], log),
    promptTemplates: await settle(
      'prompt templates',
      () => detectPromptTemplates(files, agentDir, cwd),
      [],
      log
    ),
    instructionFile: await settle(
      'instruction files',
      () => detectInstructionFile(files, home),
      null,
      log
    ),
    mcpConfigs: await settle('mcp.json', () => detectMcpConfigs(files, agentDir, cwd), [], log),
    skills: await settle(
      'skills',
      () => detectUnloadableSkills(files, agentDir, home, cwd),
      [],
      log
    ),
    delegationSwitchOff: delegationSwitchExplicitlyOff(settings),
  };
}
