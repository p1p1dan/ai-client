// Thin re-export (dsh-rebase P1-16 prep): prompt templates live in src/shared/skills/templates.ts.
export {
  type LoadedTemplates,
  loadPromptTemplates,
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATES,
  type RuntimePromptTemplate,
  type TemplateRoot,
  templateBody,
} from '../../../shared/skills/templates.ts';
