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

  it('shows every installation location using paths resolved by Main', () => {
    expect(component).toContain('snapshot.paths.sharedSkills');
    expect(component).toContain('snapshot.paths.userSkills');
    expect(component).toContain('snapshot.paths.userPromptTemplates');
    expect(component).toContain('snapshot.paths.appSkills');
    expect(component).toContain('snapshot.paths.appPromptTemplates');
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
   * One writer, one field per call. A toggle that sent the whole snapshot back
   * would carry every OTHER switch's value from whenever the page last loaded,
   * so flipping one could silently revert another.
   */
  it('sends one field per toggle rather than the whole snapshot', () => {
    expect(component).toContain('update({ optInFeatures: { [feature.id]: checked } })');
    expect(component).toContain('checked={feature.enabled}');
  });

  /**
   * cutover-10 — the switch renders what Main reports and nothing else.
   *
   * `enabled` is resolved by the same function the worker's wiring asks, so the
   * page cannot disagree with the runtime. A `defaultEnabled` read here, or a
   * section still called "bundled extensions", would be the reintroduction of
   * the split that made a fresh install see "off" while every turn registered
   * the delegation tools.
   */
  it('renders the native feature switches without a second idea of the default', () => {
    expect(component).toContain('snapshot.features.map');
    expect(component).not.toContain('bundledFeatures');
    expect(component).not.toContain('defaultEnabled');
    expect(component).toContain("t('Agent features')");
    expect(component).not.toContain("t('Bundled extensions')");
  });

  /**
   * H/19 removed the borrow switch. The page must not offer a control for a
   * mechanism that no longer exists — it would save a setting nothing reads.
   */
  it('no longer offers the borrow-resources switch', () => {
    expect(component).not.toContain('borrowUserPiResources');
  });

  /**
   * Still a Settings category, not a workspace navigation surface of its own.
   *
   * The page moved from `pi` to `extensions` when the Pi page was split: three
   * panels that extend the agent (plugins, resources, subagents) are one topic,
   * and stacking them under the model settings was most of what made that page
   * unreadable.
   */
  it('lives in the Extensions Settings category, not a new workspace navigation surface', () => {
    expect(settingsContent).toContain("id: 'extensions'");
    expect(settingsContent).toContain("activeCategory === 'extensions'");
    expect(settingsContent).toContain('<PiResourcesSettings />');
  });

  /** H/19 U2 and U4's two sections, each now on the page it belongs to. */
  it('keeps the plugin section beside it and the migration section on its own page', () => {
    expect(settingsContent).toContain('<PiPluginsSettings />');
    expect(settingsContent).toContain("id: 'migration'");
    expect(settingsContent).toContain("activeCategory === 'migration'");
    expect(settingsContent).toContain('<AgentMigrationSettings />');
  });
});
