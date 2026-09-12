/**
 * P5-1 — the `skills` prompt slot.
 *
 * The block is pi's (`harness/system-prompt.js`, `formatSkillsForSystemPrompt`)
 * and follows agentskills.io's integrate-skills shape, so a skill author's
 * expectations about what the model sees carry over. One sentence differs and
 * it is the load-bearing one: pi tells the model to `read` the skill file,
 * because in pi the skill roots sit inside the same permission world as the
 * workspace. Here they do not — `plugins/permissions/index.ts` answers `ask`
 * for any path outside the session cwd, so a `read` of
 * `<agentDir>/skills/foo/SKILL.md` would put a permission card in front of the
 * user every single time a skill is consulted. So the model is pointed at the
 * `skill` tool, which loads by NAME out of the already-scanned catalog and can
 * therefore be allowed without a prompt.
 *
 * `location` is still published, because a skill's own body references its
 * assets by relative path and the model needs the directory to resolve them.
 */

import type { PromptSegment } from '../prompt/segments.ts';
import type { RuntimeSkill } from './loader.ts';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function skillsSegment(skills: readonly RuntimeSkill[]): PromptSegment | undefined {
  if (skills.length === 0) return undefined;
  const lines = [
    'The following skills provide specialized instructions for specific tasks.',
    'Call the `skill` tool with a skill name to load its full instructions when the task matches its description.',
    'When a skill references a relative path, resolve it against that skill directory (the parent of its location) and use the absolute path in tool calls.',
    '',
    '<available_skills>',
  ];
  for (const skill of skills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return { slot: 'skills', text: lines.join('\n') };
}
