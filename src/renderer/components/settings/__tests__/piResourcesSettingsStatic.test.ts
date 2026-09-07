import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

const componentPath = join(__dirname, '..', 'PiResourcesSettings.tsx');
const component = stripComments(readFileSync(componentPath, 'utf8'), componentPath);
const contentPath = join(__dirname, '..', 'SettingsContent.tsx');
const settingsContent = stripComments(readFileSync(contentPath, 'utf8'), contentPath);

describe('R04 Pi resource settings', () => {
  it('shows the three installation locations using paths resolved by Main', () => {
    expect(component).toContain('snapshot.paths.sharedSkills');
    expect(component).toContain('snapshot.paths.userSkills');
    expect(component).toContain('snapshot.paths.userPromptTemplates');
    expect(component).toContain('snapshot.paths.managedSkills');
    expect(component).toContain('snapshot.paths.managedPromptTemplates');
    expect(component).not.toContain("'~/.pilab");
    expect(component).not.toContain("'~/.pi");
  });

  it('wires the switches and managed prompt-folder action through the narrow bridge', () => {
    expect(component).toContain('window.electronAPI.piResources.getSettings()');
    expect(component).toContain('window.electronAPI.piResources.updateSettings(patch)');
    expect(component).toContain('window.electronAPI.piResources.openPromptTemplates()');
    expect(component).not.toContain('window.electronAPI.settings.write');
  });

  /**
   * Two switches, one writer, one field per call. A toggle that sent the whole
   * snapshot back would carry the OTHER switch's value from whenever the page
   * last loaded, so flipping one could silently revert the other.
   */
  it('sends one field per toggle rather than the whole snapshot', () => {
    expect(component).toContain('update({ borrowUserPiResources: checked })');
    expect(component).toContain('update({ enableSubagents: checked })');
    expect(component).toContain('checked={snapshot.borrowUserPiResources}');
    expect(component).toContain('checked={snapshot.enableSubagents}');
  });

  it('is a Settings category, not a new workspace navigation surface', () => {
    expect(settingsContent).toContain("id: 'piResources'");
    expect(settingsContent).toContain("activeCategory === 'piResources'");
    expect(settingsContent).toContain('<PiResourcesSettings />');
  });
});
