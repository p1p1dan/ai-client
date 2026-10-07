import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  buildDshHostEnvironment,
  buildDshHostLaunch,
  currentDshHostLaunch,
  DSH_HOST_MISSING,
  DSH_HOST_PERMISSION_AGENT_DIR_ENV,
  DSH_HOST_PLUGINS_ENV,
  DSH_SENSITIVE_ENV_PATTERN,
  dshHostPluginSelection,
  dshHostSpawnOptions,
  dshPermissionAgentDir,
  dshPluginSelectionKey,
  ensurePrivateDirectory,
  isStrippedDshHostEnvName,
  prepareDshHostDirectories,
  resolveDshHome,
  resolveDshHostLayout,
} from '../DshHostProcess';
import { dshHostPluginsEnvValue } from '../dshHostEnvironment';

const electronApp = vi.hoisted(() => ({ isPackaged: false, getAppPath: () => '/repo' }));
vi.mock('electron', () => ({ app: electronApp }));
vi.mock('../../appStatePaths', () => ({ getAppStateRoot: () => '/home/u/.pilab/profile' }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
}));

const STATE_ROOT = '/home/u/.pilab/profile';
const HOME_DIR = join(STATE_ROOT, 'dsh-home');
const HOST_CWD = join(STATE_ROOT, 'dsh-host-cwd');
const NATIVE_CACHE = join(STATE_ROOT, 'dsh-native-cache');
/** `getAppPiAgentDir()` under the same root (PI_MANAGED_AGENT_DIR_NAME). */
const PI_AGENT_DIR = join(STATE_ROOT, 'pi-agent');
const always = () => true;

/**
 * A developer shell: the everyday variables tools rely on, credentials, runtime
 * injection and the app's own switches. Decision 022: the first group reaches
 * the host (and so its tools), nothing else does.
 */
const SHELL_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  LANG: 'C.UTF-8',
  SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
  JAVA_HOME: '/usr/lib/jvm/21',
  HTTPS_PROXY: 'http://proxy:3128',
  XDG_RUNTIME_DIR: '/run/user/1000',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
  NPM_CONFIG_REGISTRY: 'https://registry.example',
  PI_CODING_AGENT_DIR: '/home/u/.pi/agent',
  // Credential-shaped: DSH strips the same names from every tool it spawns.
  ANTHROPIC_AUTH_TOKEN: 'must-not-leak',
  OPENAI_API_KEY: 'must-not-leak',
  GITHUB_TOKEN: 'must-not-leak',
  AWS_SECRET_ACCESS_KEY: 'must-not-leak',
  PGPASSWORD: 'must-not-leak',
  // Runtime injection.
  NODE_OPTIONS: '--require /tmp/hook.js',
  NODE_PATH: '/elsewhere/node_modules',
  // Electron, app, DSH and dev-launch switches.
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_ENABLE_LOGGING: '1',
  AICLIENT_DEV_ENGINE: 'native',
  AICLIENT_DSH_HOME: '/var/tmp/dsh-home',
  DSH_HOME: '/wrong/home',
  dsh_profile: 'other',
  VITE_DEV_SERVER_URL: 'http://localhost:5173',
  npm_config_registry: 'https://registry.npmjs.org',
  npm_lifecycle_event: 'dev',
  NARB_NATIVE_CACHE_DIR: '/tmp/shared-cache',
  // The retired dev route (P1-5 removed it) and a plan's key reference name.
  AICLIENT_DSH_GATEWAY_URL: 'http://127.0.0.1:1234',
  AICLIENT_DSH_GATEWAY_KEY: 'fake-key',
  AICLIENT_KEY_OPENAI_1A2B: 'sk-must-not-leak',
};

/** What survives from SHELL_ENV, packaged or not. */
const INHERITED = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  LANG: 'C.UTF-8',
  SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
  JAVA_HOME: '/usr/lib/jvm/21',
  HTTPS_PROXY: 'http://proxy:3128',
  XDG_RUNTIME_DIR: '/run/user/1000',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
  NPM_CONFIG_REGISTRY: 'https://registry.example',
  PI_CODING_AGENT_DIR: '/home/u/.pi/agent',
};

