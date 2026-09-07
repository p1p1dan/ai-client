import { join } from 'node:path';
import {
  PI_BORROW_RESOURCES_DIR_ENV,
  PI_BORROW_USER_RESOURCES_SETTING_KEY,
  PI_ENABLE_SUBAGENTS_SETTING_KEY,
  PI_OPT_IN_EXTENSIONS_ENV,
  PI_PROJECT_TRUST_ENV,
  PI_SUBAGENTS_FEATURE_ID,
  PI_USER_AGENT_ENV,
  PI_USER_AGENT_PRODUCT,
  piUserAgent,
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

const APP_VERSION = '9.9.9-test';

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
    // The two switches on this page have OPPOSITE defaults; asserting both here
    // is what keeps a future "make the defaults consistent" tidy-up honest.
    expect(snapshot.enableSubagents).toBe(false);
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

/**
 * Opt-in bundled extensions — the sub-agent switch.
 *
 * Default OFF, unlike borrowing. The reason is cost, not safety: the
 * extension's three tool schemas are written into the cached prefix of every
 * request, so a session that never delegates still pays for them on every turn
 * (measured 2026-09-07: 4.8 KB of an 11.4 KB tool payload).
 */
describe('resolveManagedPiWorkerEnv — opt-in extensions', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it('sends nothing in either mode when the setting is absent', async () => {
    for (const managed of [true, false]) {
      expect(await workerEnv(managed)).not.toHaveProperty(PI_OPT_IN_EXTENSIONS_ENV);
    }
  });

  it('names the feature in BOTH modes once it is on', async () => {
    // Unlike the borrow directory, this is not a managed-mode repair: the
    // bundled copy is injected on the local route too, so the switch has to
    // reach both.
    for (const managed of [true, false]) {
      const env = await workerEnv(managed, { [PI_ENABLE_SUBAGENTS_SETTING_KEY]: true });
      expect(env[PI_OPT_IN_EXTENSIONS_ENV]).toBe(PI_SUBAGENTS_FEATURE_ID);
    }
  });

  it('reads only an explicit true, so a stray value stays off', async () => {
    for (const stored of [false, 'true', 1, null]) {
      const env = await workerEnv(true, { [PI_ENABLE_SUBAGENTS_SETTING_KEY]: stored });
      expect(env).not.toHaveProperty(PI_OPT_IN_EXTENSIONS_ENV);
    }
  });

  it('keeps it out of the PTY environment', async () => {
    // Same rule as the borrow dir: the real pi CLI does not read our env var,
    // and leaving it there would claim an extension the TUI is not loading.
    readSharedSettingsMock.mockReturnValue({
      credentialMode: 'managed',
      [PI_ENABLE_SUBAGENTS_SETTING_KEY]: true,
    });
    const { resolveManagedPiPtyEnv } = await import('../index');
    expect(resolveManagedPiPtyEnv()).not.toHaveProperty(PI_OPT_IN_EXTENSIONS_ENV);
  });
});

/**
 * F08 — the User-Agent every Pi request presents.
 *
 * The `models.json` this client writes references this variable by name, so a
 * missing or wrong value does not fail loudly: the header simply goes out empty
 * or, worse, pi's own default (`pi (win32 10.0.26100; x64)`) survives and the
 * gateway cannot tell an app request from a CLI one.
 */
describe('resolveManagedPiWorkerEnv — client User-Agent', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it('carries the app version in BOTH credential modes', async () => {
    for (const managed of [true, false]) {
      const env = await workerEnv(managed);
      expect(env[PI_USER_AGENT_ENV]).toBe(`${PI_USER_AGENT_PRODUCT}/${APP_VERSION}`);
    }
  });

  it('reaches the PTY too, unlike the borrow dir and the opt-in list', async () => {
    // Those two are dropped because the real pi CLI does not read them. This
    // one it DOES read — out of the `headers` block of the same models.json a
    // managed TUI session loads — so a PTY turn must identify itself the same
    // way a worker turn does.
    expect((await ptyEnv(true))[PI_USER_AGENT_ENV]).toBe(`${PI_USER_AGENT_PRODUCT}/${APP_VERSION}`);
  });

  it('never emits a dangling slash when a version is unavailable', async () => {
    expect(piUserAgent('')).toBe(PI_USER_AGENT_PRODUCT);
    expect(piUserAgent('  0.4.0  ')).toBe(`${PI_USER_AGENT_PRODUCT}/0.4.0`);
  });

  it('does not identify itself as the pi CLI or leak the host platform', async () => {
    const value = (await workerEnv(true))[PI_USER_AGENT_ENV];
    expect(value.startsWith('pi ')).toBe(false);
    expect(value).not.toMatch(/win32|darwin|linux|x64|arm64/);
  });
});
