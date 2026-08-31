import { PI_WORKER_GENERATION_ENV } from '@shared/types/workerRpc';
import { describe, expect, it } from 'vitest';
import { buildPiWorkerEnvironment, resolvePiWorkerEntryPath } from '../PiWorkerProcess';

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
