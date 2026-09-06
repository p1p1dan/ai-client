import { join } from 'node:path';
import {
  PI_BORROW_RESOURCES_DIR_ENV,
  PI_BORROW_USER_RESOURCES_SETTING_KEY,
  PI_PROJECT_TRUST_ENV,
} from '@shared/piModelConfig';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T08-c (D-Q9 decision 4) — what each Pi worker is told about project trust.
 *
 * The worker runs in its own process and cannot see the credential mode, so this
 * env var is the whole channel. Two things it must get right, and both are
 * silent when wrong:
 *
 *  - The managed route must send `'0'`. Sending `'1'` (or nothing) lets a
 *    repository the user cloned ship a `.pi/` config that turns the permission
 *    gate off, and nothing on screen would say so.
 *  - The key must be sent in BOTH modes. The per-slot worker treats absence as
 *    untrusted, but local mode still needs an explicit `'1'` to preserve the
 *    user's own project-scoped Pi configuration.
 */

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/aiclient-test' },
  net: { fetch: vi.fn() },
}));

const readSharedSettingsMock = vi.fn(() => ({}) as Record<string, unknown>);
vi.mock('../../SharedSessionState', () => ({
  readSharedSettings: () => readSharedSettingsMock(),
  writeSharedSettings: vi.fn(),
}));

vi.mock('../../auth', () => ({
  getCredentialVault: () => ({ read: () => ({ status: 'missing' }) }),
}));

vi.mock('../../appStatePaths', () => ({ getAppStateRoot: () => '/tmp/aiclient-test/.pilab/dev' }));

async function workerEnv(
  managed: boolean,
  settings: Record<string, unknown> = {}
): Promise<Record<string, string>> {
  readSharedSettingsMock.mockReturnValue({
    credentialMode: managed ? 'managed' : 'local',
    ...settings,
  });
  const { resolveManagedPiWorkerEnv } = await import('../index');
  return resolveManagedPiWorkerEnv();
}

async function ptyEnv(managed: boolean): Promise<Record<string, string>> {
  readSharedSettingsMock.mockReturnValue({ credentialMode: managed ? 'managed' : 'local' });
  const { resolveManagedPiPtyEnv } = await import('../index');
  return resolveManagedPiPtyEnv();
}

describe('resolveManagedPiWorkerEnv — project trust', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  });

  afterEach(() => {
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  });

  it('withholds a repository’s own scope on the managed route', async () => {
    const env = await workerEnv(true);
    expect(env[PI_PROJECT_TRUST_ENV]).toBe('0');
    // The managed route also isolates the agent directory — both keys travel.
    expect(env.PI_CODING_AGENT_DIR).toMatch(/pi-agent$/);
  });

  it('trusts a repository’s own scope on the local route', async () => {
    const env = await workerEnv(false);
    expect(env[PI_PROJECT_TRUST_ENV]).toBe('1');
    // The local route injects nothing else: the user's own ~/.pi stays in play.
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it('always sends the key so both trust postures are explicit', async () => {
    for (const managed of [true, false]) {
      expect(Object.keys(await workerEnv(managed))).toContain(PI_PROJECT_TRUST_ENV);
    }
  });
});

/**
 * R01 — lending the Host the user's own skills and prompt templates.
 *
 * Managed mode moves the agent dir, so anything installed the documented way
 * (under `~/.pi/agent/`) silently stops applying. This env var carries the
 * source directory back, and it doubles as the on/off switch: Main sends a path
 * only when the answer is yes.
 */