const EXPLICIT = {
  DSH_HOME: '/state/dsh-home',
  DSH_TELEMETRY_DISABLED: '1',
  NARB_NATIVE_CACHE_DIR: '/state/dsh-native-cache',
};

describe('resolveDshHostLayout', () => {
  it('runs the source entry on out-node-runtime when unpackaged', () => {
    expect(
      resolveDshHostLayout({
        isPackaged: false,
        appPath: '/repo',
        resourcesPath: '/resources',
        platform: 'linux',
        env: {},
        exists: always,
      })
    ).toEqual({
      node: join('/repo', 'out-node-runtime', 'node'),
      entry: join('/repo', 'src', 'dsh-host', 'host.ts'),
    });
  });

  it('runs the built entry on the bundled node-runtime when packaged', () => {
    expect(
      resolveDshHostLayout({
        isPackaged: true,
        appPath: '/app.asar',
        resourcesPath: '/resources',
        platform: 'linux',
        env: {},
        exists: always,
      })
    ).toEqual({
      node: join('/resources', 'node-runtime', 'node'),
      entry: join('/resources', 'dsh-host', 'host.js'),
    });
  });

  it('uses node.exe on Windows, packaged or not', () => {
    for (const isPackaged of [false, true]) {
      const layout = resolveDshHostLayout({
        isPackaged,
        appPath: '/repo',
        resourcesPath: '/resources',
        platform: 'win32',
        env: {},
        exists: always,
      });
      expect(layout.node.endsWith('node.exe')).toBe(true);
    }
  });

  it('fails with DSH_HOST_MISSING instead of falling back to a node on PATH', () => {
    for (const isPackaged of [false, true]) {
      const missingNode = () =>
        resolveDshHostLayout({
          isPackaged,
          appPath: '/repo',
          resourcesPath: '/resources',
          platform: 'linux',
          env: { PATH: '/usr/bin' },
          exists: (file) => basename(file) !== 'node',
        });
      expect(missingNode).toThrow(DSH_HOST_MISSING);
      try {
        missingNode();
      } catch (error) {
        expect((error as { code?: string }).code).toBe(DSH_HOST_MISSING);
      }
      const missingEntry = () =>
        resolveDshHostLayout({
          isPackaged,
          appPath: '/repo',
          resourcesPath: '/resources',
          platform: 'linux',
          env: {},
          exists: (file) => !/host\.(ts|js)$/.test(file),
        });
      expect(missingEntry).toThrow(/DSH_HOST_MISSING: the DSH host entry is missing/);
    }
  });

  it('honours AICLIENT_DSH_NODE only when unpackaged, and still requires it to exist', () => {
    const env = { AICLIENT_DSH_NODE: '/opt/node/bin/node' };
    const input = {
      appPath: '/repo',
      resourcesPath: '/resources',
      platform: 'linux' as const,
      env,
    };
    expect(resolveDshHostLayout({ ...input, isPackaged: false, exists: always }).node).toBe(
      '/opt/node/bin/node'
    );
    expect(resolveDshHostLayout({ ...input, isPackaged: true, exists: always }).node).toBe(
      join('/resources', 'node-runtime', 'node')
    );
    expect(() =>
      resolveDshHostLayout({
        ...input,
        isPackaged: false,
        exists: (file) => file !== '/opt/node/bin/node',
      })
    ).toThrow(DSH_HOST_MISSING);
  });
});

describe('resolveDshHome', () => {
  it('lives under the app state root by default (decision 008)', () => {
    expect(resolveDshHome({ isPackaged: false, appStateRoot: STATE_ROOT, env: {} })).toBe(HOME_DIR);
  });

  it('takes AICLIENT_DSH_HOME only when unpackaged', () => {
    const env = { AICLIENT_DSH_HOME: '/var/tmp/dsh-home' };
    expect(resolveDshHome({ isPackaged: false, appStateRoot: STATE_ROOT, env })).toBe(
      '/var/tmp/dsh-home'
    );
    expect(resolveDshHome({ isPackaged: true, appStateRoot: STATE_ROOT, env })).toBe(HOME_DIR);
  });
});

