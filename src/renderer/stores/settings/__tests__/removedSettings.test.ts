import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupLegacyFields, migrateSettings } from '../migration';

vi.mock('@/lib/ghosttyTheme', () => ({}));
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('../storage', () => ({
  electronStorage: {
    // Keep automatic hydration pending; tests explicitly exercise migration.
    getItem: () => new Promise(() => {}),
  },
}));

const removedKeys = [
  'showToolDiff',
  'layoutMode',
  'fileTreeDisplayMode',
  'repositoryListDisplayMode',
  'quickTerminal',
  'hideGroups',
  'hiddenOpenInApps',
  'openInMenuFilterEnabled',
  'glowEffectEnabled',
  'mainTabKeybindings',
  'globalKeybindings',
  'workspaceKeybindings',
  'settingsDisplayMode',
  'settingsModalPosition',
  'useOpenChamberShell',
  'agentNotificationEnabled',
  'agentNotificationDelay',
  'agentNotificationEnterDelay',
  'fileTreeAutoReveal',
  'terminalInput',
];

const legacyProfile = {
  ...Object.fromEntries(removedKeys.map((key) => [key, true])),
  language: 'zh' as const,
  terminalScrollback: 5000,
  agentNotificationEnabled: false,
  agentNotificationDelay: 10,
  agentNotificationEnterDelay: 3,
  fileTreeAutoReveal: false,
  terminalInput: { enhancedInputEnabled: true, enhancedInputAutoPopup: 'always' },
  claudeCodeIntegration: { enhancedInputEnabled: true, enhancedInputAutoPopup: true },
};

afterEach(() => vi.unstubAllGlobals());

describe('S04/S06 removed settings', () => {
  it('cannot reintroduce removed settings through types, defaults, setters or UI', () => {
    for (const file of ['../types.ts', '../defaults.ts', '../index.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const key of removedKeys) expect(source).not.toContain(key);
      expect(source).not.toMatch(/setAgentNotification|setFileTreeAutoReveal|setTerminalInput/);
    }
    const panel = readFileSync(
      new URL('../../../components/settings/GeneralSettings.tsx', import.meta.url),
      'utf8'
    );
    expect(panel).not.toContain('Agent Notifications');
    expect(panel).not.toContain('agentNotification');
  });

  it('hydrates old profiles without restoring removed fields or losing active settings', async () => {
    vi.stubGlobal('window', { electronAPI: { env: { platform: 'linux' } } });
    const { useSettingsStore } = await import('../index');
    const current = useSettingsStore.getState();
    const persisted = {
      ...legacyProfile,
      editorSettings: { ...current.editorSettings, fontSize: 18 },
      proxySettings: { ...current.proxySettings, enabled: true },
      searchKeybindings: {
        searchFiles: { key: 'k', ctrl: true },
        searchContent: { key: 'j', alt: true },
      },
      commitMessageGenerator: {
        ...current.commitMessageGenerator,
        model: 'pilab/custom-model',
        prompt: 'custom commit prompt',
      },
    };
    const migrated = migrateSettings(persisted, current);

    for (const key of [...removedKeys, 'claudeCodeIntegration']) {
      expect(migrated).not.toHaveProperty(key);
    }
    expect(migrated.language).toBe('zh');
    expect(migrated.terminalScrollback).toBe(5000);
    expect(migrated.editorSettings).toEqual(persisted.editorSettings);
    expect(migrated.proxySettings).toEqual(persisted.proxySettings);
    expect(migrated.searchKeybindings).toEqual(persisted.searchKeybindings);
    expect(migrated.commitMessageGenerator).toEqual(persisted.commitMessageGenerator);
    expect(migrated.setTheme).toBe(current.setTheme);
    expect(persisted).toHaveProperty('terminalInput');
    expect(migrateSettings(undefined, current)).toBe(current);
    expect(migrateSettings(migrated, current)).toEqual(migrated);
  });

  it('cleans old keys from disk without changing other settings or namespaces', async () => {
    const state = structuredClone(legacyProfile);
    const data = { 'aiclient-settings': { state, version: 0 }, other: { retained: true } };
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      electronAPI: { settings: { read: vi.fn().mockResolvedValue(data), write } },
    });

    await cleanupLegacyFields();

    expect(write).toHaveBeenCalledExactlyOnceWith({
      'aiclient-settings': { state: { language: 'zh', terminalScrollback: 5000 }, version: 0 },
      other: { retained: true },
    });
    await cleanupLegacyFields();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