describe('resolveManagedPiWorkerEnv — borrowed resources', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    // getLocalPiAgentDir honours this; clearing it keeps the expectation about
    // where the user's own directory lives deterministic on any dev machine.
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it('points the managed route at the user’s own agent dir by default', async () => {
    const env = await workerEnv(true);
    expect(env[PI_BORROW_RESOURCES_DIR_ENV]).toMatch(/[/\\]\.pi[/\\]agent$/);
    // It must not be the managed dir — borrowing that would be a no-op that
    // reads like a working feature.
    expect(env[PI_BORROW_RESOURCES_DIR_ENV]).not.toBe(env.PI_CODING_AGENT_DIR);
  });

  it('sends nothing on the local route, where the agent dir is already the user’s', async () => {
    // Borrowing the directory the Host already loads would list every skill
    // twice.
    expect(await workerEnv(false)).not.toHaveProperty(PI_BORROW_RESOURCES_DIR_ENV);
  });

  it('sends nothing when the user turned it off', async () => {
    const env = await workerEnv(true, { [PI_BORROW_USER_RESOURCES_SETTING_KEY]: false });
    expect(env).not.toHaveProperty(PI_BORROW_RESOURCES_DIR_ENV);
    // The rest of the managed posture is unaffected.
    expect(env[PI_PROJECT_TRUST_ENV]).toBe('0');
  });

  it('treats an absent setting as on', async () => {
    const env = await workerEnv(true, {});
    expect(env[PI_BORROW_RESOURCES_DIR_ENV]).toBeTruthy();
  });

  it('does not put the borrow dir in the PTY environment', async () => {
    // The TUI runs the real pi CLI, which does not read our env var. Leaving it
    // there would claim a borrow that is not happening.
    const pty = await ptyEnv(true);
    expect(pty).not.toHaveProperty(PI_BORROW_RESOURCES_DIR_ENV);
    // The PTY keeps everything else the worker gets.
    expect(pty[PI_PROJECT_TRUST_ENV]).toBe('0');
    expect(pty.PI_CODING_AGENT_DIR).toMatch(/pi-agent$/);
  });

  it('reports the three R04 installation locations from the same path resolvers', async () => {
    readSharedSettingsMock.mockReturnValue({ credentialMode: 'managed' });
    const { getPiResourceSettings } = await import('../index');
    const snapshot = getPiResourceSettings();

    expect(snapshot.managed).toBe(true);
    expect(snapshot.borrowUserPiResources).toBe(true);
    expect(snapshot.paths.sharedSkills).toMatch(/[/\\]\.agents[/\\]skills$/);
    expect(snapshot.paths.userSkills).toMatch(/[/\\]\.pi[/\\]agent[/\\]skills$/);
    expect(snapshot.paths.userPromptTemplates).toMatch(/[/\\]\.pi[/\\]agent[/\\]prompts$/);
    expect(snapshot.paths.managedSkills).toBe(
      join('/tmp/aiclient-test/.pilab/dev', 'pi-agent', 'skills')
    );
    expect(snapshot.paths.managedPromptTemplates).toBe(
      join('/tmp/aiclient-test/.pilab/dev', 'pi-agent', 'prompts')
    );
  });

  it('shows a custom Pi agent dir as the personal resource location', async () => {
    process.env.PI_CODING_AGENT_DIR = '/tmp/custom-pi-agent';
    readSharedSettingsMock.mockReturnValue({ credentialMode: 'managed' });
    const { getPiResourceSettings } = await import('../index');

    expect(getPiResourceSettings().paths).toMatchObject({
      userSkills: join('/tmp/custom-pi-agent', 'skills'),
      userPromptTemplates: join('/tmp/custom-pi-agent', 'prompts'),
    });
  });

  it('opens the prompt directory used by the current credential mode', async () => {
    process.env.PI_CODING_AGENT_DIR = '/tmp/custom-pi-agent';
    const { getActivePiPromptTemplatesDir } = await import('../index');

    readSharedSettingsMock.mockReturnValue({ credentialMode: 'managed' });
    expect(getActivePiPromptTemplatesDir()).toBe(
      join('/tmp/aiclient-test/.pilab/dev', 'pi-agent', 'prompts')
    );

    readSharedSettingsMock.mockReturnValue({ credentialMode: 'local' });
    expect(getActivePiPromptTemplatesDir()).toBe(join('/tmp/custom-pi-agent', 'prompts'));
  });
});