describe('buildDshHostEnvironment (decision 022)', () => {
  const build = (overrides: Partial<Parameters<typeof buildDshHostEnvironment>[0]> = {}) =>
    buildDshHostEnvironment({
      dshHome: '/state/dsh-home',
      nativeCacheDir: '/state/dsh-native-cache',
      isPackaged: true,
      env: SHELL_ENV,
      platform: 'linux',
      ...overrides,
    });

  it('inherits Main minus runtime injection, app switches and credential-shaped names', () => {
    expect(build()).toEqual({ ...INHERITED, ...EXPLICIT });
  });

  // P1-5 (decisions 033, 034): routes come over IPC and keys per request, so
  // nothing is added back, not even unpackaged.
  it('adds no route and no key back, packaged or not', () => {
    for (const isPackaged of [true, false]) {
      expect(build({ isPackaged }), String(isPackaged)).toEqual({ ...INHERITED, ...EXPLICIT });
    }
    for (const name of [
      'AICLIENT_DSH_GATEWAY_URL',
      'AICLIENT_DSH_GATEWAY_KEY',
      'AICLIENT_KEY_OPENAI_1A2B',
    ]) {
      expect(isStrippedDshHostEnvName(name), name).toBe(true);
    }
  });

  it('strips the switch families case-insensitively, but npm lifecycle names only lower-case', () => {
    for (const name of [
      'node_options',
      'Node_Path',
      'electron_run_as_node',
      'Aiclient_Anything',
      'dsh_home',
      'vite_port',
      'npm_config_cache',
      'npm_package_name',
    ]) {
      expect(isStrippedDshHostEnvName(name), name).toBe(true);
    }
    for (const name of ['NPM_CONFIG_REGISTRY', 'NODE_EXTRA_CA_CERTS', 'NODE_ENV', 'PATH']) {
      expect(isStrippedDshHostEnvName(name), name).toBe(false);
    }
  });

  it('strips exactly the names DSH keeps from tools', () => {
    for (const name of [
      'OPENAI_API_KEY',
      'api_key',
      'ANTHROPIC_AUTH_TOKEN',
      'GH_TOKEN',
      'MYSQL_PASSWORD',
      'client_secret',
      'SSH_KEYFILE',
    ]) {
      expect(DSH_SENSITIVE_ENV_PATTERN.test(name), name).toBe(true);
      expect(isStrippedDshHostEnvName(name), name).toBe(true);
    }
    for (const name of ['SSH_AUTH_SOCK', 'HTTPS_PROXY', 'JAVA_HOME', 'XDG_RUNTIME_DIR']) {
      expect(DSH_SENSITIVE_ENV_PATTERN.test(name), name).toBe(false);
    }
  });

  it('replaces every Windows spelling of an explicit name', () => {
    const env = build({
      platform: 'win32',
      env: { Path: 'C:\\Windows', narb_native_cache_dir: 'C:\\shared', SystemRoot: 'C:\\Windows' },
    });
    expect(env).toEqual({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      ...EXPLICIT,
    });
  });

  it('forwards the loop guard kill switch, packaged or not (dsh-rebase decision 065)', () => {
    for (const isPackaged of [true, false]) {
      const env = build({
        isPackaged,
        env: { ...SHELL_ENV, AICLIENT_RUNTIME_LOOP_GUARD: '0', AICLIENT_RUNTIME_OTHER: '1' },
      });
      expect(env.AICLIENT_RUNTIME_LOOP_GUARD, String(isPackaged)).toBe('0');
      expect(env.AICLIENT_RUNTIME_OTHER, String(isPackaged)).toBeUndefined();
    }
    expect(build().AICLIENT_RUNTIME_LOOP_GUARD).toBeUndefined();
    expect(isStrippedDshHostEnvName('AICLIENT_RUNTIME_LOOP_GUARD')).toBe(true);
  });

  it('forwards the encrypted-read kill switch too, and nothing else of the AICLIENT_ family (P1-13d)', () => {
    for (const isPackaged of [true, false]) {
      const env = build({
        isPackaged,
        env: {
          ...SHELL_ENV,
          AICLIENT_RUNTIME_ENCRYPTED_READ: '0',
          AICLIENT_RUNTIME_OTHER: '1',
        },
      });
      expect(env.AICLIENT_RUNTIME_ENCRYPTED_READ, String(isPackaged)).toBe('0');
      expect(env.AICLIENT_RUNTIME_OTHER, String(isPackaged)).toBeUndefined();
    }
    // Absent stays absent: no value means the row is on, its own default.
    expect(build().AICLIENT_RUNTIME_ENCRYPTED_READ).toBeUndefined();
    expect(isStrippedDshHostEnvName('AICLIENT_RUNTIME_ENCRYPTED_READ')).toBe(true);
  });

  it('sets the permission agent directory only when given one, and never inherits it (P1-6c)', () => {
    expect(build({ permissionAgentDir: '/state/pi-agent' })).toEqual({
      ...INHERITED,
      ...EXPLICIT,
      AICLIENT_PERMISSION_AGENT_DIR: '/state/pi-agent',
    });
    expect(build({ env: { ...SHELL_ENV, AICLIENT_PERMISSION_AGENT_DIR: '/inherited' } })).toEqual({
      ...INHERITED,
      ...EXPLICIT,
    });
    expect(isStrippedDshHostEnvName(DSH_HOST_PERMISSION_AGENT_DIR_ENV)).toBe(true);
  });

  // P1-3a: the shared host carries each session's generation in its channel's
  // messages; no launch ever says which session or generation it serves.
  it('never passes a session generation or a bridge switch to the shared host', () => {
    const env = build({
      isPackaged: false,
      env: { ...SHELL_ENV, AICLIENT_PI_WORKER_GENERATION: '3', AICLIENT_DSH_PROBE_ROW: '0' },
    });
    expect(env).toEqual({ ...INHERITED, ...EXPLICIT });
  });
});

