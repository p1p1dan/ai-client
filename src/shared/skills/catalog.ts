// Moved from src/runtime/plugins/skills/index.ts (dsh-rebase P1-16 prep): roots, the IO adapter and the catalog scan.

/**
 * P5-1 — which directories hold skills and prompt templates, and how one scan
 * of them becomes a catalog.
 *
 * Scanning is IO, so the catalog is built BEFORE whatever serves it (the 1.0.x
 * runtime's Cordis plugin, or a DSH host row) and handed over finished. The
 * alternative — scanning lazily on first use — would put a directory walk
 * inside the system-prompt build, i.e. inside the measured path of ARD D9's
 * cache gate.
 *
 * All file access goes through {@link SkillCatalogFiles}, a structural subset
 * of the runtime's `RuntimeHostIoService` (which fits as is). A host that
 * brings its own filesystem implements the same three calls; `stat` must
 * follow symlinks and `readDirectory` must not, the way the runtime's do.
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { errorCode } from '../errorCode.ts';
import { resolveSettingSources, type SettingSource } from '../settingSources.ts';
import {
  loadSkills,
  type RuntimeSkill,
  type SkillDiagnostic,
  type SkillFileKind,
  type SkillRoot,
  type SkillSource,
} from './loader.ts';
import {
  loadPromptTemplates,
  MAX_TEMPLATE_BYTES,
  type RuntimePromptTemplate,
  type TemplateRoot,
  templateBody,
} from './templates.ts';

/** A skill body is loaded into the conversation, so it shares the prompt's order of magnitude. */
export const MAX_SKILL_BYTES = 256 * 1024;
/**
 * Scanning reads only far enough to see the frontmatter (and, for a template
 * with no `description`, its first body line). Reading whole files here would
 * cost the full body of every installed skill on every session start, for three
 * fields — and skills are allowed to be long documents.
 */
export const MAX_SCAN_BYTES = 16 * 1024;

const OPTIONAL_FILE_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP']);

/**
 * The host file access a catalog scan needs.
 *
 * Failures reject with an error carrying the filesystem's `code`; the expected
 * absences listed in `OPTIONAL_FILE_ERRORS` read as "not there", anything else
 * propagates.
 */
export interface SkillCatalogFiles {
  readFile(
    path: string,
    options: { maxBytes: number; overflow: 'truncate' }
  ): Promise<{ bytes: Uint8Array; truncated: boolean }>;
  /** Entries of one directory; a symlink entry is reported as `symlink`, not followed. */
  readDirectory(path: string): AsyncIterable<{ name: string; kind: SkillFileKind }>;
  /** Follows symlinks. */
  stat(path: string): Promise<{ kind: SkillFileKind }>;
}

/**
 * Adapt the host's file access to the loader's port (D11: one exit, not
 * per-module `node:fs`). Expected absences answer `undefined`; host/transport
 * failures propagate, because on the encrypted target a read that fails is not
 * the same fact as a user with no skills.
 */
export function skillSource(io: SkillCatalogFiles, maxBytes: number): SkillSource {
  return {
    async readText(path) {
      try {
        const result = await io.readFile(path, { maxBytes, overflow: 'truncate' });
        return new TextDecoder().decode(result.bytes, { stream: result.truncated });
      } catch (error) {
        if (OPTIONAL_FILE_ERRORS.has(errorCode(error) ?? '')) return undefined;
        throw error;
      }
    },
    async list(path) {
      try {
        const entries: { name: string; kind: SkillFileKind }[] = [];
        for await (const entry of io.readDirectory(path)) entries.push(entry);
        return entries;
      } catch (error) {
        if (OPTIONAL_FILE_ERRORS.has(errorCode(error) ?? '')) return undefined;
        throw error;
      }
    },
    async stat(path) {
      try {
        // Default `followSymlinks` (unlike `list`'s Dirent) resolves the link.
        const info = await io.stat(path);
        return { kind: info.kind };
      } catch (error) {
        if (OPTIONAL_FILE_ERRORS.has(errorCode(error) ?? '')) return undefined;
        throw error;
      }
    },
  };
}

export interface SkillsConfig {
  /** Managed agent directory. Supplies `<agentDir>/skills` and `<agentDir>/prompts`. */
  agentDir?: string;
  /** Session workspace. Supplies the project roots. */
  cwd?: string;
  /**
   * Project roots are loaded only when the user has trusted this folder — a
   * skill is instructions the model follows and may point at scripts it runs,
   * so an untrusted checkout must not be able to contribute one. Same gate
   * `loadPermissionPolicy` applies to project policy files.
   */
  projectTrusted?: boolean;
  /**
   * decision 008 — which tiers contribute roots. Absent means all of them.
   *
   * There is no `local` skills root: the decision defines the local tier as
   * three named files (`pi-permissions.local.jsonc`, `mcp.local.json`,
   * `CLAUDE.local.md`) and skills are not among them. Inventing a fourth path
   * here would be this app's own convention dressed as an official one, and
   * `extraSkillRoots` already covers "a root only this machine has".
   */
  settingSources?: readonly SettingSource[];
  /** Extra roots, for probes and tests. Highest precedence. */
  extraSkillRoots?: readonly SkillRoot[];
  extraTemplateRoots?: readonly TemplateRoot[];
  /** Overridable so a test does not depend on the machine's real home. */
  home?: string;
}

/** Safety bound on the ancestor climb (decision 004); a real filesystem never gets close. */
const MAX_ANCESTOR_LEVELS = 64;

