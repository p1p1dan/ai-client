import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiTuiDataEvent, PiTuiExitEvent, PiTuiStatusEvent } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../piModelConfig', () => ({
  resolveManagedPiPtyEnv: () => ({ PI_PROJECT_TRUST: '1' }),
}));

import {
  PiTuiPtyController,
  type PtyHandle,
  type PtySpawnFn,
  resolvePiTuiLaunchPlan,
} from '../PiTuiPty';

class FakePty implements PtyHandle {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
  private dataListener: (data: string) => void = () => {};
  private exitListener: (event: { exitCode: number; signal?: number }) => void = () => {};

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killed = true;
  }

  onData(listener: (data: string) => void): { dispose: () => void } {
    this.dataListener = listener;
    return { dispose: () => {} };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose: () => void;
  } {
    this.exitListener = listener;
    return { dispose: () => {} };
  }

  emitData(data: string): void {
    this.dataListener(data);
  }

  emitExit(exitCode = 0): void {
    this.exitListener({ exitCode });
  }
}

function harness(maxLiveTerminals = 2) {
  const ptys: FakePty[] = [];
  const spawnCalls: Array<{ file: string; args: string[] }> = [];
  const data: PiTuiDataEvent[] = [];
  const exits: PiTuiExitEvent[] = [];
  const states: PiTuiStatusEvent[] = [];
  const spawn: PtySpawnFn = (file, args) => {
    spawnCalls.push({ file, args });
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  };
  const controller = new PiTuiPtyController(
    1,
    {
      onData: (event) => data.push(event),
      onExit: (event) => exits.push(event),
      onState: (event) => states.push(event),
    },
    spawn,
    async () => ({
      cliPath: '/app/pi/cli.js',
      nodePath: '/app/node',
      args: ['/app/pi/cli.js'],
      env: { TERM: 'xterm-256color' },
      useElectronNode: false,
    }),
    maxLiveTerminals
  );
  return { controller, ptys, spawnCalls, data, exits, states };
}

describe('resolvePiTuiLaunchPlan', () => {
  it('uses absolute packaged CLI and bundled Node paths with no resume flag', () => {
    const resourcesPath = mkdtempSync(join(tmpdir(), 'pi-tui-layout-'));
    const cliPath = join(
      resourcesPath,
      'agent-host/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
    );
    const nodePath = join(resourcesPath, 'node-runtime/node');
    mkdirSync(join(cliPath, '..'), { recursive: true });
    mkdirSync(join(nodePath, '..'), { recursive: true });
    writeFileSync(cliPath, '');
    writeFileSync(nodePath, '');

    const plan = resolvePiTuiLaunchPlan(
      {
        isPackaged: true,
        appPath: '/app',
        resourcesPath,
        platform: 'linux',
        electronExecPath: '/electron',
      },
      { PATH: '/usr/bin' }
    );

    expect(plan.cliPath).toBe(cliPath);
    expect(plan.nodePath).toBe(nodePath);
    expect(plan.args).toEqual([cliPath]);
    expect(plan.useElectronNode).toBe(false);
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});

describe('PiTuiPtyController', () => {
  it('keeps the initial prompt out of argv and writes it through the PTY', async () => {
    const { controller, ptys, spawnCalls } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', initialPrompt: 'secret task' });

    expect(spawnCalls).toEqual([{ file: '/app/node', args: ['/app/pi/cli.js'] }]);
    expect(ptys[0]?.writes).toEqual(['\x1b[200~secret task\x1b[201~\r']);
  });

  it('buffers suspended output, replays it on promotion, and filters stale output', async () => {
    const { controller, ptys, data } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo' });
    await controller.suspend('one');
    ptys[0]?.emitData('parked');
    expect(data).toEqual([]);

    await expect(controller.open({ terminalId: 'one', cwd: '/repo' })).resolves.toMatchObject({
      resumed: true,
    });
    expect(data).toEqual([{ terminalId: 'one', data: 'parked' }]);

    await controller.dispose('one');
    ptys[0]?.emitData('stale');
    expect(data).toHaveLength(1);
  });

  it('evicts the oldest suspended PTY and rejects unbounded live processes', async () => {
    const { controller, ptys } = harness(2);
    await controller.open({ terminalId: 'one', cwd: '/repo' });
    await controller.open({ terminalId: 'two', cwd: '/repo' });
    await expect(controller.open({ terminalId: 'three', cwd: '/repo' })).rejects.toThrow(
      'capacity reached'
    );

    await controller.suspend('one');
    await controller.open({ terminalId: 'three', cwd: '/repo' });
    expect(ptys[0]?.killed).toBe(true);
    expect(controller.status().terminalIds.sort()).toEqual(['three', 'two']);
  });

  it('serializes open and disposal without reviving a disposed controller', async () => {
    const { controller } = harness();
    const open = controller.open({ terminalId: 'one', cwd: '/repo' });
    const dispose = controller.disposeAll();
    await Promise.allSettled([open, dispose]);
    await expect(controller.open({ terminalId: 'two', cwd: '/repo' })).rejects.toThrow('disposed');
  });
});