describe('buildDshHostLaunch', () => {
  it('starts the host with --expose-internals from a private empty directory (decision 023)', () => {
    const launch = buildDshHostLaunch({
      isPackaged: true,
      appPath: '/app.asar',
      resourcesPath: '/resources',
      appStateRoot: STATE_ROOT,
      platform: 'linux',
      env: SHELL_ENV,
      exists: always,
    });
    expect(launch).toEqual({
      command: join('/resources', 'node-runtime', 'node'),
      args: ['--expose-internals', join('/resources', 'dsh-host', 'host.js')],
      cwd: HOST_CWD,
      env: {
        ...INHERITED,
        DSH_HOME: HOME_DIR,
        DSH_TELEMETRY_DISABLED: '1',
        NARB_NATIVE_CACHE_DIR: NATIVE_CACHE,
        AICLIENT_PERMISSION_AGENT_DIR: PI_AGENT_DIR,
      },
      privateDirs: [HOME_DIR, HOST_CWD, NATIVE_CACHE],
    });
  });

  // P1-6c: the global permission policy the settings page edits is the user
  // layer of every session's policy. Read-only for the host: not a private dir.
  it("names the app's pi-agent directory for the permission policy, never the user's own pi", () => {
    const launch = buildDshHostLaunch({
      isPackaged: false,
      appPath: '/repo',
      resourcesPath: '/resources',
      appStateRoot: STATE_ROOT,
      platform: 'linux',
      env: { ...SHELL_ENV, AICLIENT_PERMISSION_AGENT_DIR: '/elsewhere' },
      exists: always,
    });
    expect(launch.env[DSH_HOST_PERMISSION_AGENT_DIR_ENV]).toBe(PI_AGENT_DIR);
    expect(dshPermissionAgentDir(STATE_ROOT)).toBe(PI_AGENT_DIR);
    // The user's own pi keeps its variable for the tools, and means nothing here.
    expect(launch.env.PI_CODING_AGENT_DIR).toBe('/home/u/.pi/agent');
    expect(launch.privateDirs).not.toContain(PI_AGENT_DIR);
  });

  it('keeps the launch directory and native cache under the state root when DSH_HOME moves', () => {
    const launch = buildDshHostLaunch({
      isPackaged: false,
      appPath: '/repo',
      resourcesPath: '/resources',
      appStateRoot: STATE_ROOT,
      platform: 'linux',
      env: { AICLIENT_DSH_HOME: '/var/tmp/dsh-home' },
      exists: always,
    });
    expect(launch.cwd).toBe(HOST_CWD);
    expect(launch.env.DSH_HOME).toBe('/var/tmp/dsh-home');
    expect(launch.privateDirs).toEqual(['/var/tmp/dsh-home', HOST_CWD, NATIVE_CACHE]);
  });
});

