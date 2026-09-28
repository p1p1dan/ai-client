/**
 * P5-1 — the skills plugin: catalog, prompt slot and the `skill` tool.
 *
 * dsh-rebase P1-16 prep: the roots, the IO adapter and the catalog scan moved
 * to `src/shared/skills/catalog.ts` (the loader, templates and expansion to
 * their shared siblings) and are re-exported below under their old names.
 * What stays here is the runtime's own: the Cordis service, the `skill` tool
 * and its permission gate. P1-12 deletes this file with the runtime.
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

import { type Context, Service } from 'cordis';
import { Type } from 'typebox';
import {
  readCatalogBody,
  rescanSkillCatalog,
  type SkillCatalog,
} from '../../../shared/skills/catalog.ts';
import { HOST_IO_SERVICE } from '../../contracts.ts';
import { PERMISSIONS_SERVICE } from '../permissions/index.ts';
import type { PromptSegment } from '../prompt/segments.ts';
import { TOOLS_SERVICE } from '../tools/index.ts';
import {
  type ExpansionResult,
  expandPrompt,
  parseSlashInvocation,
  type SlashInvocation,
} from './expand.ts';
import type { RuntimeSkill, SkillDiagnostic } from './loader.ts';
import { skillsSegment } from './prompt.ts';
import type { RuntimePromptTemplate } from './templates.ts';

export {
  loadSkillCatalog,
  MAX_SCAN_BYTES,
  MAX_SKILL_BYTES,
  type SkillCatalog,
  type SkillCatalogFiles,
  type SkillsConfig,
  skillRoots,
  skillSource,
  templateRoots,
} from '../../../shared/skills/catalog.ts';

export const SKILLS_SERVICE = 'runtimeSkills';

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
    this.catalog = await rescanSkillCatalog(this.ctx.runtimeHostIo, this.catalog);
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
    return readCatalogBody(this.ctx.runtimeHostIo, filePath);
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
