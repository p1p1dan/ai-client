import { join } from 'node:path';
import {
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
 * T08-c (D-Q9 decision 4) — the managed-route marker each child process is
 * handed.
 *
 * decision 009 narrowed what this variable decides, and the docblock is worth
 * keeping honest about it. It is no longer the native worker's project trust:
 * that is a constant now (`NATIVE_PROJECT_TRUSTED`), so a company-account
 * session reads the repository's MCP servers, skills, permission policy and
 * instruction files exactly as a personal one does. Nor is it read by the `pi`
 * CLI — that package has no such variable, and resolves project trust from its
 * own `--approve` flag, `trust.json` and `defaultProjectTrust` setting.
 *
 * What is left is a marker of the credential route, and one consumer:
 * `PiTuiPty` strips inherited credential variables out of a PTY when it reads
 * `'0'`. The value is still pinned here because that consumer is a security
 * behaviour — a company-account terminal must not inherit the gateway key —
 * and because sending the key in BOTH modes is what keeps an absent key
 * meaning "old Main build" rather than "local route".
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

/**
 * `readUserProviders` is stubbed alongside `read` because the derived-config
 * writer asks for the user's services. `absent` is an empty group.
 *
 * H/19 note: it no longer decides anything about the agent directory — that
 * branch is gone. The stub stays because the module still reads the vault.
 */
const readUserProvidersMock = vi.fn(() => ({ status: 'absent' }) as { status: string });
vi.mock('../../auth', () => ({
  getCredentialVault: () => ({
    read: () => ({ status: 'missing' }),
    readUserProviders: () => readUserProvidersMock(),
  }),
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

  it('marks the managed route, which is what strips PTY credentials', async () => {
    const env = await workerEnv(true);
    expect(env[PI_PROJECT_TRUST_ENV]).toBe('0');
    // The managed route also isolates the agent directory — both keys travel.
    expect(env.PI_CODING_AGENT_DIR).toMatch(/pi-agent$/);
  });

  it('marks the local route, which keeps a PTY’s inherited environment', async () => {
    const env = await workerEnv(false);
    expect(env[PI_PROJECT_TRUST_ENV]).toBe('1');
    // H/19: the local route ALSO runs out of this app's agent directory. Trust
    // and directory are now independent — the one thing the old conditional
    // branch made impossible to state separately.
    expect(env.PI_CODING_AGENT_DIR).toMatch(/pi-agent$/);
  });

  it('always sends the key so an absent one can only mean an old build', async () => {
    for (const managed of [true, false]) {
      expect(Object.keys(await workerEnv(managed))).toContain(PI_PROJECT_TRUST_ENV);
    }
  });
});

/**
 * H/19 — one agent directory, in both modes.
 *
 * The whole R01 "borrow the user's own skills" mechanism used to live here. It
 * existed because managed mode moved the agent dir and silently unloaded
 * everything the user had installed. Both halves of that are gone: the
 * directory no longer moves per mode, and what the user has is brought over by
 * an explicit copy (`services/agentMigration`) rather than read through.
 */
describe('resolveManagedPiWorkerEnv — agent directory', () => {
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

  it('sends the same directory in both modes', async () => {
    const managed = await workerEnv(true);
    const local = await workerEnv(false);
    expect(managed.PI_CODING_AGENT_DIR).toBe(local.PI_CODING_AGENT_DIR);
    expect(managed.PI_CODING_AGENT_DIR).toBe(join('/tmp/aiclient-test/.pilab/dev', 'pi-agent'));
  });

  it('never points a session at the user’s own ~/.pi/agent', async () => {
    for (const managed of [true, false]) {
      expect((await workerEnv(managed)).PI_CODING_AGENT_DIR).not.toMatch(/[/\\]\.pi[/\\]agent$/);
    }
  });

  it('sends no borrow directory at all — the mechanism is gone', async () => {
    for (const managed of [true, false]) {
      expect(await workerEnv(managed)).not.toHaveProperty('AICLIENT_PI_BORROW_RESOURCES_DIR');
    }
  });

  it('gives the PTY the same agent directory as the worker', async () => {
    // The TUI runs the real pi CLI, which DOES read PI_CODING_AGENT_DIR. That
    // is what makes GUI and TUI find the same sessions (U3).
    for (const managed of [true, false]) {
      const pty = await ptyEnv(managed);
      const worker = await workerEnv(managed);
      expect(pty.PI_CODING_AGENT_DIR).toBe(worker.PI_CODING_AGENT_DIR);
      expect(pty[PI_PROJECT_TRUST_ENV]).toBe(managed ? '0' : '1');
    }
  });

  it('still drops the opt-in extension list from the PTY environment', async () => {
    // That one IS read by our Host code only, so leaving it in the real CLI's
    // environment would claim an injection that is not happening.
    readSharedSettingsMock.mockReturnValue({
      credentialMode: 'managed',
      [PI_ENABLE_SUBAGENTS_SETTING_KEY]: true,
    });
    const { resolveManagedPiWorkerEnv, resolveManagedPiPtyEnv } = await import('../index');
    expect(resolveManagedPiWorkerEnv()[PI_OPT_IN_EXTENSIONS_ENV]).toBeTruthy();
    expect(resolveManagedPiPtyEnv()).not.toHaveProperty(PI_OPT_IN_EXTENSIONS_ENV);
  });

  it('uses an overridden HOME for the shared folder exposed to the open-skills handler', async () => {
    vi.stubEnv('HOME', '/tmp/b1-home-override');
    try {
      const { getPiResourceSettings } = await import('../index');
      expect(getPiResourceSettings().paths.sharedSkills).toBe(
        join('/tmp/b1-home-override', '.agents', 'skills')
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports the three R04 installation locations from the same path resolvers', async () => {
    readSharedSettingsMock.mockReturnValue({ credentialMode: 'managed' });
    const { getPiResourceSettings } = await import('../index');
    const snapshot = getPiResourceSettings();

    expect(snapshot.managed).toBe(true);
    expect(snapshot.enableSubagents).toBe(false);
    expect(snapshot.paths.sharedSkills).toMatch(/[/\\]\.agents[/\\]skills$/);
    // The user's own directory is still REPORTED — it is the migration source
    // the settings page names — it is just no longer loaded.
    expect(snapshot.paths.userSkills).toMatch(/[/\\]\.pi[/\\]agent[/\\]skills$/);
    expect(snapshot.paths.userPromptTemplates).toMatch(/[/\\]\.pi[/\\]agent[/\\]prompts$/);
    expect(snapshot.paths.appSkills).toBe(
      join('/tmp/aiclient-test/.pilab/dev', 'pi-agent', 'skills')
    );
    expect(snapshot.paths.appPromptTemplates).toBe(
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

  it('opens this app’s prompt directory in both modes (H/19)', async () => {
    // It used to open `~/.pi/agent/prompts` on the local route. That folder is
    // no longer loaded by anything, so opening it would show a user files that
    // never reach a turn.
    process.env.PI_CODING_AGENT_DIR = '/tmp/custom-pi-agent';
    const { getActivePiPromptTemplatesDir } = await import('../index');
    const appPrompts = join('/tmp/aiclient-test/.pilab/dev', 'pi-agent', 'prompts');

    for (const credentialMode of ['managed', 'local']) {
      readSharedSettingsMock.mockReturnValue({ credentialMode });
      expect(getActivePiPromptTemplatesDir()).toBe(appPrompts);
    }
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

  it('omits the opt-in variable when the bundled registry is empty, even with a legacy opt-in', async () => {
    const bundledPlugins = await import('../../../../agent-host/bundledPlugins.mjs');
    const registry = vi.spyOn(bundledPlugins, 'optInFeatureRegistry').mockReturnValue([]);
    try {
      for (const managed of [true, false]) {
        expect(
          await workerEnv(managed, { [PI_ENABLE_SUBAGENTS_SETTING_KEY]: true })
        ).not.toHaveProperty(PI_OPT_IN_EXTENSIONS_ENV);
      }
    } finally {
      registry.mockRestore();
    }
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

describe('resolveManagedPiWorkerEnv — the user service count no longer moves anything (H/19)', () => {
  const userProvider = {
    id: 'svc-1',
    name: 'My DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
    apiKey: 'K',
    enabled: true,
    createdAt: '2026-09-10T00:00:00.000Z',
  };

  afterEach(() => {
    readUserProvidersMock.mockReturnValue({ status: 'absent' });
  });

  /**
   * The H/17 defect, as a regression test.
   *
   * Adding a service used to move `PI_CODING_AGENT_DIR`, which took the model
   * catalogue, the credentials and the session history with it — silently, and
   * only for local-mode users who happened to add a service. These four cases
   * are the same four inputs, and the directory is now the same in all of them.
   */
  const APP_AGENT_DIR = '/tmp/aiclient-test/.pilab/dev/pi-agent';

  it('points at the app directory with no services configured', async () => {
    readUserProvidersMock.mockReturnValue({ status: 'ok', providers: [] } as never);
    expect((await workerEnv(false)).PI_CODING_AGENT_DIR).toBe(APP_AGENT_DIR);
  });

  it('points at the same directory once a service exists', async () => {
    readUserProvidersMock.mockReturnValue({ status: 'ok', providers: [userProvider] } as never);
    expect((await workerEnv(false)).PI_CODING_AGENT_DIR).toBe(APP_AGENT_DIR);
  });

  it('points at the same directory when the only service is disabled', async () => {
    readUserProvidersMock.mockReturnValue({
      status: 'ok',
      providers: [{ ...userProvider, enabled: false }],
    } as never);
    expect((await workerEnv(false)).PI_CODING_AGENT_DIR).toBe(APP_AGENT_DIR);
  });

  it('keeps the local route’s marker — the directory is not a route change', async () => {
    readUserProvidersMock.mockReturnValue({ status: 'ok', providers: [userProvider] } as never);
    expect((await workerEnv(false)).AICLIENT_PI_TRUST_PROJECT_CONFIG).toBe('1');
  });
});
