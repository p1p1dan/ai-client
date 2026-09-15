/**
 * P5-1 — the skills plugin: catalog, prompt slot and the `skill` tool.
 *
 * ## Why the catalog is built before the plugin, not inside it
 *
 * Scanning is IO and Cordis service constructors are synchronous, so this
 * follows the shape `bootstrap.ts` already uses for the session store: the
 * async work happens in {@link loadSkillCatalog} and the plugin wraps the
 * finished value. The alternative — scanning lazily on first `compose()` —
 * would put a directory walk inside the system-prompt build, i.e. inside the
 * measured path of ARD D9's cache gate.
 *
 * ## Why there is a `skill` tool at all
 *
 * pi tells the model to `read` the skill file, which works there because pi has
 * no per-path gate. Here `plugins/permissions/index.ts` answers `ask` for any
 * path outside the session cwd, and skill roots are all outside it. Without
 * this tool, consulting a skill would raise an approval card every time. The
 * tool takes a NAME, looks it up in a catalog that was built from roots the
 * user or the app already trusts, and reads nothing else — so allowing it is
 * not a hole: there is no argument that reaches an arbitrary path.
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Context, Service } from 'cordis';
import { Type } from 'typebox';
import {
  HOST_IO_SERVICE,
  type RuntimeFileKind,
  type RuntimeHostIoService,
} from '../../contracts.ts';
import { errorCode } from '../../host/errors.ts';
import { resolveSettingSources, type SettingSource } from '../../settingSources.ts';
import { PERMISSIONS_SERVICE } from '../permissions/index.ts';
import type { PromptSegment } from '../prompt/segments.ts';
import { TOOLS_SERVICE } from '../tools/index.ts';
import {
  type ExpansionResult,
  expandPrompt,
  parseSlashInvocation,
  type SlashInvocation,
} from './expand.ts';
import {
  loadSkills,
  type RuntimeSkill,
  type SkillDiagnostic,
  type SkillRoot,
  type SkillSource,
} from './loader.ts';
import { skillsSegment } from './prompt.ts';
import {
  loadPromptTemplates,
  MAX_TEMPLATE_BYTES,
  type RuntimePromptTemplate,
  type TemplateRoot,
  templateBody,
} from './templates.ts';

export const SKILLS_SERVICE = 'runtimeSkills';

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

export interface RuntimeSkillsService {
  readonly skills: readonly RuntimeSkill[];
  readonly templates: readonly RuntimePromptTemplate[];
  /** Why a skill or template the user installed is not in the lists above. */
  readonly diagnostics: readonly SkillDiagnostic[];
  /** The `skills` prompt slot, or `undefined` when nothing was found. */
  segment(): PromptSegment | undefined;
  /** `/name` and `/skill:name` → the text actually sent. See `expand.ts`. */
  expand(text: string): Promise<ExpansionResult>;
  /**
   * skills-mcp-20 — re-scan the same roots the catalog was built from and
   * replace it in place. The catalog is otherwise a snapshot taken once at
   * worker start; this is the capability a caller (e.g. a "reload skills"
   * action) needs so a newly installed skill can become visible without a
   * worker restart. Nothing in this plugin calls it automatically — the
   * trigger belongs to whoever surfaces that action.
   */
  refresh(): Promise<void>;
}

declare module 'cordis' {
  interface Context {
    runtimeSkills: RuntimeSkillsService;
  }
}

/**
 * Adapt `runtimeHostIo` to the loader's port (D11: one exit, not per-module
 * `node:fs`). Expected absences answer `undefined`; host/transport failures
 * propagate, because on the encrypted target a read that fails is not the same
 * fact as a user with no skills.
 */
export function skillSource(io: RuntimeHostIoService, maxBytes: number): SkillSource {
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
        const entries: { name: string; kind: RuntimeFileKind }[] = [];
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
  io: Pick<RuntimeHostIoService, 'stat'>,
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
  io: Pick<RuntimeHostIoService, 'stat'>,
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
  /** skills-mcp-20 — kept so `SkillsPlugin.refresh()` can re-scan without recomputing config. */
  resolvedSkillRoots: readonly SkillRoot[];
  resolvedTemplateRoots: readonly TemplateRoot[];
}

