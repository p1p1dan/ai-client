import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

const componentPath = join(__dirname, '..', 'PiResourcesSettings.tsx');
const component = stripComments(readFileSync(componentPath, 'utf8'), componentPath);
const contentPath = join(__dirname, '..', 'SettingsContent.tsx');
const settingsContent = stripComments(readFileSync(contentPath, 'utf8'), contentPath);

describe('R04 Pi resource settings', () => {
  it('labels shared skills as default and provides a narrow folder action', () => {
    expect(component).toContain("t('Default')");
    expect(component).toContain("t('Open skills folder')");
    expect(component).toContain('window.electronAPI.piResources.openSkills()');
  });

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
    expect(component).toContain('update({ optInFeatures: { [feature.id]: checked } })');
    expect(component).toContain('checked={snapshot.borrowUserPiResources}');
    expect(component).toContain('checked={feature.enabled}');
  });

  it('lives in the Pi Settings category, not a new workspace navigation surface', () => {
    expect(settingsContent).toContain("id: 'pi'");
    expect(settingsContent).toContain("activeCategory === 'pi'");
    expect(settingsContent).toContain('<PiResourcesSettings />');
  });
});
