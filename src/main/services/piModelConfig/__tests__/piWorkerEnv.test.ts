import { join } from 'node:path';
import {
  PI_ENABLE_SUBAGENTS_SETTING_KEY,
  PI_OPT_IN_FEATURE_SETTINGS_KEY,
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
    // cutover-10: an install that never chose gets delegation, and the page now
    // reports what the runtime does rather than a registry default of its own.
    expect(snapshot.enableSubagents).toBe(true);
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
 * cutover-10 — the opt-in extension chain, and what replaced it.
 *
 * Main used to read a list of opt-in feature ids, join them into
 * `AICLIENT_PI_OPT_IN_EXTENSIONS`, and hand it to the worker so the Host could
 * inject the matching bundled pi extension. P6-5 retired the engine that did
 * the injecting and T025 stopped shipping the packages, which left every link
 * of that chain carrying a value nobody read. T026 deleted it.
 *
 * What is left is a switch over THIS app's own delegation, and the rule that
 * broke before: exactly one function decides whether it is on, and the settings
 * page asks that same function instead of a second resolver with its own
 * default.
 */
describe('native feature switches — one reader, no transport', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it('sends no opt-in extension variable in either mode, whatever is switched on', async () => {
    for (const managed of [true, false]) {
      for (const settings of [
        {},
        { [PI_ENABLE_SUBAGENTS_SETTING_KEY]: true },
        { [PI_OPT_IN_FEATURE_SETTINGS_KEY]: { [PI_SUBAGENTS_FEATURE_ID]: true } },
      ]) {
        const env = await workerEnv(managed, settings);
        // By name, because the constant it used to come from is deleted: a
        // reintroduced transport would most likely bring the old key back.
        expect(env).not.toHaveProperty('AICLIENT_PI_OPT_IN_EXTENSIONS');
        expect(Object.keys(env).some((key) => /OPT_IN/i.test(key))).toBe(false);
      }
    }
  });

  it('hands the PTY the same environment as the worker, now that nothing is worker-only', async () => {
    readSharedSettingsMock.mockReturnValue({
      credentialMode: 'managed',
      [PI_ENABLE_SUBAGENTS_SETTING_KEY]: true,
    });
    const { resolveManagedPiWorkerEnv, resolveManagedPiPtyEnv } = await import('../index');
    expect(resolveManagedPiPtyEnv()).toEqual(resolveManagedPiWorkerEnv());
  });

  it('shows the switch ON for an install that never chose, which is what native does', async () => {
    // The whole of cutover-10's user-visible half: a fresh install saw "off"
    // while every turn registered the delegation tools.
    readSharedSettingsMock.mockReturnValue({ credentialMode: 'local' });
    const { getPiResourceSettings } = await import('../index');
    const snapshot = getPiResourceSettings();
    expect(snapshot.enableSubagents).toBe(true);
    expect(snapshot.features).toEqual([
      expect.objectContaining({ id: PI_SUBAGENTS_FEATURE_ID, enabled: true }),
    ]);
    // Never the switch's own idea of a default — there is no longer one to have.
    expect(snapshot.features[0]).not.toHaveProperty('defaultEnabled');
  });

  it('agrees with nativeSubagentSettings for every shape of stored preference', async () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{}, true],
      [{ [PI_ENABLE_SUBAGENTS_SETTING_KEY]: false }, false],
      [{ [PI_ENABLE_SUBAGENTS_SETTING_KEY]: true }, true],
      [{ [PI_OPT_IN_FEATURE_SETTINGS_KEY]: { [PI_SUBAGENTS_FEATURE_ID]: false } }, false],
      [
        {
          [PI_ENABLE_SUBAGENTS_SETTING_KEY]: true,
          [PI_OPT_IN_FEATURE_SETTINGS_KEY]: { [PI_SUBAGENTS_FEATURE_ID]: false },
        },
        false,
      ],
      // A non-boolean is not a choice, so it falls back to "never chose" = ON.
      [{ [PI_ENABLE_SUBAGENTS_SETTING_KEY]: 'true' }, true],
    ];
    for (const [settings, expected] of cases) {
      readSharedSettingsMock.mockReturnValue({ credentialMode: 'local', ...settings });
      const { getPiResourceSettings } = await import('../index');
      const { nativeSubagentSettings } = await import('../../agent-host/nativeSubagentSettings');
      expect(getPiResourceSettings().enableSubagents).toBe(expected);
      expect(nativeSubagentSettings({ ...settings }).enabled).toBe(expected);
    }
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

  it('reaches the PTY too, unlike the borrow dir it replaced', async () => {
    // The borrow dir was dropped because the real pi CLI does not read it (and
    // the opt-in list, dropped for the same reason, no longer exists at all —
    // cutover-10). This one the CLI DOES read — out of the `headers` block of
    // the same models.json a managed TUI session loads — so a PTY turn must
    // identify itself the same way a worker turn does.
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
  const APP_AGENT_DIR = join('/tmp/aiclient-test/.pilab/dev', 'pi-agent');

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
