// Thin re-export (dsh-rebase P1-16 prep): slash expansion lives in src/shared/skills/expand.ts.
export {
  type ExpansionCatalog,
  type ExpansionResult,
  expandPrompt,
  formatSkillInvocation,
  parseCommandArgs,
  parseSlashInvocation,
  type SlashInvocation,
  substituteArgs,
} from '../../../shared/skills/expand.ts';
