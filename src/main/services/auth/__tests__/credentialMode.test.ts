import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_MODE_SETTING_KEY } from '@shared/credentialMode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = { userDataPath: '/unset', isPackaged: false };

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : tmpdir())),
  },
}));

/**
 * D64 / S3 — the electron-reading half: where the choice is stored, and that
 * writing one does not disturb what is stored beside it.
 *
 * The RULE (precedence, the first-run default, the dev-only override) is pure
 * and tested in `shared/__tests__/credentialMode.test.ts`. What can only be
 * asserted here is the file.
 */
describe('credential mode — persistence', () => {
  let home: string;
  const originalHome = process.env.HOME;
  const originalEnv = process.env.AICLIENT_MANAGED_CREDENTIALS;

  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), 'aiclient-credmode-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    state.userDataPath = join(home, '.config', 'jyw-ai-client');
    state.isPackaged = false;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalEnv === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    else process.env.AICLIENT_MANAGED_CREDENTIALS = originalEnv;
    rmSync(home, { recursive: true, force: true });
  });

  const settingsPath = () => join(home, '.pilab', 'jyw-ai-client', 'settings.json');

  it('a machine with nothing recorded resolves to managed — the first run signs in', async () => {
    const mod = await import('../credentialMode');
    expect(mod.getCredentialMode()).toBe('managed');
    expect(mod.resolveManagedCredentialsEnabled()).toBe(true);
  });

  it('round-trips a written choice through the real settings file', async () => {
    const mod = await import('../credentialMode');

    expect(mod.setCredentialMode('local')).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath(), 'utf-8'))[CREDENTIAL_MODE_SETTING_KEY]).toBe(
      'local'
    );

    vi.resetModules();
    const reloaded = await import('../credentialMode');
    expect(reloaded.getCredentialMode()).toBe('local');
  });

  /**
   * The file also holds the user's own preferences and the onboarding state —
   * and since S2 it sits in the same directory as the credential vault. A
   * whole-file write here would be one misordered call away from erasing them.
   */
  it('merges into the file rather than replacing it', async () => {
    const { writeSharedSettings } = await import('../../SharedSessionState');
    writeSharedSettings({
      onboarding: { registered: true, email: 'a@b.c' },
      theme: 'dark',
    });

    const mod = await import('../credentialMode');
    mod.setCredentialMode('local');

    expect(JSON.parse(readFileSync(settingsPath(), 'utf-8'))).toEqual({
      onboarding: { registered: true, email: 'a@b.c' },
      theme: 'dark',
      [CREDENTIAL_MODE_SETTING_KEY]: 'local',
    });
  });

  /** The caller uses this to decide whether a Host restart is warranted. */
  it('reports whether the value actually changed', async () => {
    const mod = await import('../credentialMode');
    expect(mod.setCredentialMode('local')).toBe(true);
    expect(mod.setCredentialMode('local')).toBe(false);
    expect(mod.setCredentialMode('managed')).toBe(true);
  });

  /**
   * The reason the env flag had to stop being the switch (D58's reasoning,
   * D64's ruling): a packaged user cannot set one, so one must not decide
   * their behaviour. Asserted against the REAL file, not just the pure rule.
   */
  it('ignores the dev override in a packaged build', async () => {
    const mod = await import('../credentialMode');
    mod.setCredentialMode('local');
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';

    state.isPackaged = false;
    expect(mod.getCredentialMode()).toBe('managed');

    state.isPackaged = true;
    expect(mod.getCredentialMode()).toBe('local');
  });
});
