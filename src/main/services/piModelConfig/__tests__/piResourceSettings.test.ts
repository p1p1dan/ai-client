import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings → Extensions → Skills: the reply Main gives the page.
 *
 * dsh-rebase P1-12 step 1 (decision 147) replaced `piWorkerEnv.test.ts`, whose
 * subject (`resolveManagedPiWorkerEnv`, the native worker's environment) was
 * deleted with the worker. What it also pinned about this reply is kept here:
 * the two skill folders resolve from the same path rules as before, and the
 * fields the page no longer shows are gone rather than left stale.
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/aiclient-test',
    getVersion: () => '9.9.9-test',
  },
  net: { fetch: vi.fn() },
}));

const readSharedSettingsMock = vi.fn(() => ({}) as Record<string, unknown>);
vi.mock('../../SharedSessionState', () => ({
  readSharedSettings: () => readSharedSettingsMock(),
  writeSharedSettings: vi.fn(),
}));

vi.mock('../../auth', () => ({
  getCredentialVault: () => ({
    read: () => ({ status: 'missing' }),
    readUserProviders: () => ({ status: 'absent' }),
  }),
}));

vi.mock('../../appStatePaths', () => ({ getAppStateRoot: () => '/tmp/aiclient-test/.pilab/dev' }));

describe('getPiResourceSettings', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  });

  afterEach(() => {
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    vi.unstubAllEnvs();
  });

  it('reports the two skill folders the DSH host reads, and the route', async () => {
    readSharedSettingsMock.mockReturnValue({ credentialMode: 'managed' });
    const { getPiResourceSettings } = await import('../index');
    const snapshot = getPiResourceSettings();
    expect(snapshot.managed).toBe(true);
    expect(snapshot.paths.sharedSkills).toMatch(/[/\\]\.agents[/\\]skills$/);
    expect(snapshot.paths.appSkills).toBe(
      join('/tmp/aiclient-test/.pilab/dev', 'pi-agent', 'skills')
    );
  });

  it('uses an overridden HOME for the shared folder the open-skills handler opens', async () => {
    vi.stubEnv('HOME', '/tmp/b1-home-override');
    const { getPiResourceSettings } = await import('../index');
    expect(getPiResourceSettings().paths.sharedSkills).toBe(
      join('/tmp/b1-home-override', '.agents', 'skills')
    );
  });

  it('no longer reports delegation, prompt templates or the user’s own ~/.pi folders', async () => {
    readSharedSettingsMock.mockReturnValue({ credentialMode: 'local', enablePiSubagents: false });
    const { getPiResourceSettings } = await import('../index');
    const snapshot = getPiResourceSettings();
    expect(Object.keys(snapshot).sort()).toEqual(['managed', 'paths']);
    expect(Object.keys(snapshot.paths).sort()).toEqual(['appSkills', 'sharedSkills']);
  });

  it('exports no native worker environment builder any more', async () => {
    const module = await import('../index');
    expect(module).not.toHaveProperty('resolveManagedPiWorkerEnv');
    expect(module).not.toHaveProperty('resolveManagedPiPtyEnv');
    expect(module).not.toHaveProperty('getActivePiPromptTemplatesDir');
  });
});
