import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetManagedFileWriterQueuesForTests } from '../../auth/managedFileWriter';
import { getEnabledPlugins, setPluginEnabled } from '../PluginsManager';

describe('PluginsManager (D47 S2a §1)', () => {
  let homeDir: string;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'plugins-manager-'));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.CLAUDE_CONFIG_DIR;
    resetManagedFileWriterQueuesForTests();
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  function legacySettingsPath(): string {
    return path.join(homeDir, '.claude', 'settings.json');
  }

  it('legacy path is ~/.claude/settings.json when CLAUDE_CONFIG_DIR is unset', async () => {
    const ok = await setPluginEnabled('my-plugin@marketplace', true);
    expect(ok).toBe(true);
    expect(existsSync(legacySettingsPath())).toBe(true);
    expect(getEnabledPlugins()).toEqual({ 'my-plugin@marketplace': true });
  });

  it('follows CLAUDE_CONFIG_DIR when set (managed redirect)', async () => {
    const managedDir = mkdtempSync(path.join(os.tmpdir(), 'plugins-manager-managed-'));
    process.env.CLAUDE_CONFIG_DIR = managedDir;
    try {
      const ok = await setPluginEnabled('my-plugin@marketplace', true);
      expect(ok).toBe(true);
      expect(existsSync(path.join(managedDir, 'settings.json'))).toBe(true);
      expect(existsSync(legacySettingsPath())).toBe(false);
    } finally {
      rmSync(managedDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'goes through managedFileWriter: settings.json ends up 0600',
    async () => {
      await setPluginEnabled('my-plugin@marketplace', true);
      const mode = statSync(legacySettingsPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  );

  it('preserves foreign top-level keys already in settings.json', async () => {
    mkdirSync(path.dirname(legacySettingsPath()), { recursive: true });
    writeFileSync(
      legacySettingsPath(),
      JSON.stringify({ hooks: { Stop: ['x'] }, theme: 'dark' }),
      'utf-8'
    );

    await setPluginEnabled('my-plugin@marketplace', true);

    const doc = JSON.parse(readFileSync(legacySettingsPath(), 'utf-8'));
    expect(doc.hooks).toEqual({ Stop: ['x'] });
    expect(doc.theme).toBe('dark');
    expect(doc.enabledPlugins).toEqual({ 'my-plugin@marketplace': true });
  });
});
