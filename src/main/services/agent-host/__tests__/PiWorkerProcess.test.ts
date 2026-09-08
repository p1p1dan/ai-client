import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PI_WORKER_GENERATION_ENV } from '@shared/types/workerRpc';
import { app, utilityProcess } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPiWorkerEnvironment,
  forkPiWorkerProcess,
  resolvePiWorkerEntryPath,
} from '../PiWorkerProcess';

vi.mock('electron', () => ({ app: { isPackaged: true }, utilityProcess: { fork: vi.fn() } }));
vi.mock('../../piModelConfig', () => ({ resolveManagedPiWorkerEnv: () => ({}) }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }));

it('uses the bundled Node executable for packaged Windows workers and fails if it is missing', () => {
  const platform = process.platform;
  const resources = process.resourcesPath;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  Object.defineProperty(process, 'resourcesPath', { value: '/resources', configurable: true });
  vi.mocked(spawn).mockReturnValue({ stdout: { resume: vi.fn() } } as unknown as ReturnType<
    typeof spawn
  >);
  try {
    forkPiWorkerProcess({
      generation: 1,
      cwd: '/workspace',
      entryPath: '/resources/agent-host/worker.js',
      inheritedEnv: { Path: 'system-bin', ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(spawn).toHaveBeenCalledWith(
      '/resources/node-runtime/node.exe',
      ['/resources/agent-host/worker.js'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        env: expect.objectContaining({
          PATH: '/resources/node-runtime;system-bin',
          Path: '/resources/node-runtime;system-bin',
        }),
      })
    );
    expect(utilityProcess.fork).not.toHaveBeenCalled();
    expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    vi.mocked(existsSync).mockReturnValueOnce(false);
    expect(() =>
      forkPiWorkerProcess({ generation: 2, cwd: '/workspace', entryPath: '/worker.js' })
    ).toThrow('Pi Node runtime is missing');
    expect(spawn).toHaveBeenCalledTimes(1);
    Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
    vi.mocked(utilityProcess.fork).mockReturnValue({} as ReturnType<typeof utilityProcess.fork>);
    forkPiWorkerProcess({ generation: 3, cwd: '/workspace', entryPath: '/worker.ts' });
    expect(utilityProcess.fork).toHaveBeenCalledWith(
      '/worker.ts',
      [],
      expect.objectContaining({ execArgv: ['--experimental-strip-types'] })
    );
  } finally {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true });
    Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
  }
});

describe('PiWorkerProcess', () => {
  it('resolves separate dev and packaged per-slot worker entries', () => {
    expect(
      resolvePiWorkerEntryPath({
        isPackaged: false,
        appPath: '/app',
        resourcesPath: '/resources',
      })
    ).toBe('/app/src/agent-host/worker.ts');
    expect(
      resolvePiWorkerEntryPath({
        isPackaged: true,
        appPath: '/app',
        resourcesPath: '/resources',
      })
    ).toBe('/resources/agent-host/worker.js');
  });

  it('sanitizes Electron mode and binds generation plus managed Pi environment', () => {
    expect(
      buildPiWorkerEnvironment({
        generation: 4,
        inheritedEnv: {
          ELECTRON_RUN_AS_NODE: '1',
          KEEP_ME: 'yes',
          PI_CODING_AGENT_DIR: '/user/pi-agent',
        },
        piEnv: {
          PI_CODING_AGENT_DIR: '/managed/pi-agent',
          AICLIENT_PI_TRUST_PROJECT_CONFIG: '0',
        },
      })
    ).toEqual({
      KEEP_ME: 'yes',
      PI_CODING_AGENT_DIR: '/managed/pi-agent',
      AICLIENT_PI_TRUST_PROJECT_CONFIG: '0',
      [PI_WORKER_GENERATION_ENV]: '4',
    });
  });

  it('preserves the user Pi directory on the local route', () => {
    expect(
      buildPiWorkerEnvironment({
        generation: 1,
        inheritedEnv: { PI_CODING_AGENT_DIR: '/user/pi-agent' },
        piEnv: { AICLIENT_PI_TRUST_PROJECT_CONFIG: '1' },
      })
    ).toMatchObject({
      PI_CODING_AGENT_DIR: '/user/pi-agent',
      AICLIENT_PI_TRUST_PROJECT_CONFIG: '1',
    });
  });

  it('rejects invalid generations before spawning', () => {
    expect(() => buildPiWorkerEnvironment({ generation: 0, inheritedEnv: {}, piEnv: {} })).toThrow(
      /positive safe integer/
    );
  });
});
