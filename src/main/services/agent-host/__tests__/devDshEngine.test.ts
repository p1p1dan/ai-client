import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildDevDshHostLaunch, DEV_ENGINE_ENV, isDevDshEngineSelected } from '../devDshEngine';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/user-data' },
}));

describe('isDevDshEngineSelected', () => {
  it('is off unless the switch says dsh in an unpackaged app', () => {
    expect(isDevDshEngineSelected({}, false)).toBe(false);
    expect(isDevDshEngineSelected({ [DEV_ENGINE_ENV]: 'native' }, false)).toBe(false);
    expect(isDevDshEngineSelected({ [DEV_ENGINE_ENV]: 'DSH' }, false)).toBe(false);
    expect(isDevDshEngineSelected({ [DEV_ENGINE_ENV]: 'dsh' }, true)).toBe(false);
    expect(isDevDshEngineSelected({ [DEV_ENGINE_ENV]: 'dsh' }, false)).toBe(true);
  });
});

describe('buildDevDshHostLaunch', () => {
  it('spawns the host on the bundled Node from an app-private directory with an allowlisted env', () => {
    const launch = buildDevDshHostLaunch({
      generation: 3,
      appPath: '/repo',
      userDataPath: '/user-data',
      env: {
        PATH: '/usr/bin',
        HOME: '/home/u',
        ANTHROPIC_AUTH_TOKEN: 'must-not-leak',
        OPENAI_API_KEY: 'must-not-leak',
        AICLIENT_DSH_GATEWAY_URL: 'http://127.0.0.1:1234',
      },
      exists: () => true,
    });
    const dshHome = join('/user-data', 'dsh-home-dev');
    expect(launch.command).toBe(
      join('/repo', 'out-node-runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    );
    expect(launch.args).toEqual([
      '--expose-internals',
      join('/repo', 'src', 'dsh-host', 'host.ts'),
    ]);
    expect(launch.cwd).toBe(dshHome);
    expect(launch.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      AICLIENT_DSH_GATEWAY_URL: 'http://127.0.0.1:1234',
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      AICLIENT_DSH_BRIDGE: '1',
      AICLIENT_PI_WORKER_GENERATION: '3',
    });
  });

  it('honours the node and home overrides, and falls back to node on PATH', () => {
    const overridden = buildDevDshHostLaunch({
      generation: 1,
      appPath: '/repo',
      userDataPath: '/user-data',
      env: { AICLIENT_DSH_NODE: '/opt/node', AICLIENT_DSH_HOME: '/var/tmp/dsh-home' },
      exists: () => false,
    });
    expect(overridden.command).toBe('/opt/node');
    expect(overridden.cwd).toBe('/var/tmp/dsh-home');
    expect(overridden.env.DSH_HOME).toBe('/var/tmp/dsh-home');
    const fallback = buildDevDshHostLaunch({
      generation: 1,
      appPath: '/repo',
      userDataPath: '/user-data',
      env: {},
      exists: () => false,
    });
    expect(fallback.command).toBe('node');
  });
});
