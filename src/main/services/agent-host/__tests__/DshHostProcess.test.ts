import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDshHostEnvironment,
  buildDshHostLaunch,
  DSH_HOST_MISSING,
  forkDshHost,
  resolveDshHome,
  resolveDshHostLayout,
} from '../DshHostProcess';

const electronApp = vi.hoisted(() => ({ isPackaged: false, getAppPath: () => '/repo' }));
vi.mock('electron', () => ({ app: electronApp }));
vi.mock('../../appStatePaths', () => ({ getAppStateRoot: () => '/home/u/.pilab/profile' }));
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true), mkdirSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ pid: 4242 })) }));
vi.mock('../WorkerTransport', () => ({
  createNodeProcessWorkerTransport: vi.fn(() => 'transport'),
}));

const STATE_ROOT = '/home/u/.pilab/profile';
const always = () => true;

/** A developer shell with credentials in it; none of them may reach the host. */
const SHELL_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  LANG: 'C.UTF-8',
  ANTHROPIC_AUTH_TOKEN: 'must-not-leak',
  OPENAI_API_KEY: 'must-not-leak',
  PI_CODING_AGENT_DIR: '/home/u/.pi/agent',
  ELECTRON_RUN_AS_NODE: '1',
  // The retired P0-3 switch: its value must change nothing.
  AICLIENT_DEV_ENGINE: 'native',
  AICLIENT_DSH_GATEWAY_URL: 'http://127.0.0.1:1234',
  AICLIENT_DSH_GATEWAY_KEY: 'fake-key',
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
    expect(resolveDshHome({ isPackaged: false, appStateRoot: STATE_ROOT, env: {} })).toBe(
      join(STATE_ROOT, 'dsh-home')
    );
  });

  it('takes AICLIENT_DSH_HOME only when unpackaged', () => {
    const env = { AICLIENT_DSH_HOME: '/var/tmp/dsh-home' };
    expect(resolveDshHome({ isPackaged: false, appStateRoot: STATE_ROOT, env })).toBe(
      '/var/tmp/dsh-home'
    );
    expect(resolveDshHome({ isPackaged: true, appStateRoot: STATE_ROOT, env })).toBe(
      join(STATE_ROOT, 'dsh-home')
    );
  });
});

describe('buildDshHostEnvironment', () => {
  it('passes an exact allowlist, plus the dev gateway only when unpackaged', () => {
    const base = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'C.UTF-8',
      DSH_HOME: '/state/dsh-home',
      DSH_TELEMETRY_DISABLED: '1',
      AICLIENT_DSH_BRIDGE: '1',
      AICLIENT_PI_WORKER_GENERATION: '3',
    };
    expect(
      buildDshHostEnvironment({
        generation: 3,
        dshHome: '/state/dsh-home',
        isPackaged: false,
        env: SHELL_ENV,
      })
    ).toEqual({
      ...base,
      AICLIENT_DSH_GATEWAY_URL: 'http://127.0.0.1:1234',
      AICLIENT_DSH_GATEWAY_KEY: 'fake-key',
    });
    expect(
      buildDshHostEnvironment({
        generation: 3,
        dshHome: '/state/dsh-home',
        isPackaged: true,
        env: SHELL_ENV,
      })
    ).toEqual(base);
  });

  it('refuses a generation the RPC could not bind', () => {
    expect(() =>
      buildDshHostEnvironment({ generation: 0, dshHome: '/h', isPackaged: false, env: {} })
    ).toThrow(/positive safe integer/);
  });
});

describe('buildDshHostLaunch', () => {
  it('starts the host with --expose-internals from its private home', () => {
    const launch = buildDshHostLaunch({
      generation: 1,
      isPackaged: true,
      appPath: '/app.asar',
      resourcesPath: '/resources',
      appStateRoot: STATE_ROOT,
      platform: 'linux',
      env: { ...SHELL_ENV, AICLIENT_DSH_HOME: '/ignored-when-packaged' },
      exists: always,
    });
    expect(launch).toEqual({
      command: join('/resources', 'node-runtime', 'node'),
      args: ['--expose-internals', join('/resources', 'dsh-host', 'host.js')],
      cwd: join(STATE_ROOT, 'dsh-home'),
      env: expect.objectContaining({ DSH_HOME: join(STATE_ROOT, 'dsh-home') }),
    });
    expect(launch.env).not.toHaveProperty('AICLIENT_DSH_GATEWAY_URL');
    expect(launch.env).not.toHaveProperty('AICLIENT_DEV_ENGINE');
  });
});

describe('forkDshHost', () => {
  const resources = process.resourcesPath;

  beforeEach(() => {
    Object.defineProperty(process, 'resourcesPath', { value: '/resources', configurable: true });
    vi.mocked(existsSync).mockReset().mockReturnValue(true);
    vi.mocked(spawn).mockClear();
    vi.mocked(mkdirSync).mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
    electronApp.isPackaged = false;
  });

  it('refuses a vanished workspace before spawning anything', () => {
    vi.mocked(existsSync).mockImplementation((file) => file !== '/gone');
    expect(() => forkDshHost({ generation: 1, cwd: '/gone' })).toThrow(
      /WORKER_WORKSPACE_MISSING: .*\/gone/
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])('spawns the resolved host with an IPC channel from a 0700 home (isPackaged=%s)', (packaged) => {
    electronApp.isPackaged = packaged;
    const forked = forkDshHost({ generation: 2, cwd: '/repo' });
    const home = join(STATE_ROOT, 'dsh-home');
    expect(mkdirSync).toHaveBeenCalledWith(home, { recursive: true, mode: 0o700 });
    expect(spawn).toHaveBeenCalledWith(
      packaged
        ? join('/resources', 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'node')
        : join('/repo', 'out-node-runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
      [
        '--expose-internals',
        packaged
          ? join('/resources', 'dsh-host', 'host.js')
          : join('/repo', 'src', 'dsh-host', 'host.ts'),
      ],
      expect.objectContaining({
        cwd: home,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        env: expect.objectContaining({
          DSH_HOME: home,
          AICLIENT_DSH_BRIDGE: '1',
          AICLIENT_PI_WORKER_GENERATION: '2',
        }),
      })
    );
    expect(forked.transport).toBe('transport');
  });

  it('spawns nothing when the packaged host is missing', () => {
    electronApp.isPackaged = true;
    vi.mocked(existsSync).mockImplementation((file) => !String(file).endsWith('host.js'));
    expect(() => forkDshHost({ generation: 1, cwd: '/repo' })).toThrow(DSH_HOST_MISSING);
    expect(spawn).not.toHaveBeenCalled();
  });
});