/**
 * Decision 004 — `cwd` and every ancestor up to and including the repo root,
 * closest first. The repo root is the first ancestor whose `.git` stats
 * successfully (a worktree's `.git` is a file, not a directory, so this only
 * needs the stat to succeed, not a particular kind). No `.git` anywhere in
 * the climb answers `[cwd]`, which is the pre-decision-004 behaviour.
 */
async function projectSkillDirectories(
  io: Pick<SkillCatalogFiles, 'stat'>,
  cwd: string
): Promise<readonly string[]> {
  const chain: string[] = [];
  let dir = cwd;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level++) {
    chain.push(dir);
    let atRepoRoot: boolean;
    try {
      await io.stat(join(dir, '.git'));
      atRepoRoot = true;
    } catch (error) {
      if (!OPTIONAL_FILE_ERRORS.has(errorCode(error) ?? '')) throw error;
      atRepoRoot = false;
    }
    if (atRepoRoot) return chain;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root reached, no `.git` found
    dir = parent;
  }
  return [cwd];
}

/**
 * The roots to scan, least specific first.
 *
 * Order is precedence: a later root's skill of the same name replaces an
 * earlier one, which is how a project overrides a user-wide skill. It mirrors
 * `loadInstructionChain`'s globals-then-project order for the same reason.
 */
export async function skillRoots(
  io: Pick<SkillCatalogFiles, 'stat'>,
  config: SkillsConfig
): Promise<readonly SkillRoot[]> {
  const home = config.home ?? homedir();
  const roots: SkillRoot[] = [];
  const enabled = resolveSettingSources(config);
  if (config.agentDir && enabled.user)
    roots.push({ path: join(config.agentDir, 'skills'), scope: 'user', rootMarkdown: true });
  // decision 008 — `~/.agents/skills` is the user tier's second root, so the
  // switch has to reach it too; leaving it unconditional would have made
  // "settingSources without user" mean "half the user tier".
  if (enabled.user)
    roots.push({ path: join(home, '.agents', 'skills'), scope: 'user', rootMarkdown: false });
  if (config.cwd && enabled.project) {
    roots.push({ path: join(config.cwd, '.pi', 'skills'), scope: 'project', rootMarkdown: true });
    // Decision 004: `.agents/skills` is looked up from cwd through every
    // ancestor to the repo root, same as pi. Repo-root first (least
    // specific), cwd last — `loadSkills` is last-wins, so a name declared
    // closer to the work overrides one declared further away.
    const chain = await projectSkillDirectories(io, config.cwd);
    for (const dir of [...chain].reverse()) {
      roots.push({ path: join(dir, '.agents', 'skills'), scope: 'project', rootMarkdown: false });
    }
  }
  roots.push(...(config.extraSkillRoots ?? []));
  return roots;
}

export function templateRoots(config: SkillsConfig): readonly TemplateRoot[] {
  const roots: TemplateRoot[] = [];
  const enabled = resolveSettingSources(config);
  if (config.agentDir && enabled.user)
    roots.push({ path: join(config.agentDir, 'prompts'), scope: 'user' });
  if (config.cwd && enabled.project)
    roots.push({ path: join(config.cwd, '.pi', 'prompts'), scope: 'project' });
  roots.push(...(config.extraTemplateRoots ?? []));
  return roots;
}

export interface SkillCatalog {
  skills: readonly RuntimeSkill[];
  templates: readonly RuntimePromptTemplate[];
  diagnostics: readonly SkillDiagnostic[];
  /** skills-mcp-20 — kept so a refresh can re-scan without recomputing config. */
  resolvedSkillRoots: readonly SkillRoot[];
  resolvedTemplateRoots: readonly TemplateRoot[];
}

export async function loadSkillCatalog(
  io: SkillCatalogFiles,
  config: SkillsConfig
): Promise<SkillCatalog> {
  // Descriptions only at scan time; bodies are read on demand by the tool.
  const source = skillSource(io, MAX_SCAN_BYTES);
  const resolvedSkillRoots = await skillRoots(io, config);
  const resolvedTemplateRoots = templateRoots(config);
  const skills = await loadSkills(source, resolvedSkillRoots);
  const templates = await loadPromptTemplates(source, resolvedTemplateRoots);
  return {
    skills: skills.skills,
    templates: templates.templates,
    diagnostics: [...skills.diagnostics, ...templates.diagnostics],
    resolvedSkillRoots,
    resolvedTemplateRoots,
  };
}

/**
 * skills-mcp-20 — re-scan the roots a catalog was built from and answer a
 * replacement for it. The roots are not recomputed: a refresh picks up newly
 * installed skills and templates, not a changed configuration.
 */
export async function rescanSkillCatalog(
  io: SkillCatalogFiles,
  catalog: SkillCatalog
): Promise<SkillCatalog> {
  const source = skillSource(io, MAX_SCAN_BYTES);
  const [skills, templates] = await Promise.all([
    loadSkills(source, catalog.resolvedSkillRoots),
    loadPromptTemplates(source, catalog.resolvedTemplateRoots),
  ]);
  return {
    skills: skills.skills,
    templates: templates.templates,
    diagnostics: [...skills.diagnostics, ...templates.diagnostics],
    resolvedSkillRoots: catalog.resolvedSkillRoots,
    resolvedTemplateRoots: catalog.resolvedTemplateRoots,
  };
}

/**
 * Body of a catalog file, frontmatter stripped. Only catalog paths may reach
 * here: the caller looks the path up by name, never takes it from an argument.
 */
export async function readCatalogBody(
  io: SkillCatalogFiles,
  filePath: string
): Promise<string | undefined> {
  const text = await skillSource(io, Math.max(MAX_SKILL_BYTES, MAX_TEMPLATE_BYTES)).readText(
    filePath
  );
  return text === undefined ? undefined : templateBody(text);
}