describe('dshHostSpawnOptions', () => {
  it('pipes stdio with an IPC channel, hides the console and never detaches', () => {
    const launch = { command: '/n', args: [], cwd: '/c', env: { A: '1' }, privateDirs: [] };
    expect(dshHostSpawnOptions(launch)).toStrictEqual({
      cwd: '/c',
      env: { A: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
  });
});

describe('ensurePrivateDirectory', () => {
  beforeEach(() => {
    vi.mocked(mkdirSync).mockClear();
    vi.mocked(chmodSync).mockClear();
  });

  it('creates 0700 and tightens a directory that already exists (P1-1 leftover)', () => {
    ensurePrivateDirectory('/state/dsh-home', 'linux');
    expect(mkdirSync).toHaveBeenCalledWith('/state/dsh-home', { recursive: true, mode: 0o700 });
    expect(chmodSync).toHaveBeenCalledWith('/state/dsh-home', 0o700);
  });

  it('leaves modes alone on Windows', () => {
    ensurePrivateDirectory('C:\\state\\dsh-home', 'win32');
    expect(mkdirSync).toHaveBeenCalledTimes(1);
    expect(chmodSync).not.toHaveBeenCalled();
  });
});

// The one launch DshHostSupervisor spawns (P1-3a: no per-session host any more).
describe('currentDshHostLaunch', () => {
  const resources = process.resourcesPath;

  beforeEach(() => {
    Object.defineProperty(process, 'resourcesPath', { value: '/resources', configurable: true });
    vi.mocked(existsSync).mockReset().mockReturnValue(true);
    vi.mocked(mkdirSync).mockClear();
    vi.mocked(chmodSync).mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
    electronApp.isPackaged = false;
  });

  it.each([
    false,
    true,
  ])('resolves this app’s host from its private directories (isPackaged=%s)', (packaged) => {
    electronApp.isPackaged = packaged;
    const launch = currentDshHostLaunch();
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    expect(launch.command).toBe(
      packaged
        ? join('/resources', 'node-runtime', nodeName)
        : join('/repo', 'out-node-runtime', nodeName)
    );
    expect(launch.args).toEqual([
      '--expose-internals',
      packaged
        ? join('/resources', 'dsh-host', 'host.js')
        : join('/repo', 'src', 'dsh-host', 'host.ts'),
    ]);
    expect(launch.cwd).toBe(HOST_CWD);
    expect(launch.env).toMatchObject({
      DSH_HOME: HOME_DIR,
      DSH_TELEMETRY_DISABLED: '1',
      NARB_NATIVE_CACHE_DIR: NATIVE_CACHE,
      AICLIENT_PERMISSION_AGENT_DIR: PI_AGENT_DIR,
    });
    expect(
      Object.keys(launch.env).filter((name) => /^AICLIENT_DSH_BRIDGE$|GENERATION/.test(name))
    ).toEqual([]);
    prepareDshHostDirectories(launch);
    for (const dir of [HOME_DIR, HOST_CWD, NATIVE_CACHE]) {
      expect(mkdirSync).toHaveBeenCalledWith(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') expect(chmodSync).toHaveBeenCalledWith(dir, 0o700);
    }
  });

  it('fails loudly when the packaged host is missing', () => {
    electronApp.isPackaged = true;
    vi.mocked(existsSync).mockImplementation((file) => !String(file).endsWith('host.js'));
    expect(() => currentDshHostLaunch()).toThrow(DSH_HOST_MISSING);
  });
});

// dsh-rebase P1-10b (decision 110, revising decision 108 rule 6): the user's
// per-plugin overrides reach the host at every spawn; a plugin nobody has
// touched follows the allowlist's defaultEnabled.
describe('the plugin selection in the launch (P1-10b, decision 110)', () => {
  const build = (
    pluginOverrides?: Readonly<Record<string, boolean>>,
    env: NodeJS.ProcessEnv = SHELL_ENV
  ) =>
    buildDshHostEnvironment({
      dshHome: '/state/dsh-home',
      nativeCacheDir: '/state/dsh-native-cache',
      isPackaged: true,
      pluginOverrides,
      env,
      platform: 'linux',
    });

  it('sets AICLIENT_DSH_PLUGINS to the overrides, keys sorted', () => {
    expect(DSH_HOST_PLUGINS_ENV).toBe('AICLIENT_DSH_PLUGINS');
    expect(build({ 'dsh-b': true, '@s/dsh-a': false })).toEqual({
      ...INHERITED,
      ...EXPLICIT,
      AICLIENT_DSH_PLUGINS: '{"@s/dsh-a":false,"dsh-b":true}',
    });
    expect(build({})[DSH_HOST_PLUGINS_ENV]).toBe('{}');
  });

  it('leaves it out when nobody chose, and never inherits it or the probe switch from Main', () => {
    expect(build(undefined)).toEqual({ ...INHERITED, ...EXPLICIT });
    const env = build(undefined, {
      ...SHELL_ENV,
      AICLIENT_DSH_PLUGINS: '{"@evil/bundle":true}',
      AICLIENT_DSH_PROBE_BUNDLE: '1',
      // P1-3e (decision 151): the probe bundle's stuck-tool switch.
      AICLIENT_DSH_PROBE_STUCK_TOOL: 'P13ESTUCK',
    });
    expect(env).toEqual({ ...INHERITED, ...EXPLICIT });
    expect(isStrippedDshHostEnvName('AICLIENT_DSH_PROBE_BUNDLE')).toBe(true);
    expect(isStrippedDshHostEnvName('AICLIENT_DSH_PROBE_STUCK_TOOL')).toBe(true);
    expect(DSH_SENSITIVE_ENV_PATTERN.test(DSH_HOST_PLUGINS_ENV)).toBe(false);
  });

  it('gives every launch one comparable selection key', () => {
    expect(dshHostPluginsEnvValue(undefined)).toBeUndefined();
    expect(dshPluginSelectionKey(undefined)).toBe('default');
    expect(dshPluginSelectionKey({ 'dsh-b': true, 'dsh-a': false })).toBe(
      '{"dsh-a":false,"dsh-b":true}'
    );
    expect(dshHostPluginSelection(build({ 'dsh-a': true, 'dsh-b': false }))).toBe(
      dshPluginSelectionKey({ 'dsh-b': false, 'dsh-a': true })
    );
    expect(dshHostPluginSelection(build(undefined))).toBe('default');
  });

  it('passes the selection read at launch time into the launch', () => {
    const resources = process.resourcesPath;
    Object.defineProperty(process, 'resourcesPath', { value: '/resources', configurable: true });
    onTestFinished(() => {
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
    });
    vi.mocked(existsSync).mockReset().mockReturnValue(true);
    const launch = currentDshHostLaunch(() => ({ 'dsh-a': true }));
    expect(launch.env[DSH_HOST_PLUGINS_ENV]).toBe('{"dsh-a":true}');
    expect(currentDshHostLaunch(() => undefined).env[DSH_HOST_PLUGINS_ENV]).toBeUndefined();
    const direct = buildDshHostLaunch({
      isPackaged: true,
      appPath: '/app.asar',
      resourcesPath: '/resources',
      appStateRoot: STATE_ROOT,
      platform: 'linux',
      env: SHELL_ENV,
      exists: always,
      pluginOverrides: { 'dsh-a': true },
    });
    expect(direct.env[DSH_HOST_PLUGINS_ENV]).toBe('{"dsh-a":true}');
  });
});
