// Thin re-export (dsh-rebase P1-16 prep): the skill loader lives in src/shared/skills/loader.ts
// (frontmatter reader in src/shared/skills/frontmatter.ts).
export {
  type FrontmatterReport,
  type LoadedSkills,
  loadSkills,
  MAX_DESCRIPTION_BYTES,
  MAX_SKILL_DEPTH,
  MAX_SKILLS,
  parseFrontmatter,
  type RuntimeSkill,
  resolveEntryKind,
  type SkillDiagnostic,
  type SkillDiagnosticCode,
  type SkillFrontmatter,
  type SkillRoot,
  type SkillScope,
  type SkillSource,
} from '../../../shared/skills/loader.ts';
