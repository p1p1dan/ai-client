import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

const componentPath = join(__dirname, '..', 'PiResourcesSettings.tsx');
const component = stripComments(readFileSync(componentPath, 'utf8'), componentPath);
const contentPath = join(__dirname, '..', 'SettingsContent.tsx');
const settingsContent = stripComments(readFileSync(contentPath, 'utf8'), contentPath);

/**
 * Settings → Extensions → Skills.
 *
 * dsh-rebase P1-16e (decision 104 rule 3) narrowed this page to the two skill
 * folders the DSH host reads — `<agentDir>/skills` (`customSkillDirs`,
 * decision 101) and `~/.agents/skills` — plus DSH's skill rules. What it lost
 * is pinned absent here, because each of those controls would now write a
 * setting or open a folder nothing reads.
 */
describe('Skills settings (Resources page, DSH build)', () => {
  it('shows both skill folders using paths resolved by Main', () => {
    expect(component).toContain('snapshot.paths.appSkills');
    expect(component).toContain('snapshot.paths.sharedSkills');
    expect(component).not.toContain("'~/.pilab");
    expect(component).not.toContain("'~/.agents");
  });

  it('opens each folder through its own narrow bridge call', () => {
    expect(component).toContain('window.electronAPI.piResources.getSettings()');
    expect(component).toContain('window.electronAPI.piResources.openAppSkills()');
    expect(component).toContain('window.electronAPI.piResources.openSkills()');
  });

  it('states DSH’s skill rules', () => {
    expect(component).toContain("t('How a skill is found')");
    expect(component).toContain('<name>/SKILL.md, or a single <name>.md');
    expect(component).toContain('lowercase letters, digits and dashes only');
    expect(component).toContain('Type /<name> anywhere in a message');
  });

  it('offers no prompt-template folder (decision 103)', () => {
    expect(component).not.toContain('openPromptTemplates');
    expect(component).not.toContain('appPromptTemplates');
    expect(component).not.toContain('userPromptTemplates');
    expect(component).not.toMatch(/t\('Prompt templates'\)/);
  });

  it('offers no delegation switch (decision 105) and writes no setting', () => {
    expect(component).not.toContain('snapshot.features');
    expect(component).not.toContain('updateSettings');
    expect(component).not.toContain('optInFeatures');
    expect(component).not.toContain('<Switch');
    expect(component).not.toContain("t('Agent features')");
    expect(component).not.toContain('window.electronAPI.settings.write');
  });

  it('no longer shows the personal ~/.pi/agent folders nothing loads', () => {
    expect(component).not.toContain('snapshot.paths.userSkills');
    expect(component).not.toContain("t('Your personal Pi directory')");
  });

  /**
   * Still a Settings category, not a workspace navigation surface of its own.
   */
  it('lives in the Extensions Settings category next to the legacy-asset entry', () => {
    expect(settingsContent).toContain("id: 'extensions'");
    expect(settingsContent).toContain("activeCategory === 'extensions'");
    expect(settingsContent).toContain('<PiResourcesSettings />');
    expect(settingsContent).toContain('<LegacyAssetsSettings repoPath={repoPath} />');
  });

  /**
   * Decision 104 rule 3 and decision 090: the sub-agent page and the pi
   * extension page are gone from Extensions. Their files stay until P1-12.
   */
  it('mounts neither the sub-agent page nor the pi extension page', () => {
    expect(settingsContent).not.toContain('PiSubagentsSettings');
    expect(settingsContent).not.toContain('PiPluginsSettings');
  });

  it('keeps the migration sections on their own page', () => {
    expect(settingsContent).toContain("id: 'migration'");
    expect(settingsContent).toContain("activeCategory === 'migration'");
    expect(settingsContent).toContain('<AgentMigrationSettings />');
  });
});