export async function loadSkillCatalog(
  io: RuntimeHostIoService,
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

export class SkillsPlugin extends Service implements RuntimeSkillsService {
  static inject = [HOST_IO_SERVICE, TOOLS_SERVICE, PERMISSIONS_SERVICE];
  /** Not `readonly` — {@link refresh} replaces it wholesale after a re-scan. */
  private catalog: SkillCatalog;

  constructor(ctx: Context, catalog: SkillCatalog) {
    super(ctx, SKILLS_SERVICE);
    this.catalog = catalog;
    ctx.runtimeTools.register(
      {
        name: 'skill',
        label: 'Skill',
        description:
          'Load the full instructions of one skill listed in <available_skills>. Takes the skill name, not a path.',
        parameters: Type.Object(
          { name: Type.String({ minLength: 1, maxLength: 64 }) },
          { additionalProperties: false }
        ),
        execute: async (id, args, signal) => {
          const skill = this.catalog.skills.find((item) => item.name === args.name);
          if (!skill) {
            const known = this.catalog.skills.map((item) => item.name).join(', ');
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `No skill named "${args.name}". Available: ${known || '(none)'}`,
                },
              ],
              details: { name: args.name, found: false },
            };
          }
          await this.authorizeSkill(skill, id, signal);
          const body = await this.body(skill.filePath);
          if (body === undefined) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Skill "${skill.name}" could not be read from ${skill.filePath}.`,
                },
              ],
              details: { name: skill.name, path: skill.filePath, found: false },
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                // The location line is what lets the model resolve the skill's
                // own relative references to its scripts and assets.
                text: `<skill name="${skill.name}" location="${skill.filePath}">\n${body}\n</skill>`,
              },
            ],
            details: { name: skill.name, path: skill.filePath, found: true },
          };
        },
      },
      'read'
    );
  }

  get skills() {
    return this.catalog.skills;
  }
  get templates() {
    return this.catalog.templates;
  }
  get diagnostics() {
    return this.catalog.diagnostics;
  }

  segment(): PromptSegment | undefined {
    return skillsSegment(this.catalog.skills);
  }

  expand(text: string): Promise<ExpansionResult> {
    return expandPrompt(text, {
      skills: this.catalog.skills,
      templates: this.catalog.templates,
      readBody: (filePath) => this.body(filePath),
      authorizeSkill: (skill) => this.authorizeSkill(skill, `skill-expand:${skill.name}`),
    });
  }

  async refresh(): Promise<void> {
    const source = skillSource(this.ctx.runtimeHostIo, MAX_SCAN_BYTES);
    const [skills, templates] = await Promise.all([
      loadSkills(source, this.catalog.resolvedSkillRoots),
      loadPromptTemplates(source, this.catalog.resolvedTemplateRoots),
    ]);
    this.catalog = {
      skills: skills.skills,
      templates: templates.templates,
      diagnostics: [...skills.diagnostics, ...templates.diagnostics],
      resolvedSkillRoots: this.catalog.resolvedSkillRoots,
      resolvedTemplateRoots: this.catalog.resolvedTemplateRoots,
    };
  }

  /**
   * T002 — the gate both `/skill:name` and the `skill` tool call before a
   * body is read. `path` is the file's location, for the approval card and
   * the audit row; `policyValue` is the skill's NAME, because a policy is
   * authored against the name the model sees (`"skill": {"librarian":
   * "allow"}`), never the path on disk. `trustedPath: true` is what keeps
   * this from asking by default: the only paths that ever reach here came
   * from `this.catalog`, built by scanning roots the host already trusts, so
   * there is no argument here that reaches an arbitrary file — an explicit
   * `deny` still blocks it, an unconfigured `ask` does not.
   */
  private async authorizeSkill(
    skill: RuntimeSkill,
    toolCallId: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.ctx.runtimePermissions.authorize(
      {
        tool: 'skill',
        toolCallId,
        path: skill.filePath,
        policyValue: skill.name,
        trustedPath: true,
        preview: { label: 'Skill', text: skill.name },
      },
      signal
    );
  }

  /** Body of a catalog file, frontmatter stripped. Only catalog paths reach here. */
  private async body(filePath: string): Promise<string | undefined> {
    const text = await skillSource(
      this.ctx.runtimeHostIo,
      Math.max(MAX_SKILL_BYTES, MAX_TEMPLATE_BYTES)
    ).readText(filePath);
    return text === undefined ? undefined : templateBody(text);
  }
}

export type {
  ExpansionResult,
  RuntimePromptTemplate,
  RuntimeSkill,
  SkillDiagnostic,
  SlashInvocation,
};
export { parseSlashInvocation };
