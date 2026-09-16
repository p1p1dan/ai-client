import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiTuiDataEvent, PiTuiExitEvent, PiTuiStatusEvent } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

vi.mock('../../piModelConfig', () => ({
  resolveManagedPiPtyEnv: () => ({ PI_PROJECT_TRUST: '1' }),
}));

import {
  PI_TUI_SESSION_MISMATCH_REASON,
  PiTuiPtyController,
  type PtyHandle,
  type PtySpawnFn,
  resolvePiCliLaunchPlan,
} from '../PiTuiPty';

/**
 * Engineering standard appendix B1 — nothing in this file may reach a real
 * signal. The controller's escalation path is injected (`forceKill`) precisely
 * so a test can stub it; this spy turns "somebody wired the production default
 * into the harness" into a failing assertion here instead of a dead desktop
 * session.
 */
let killSpy: MockInstance;
beforeEach(() => {
  killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
    throw new Error(`a test tried to signal pid ${pid}`);
  });
});
afterEach(() => {
  expect(killSpy).not.toHaveBeenCalled();
  killSpy.mockRestore();
});

class FakePty implements PtyHandle {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
  exited = false;
  /** terminal-01: a process that ignores the signal, like a stuck pi shutdown. */
  ignoreKill = false;
  /** terminal-01: a kill that throws — node-pty's Windows path can. */
  throwOnKill = false;
  private dataListener: (data: string) => void = () => {};
  private exitListener: (event: { exitCode: number; signal?: number }) => void = () => {};

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    if (this.throwOnKill) throw new Error('kill failed');
    this.killed = true;
    // A well-behaved PTY reports the exit on its own, one tick later. Nothing
    // here signals a real process: the exit is synthesised by the double.
    if (!this.ignoreKill) setTimeout(() => this.emitExit(0), 0);
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
    if (this.exited) return;
    this.exited = true;
    this.exitListener({ exitCode });
  }
}

function harness(maxLiveTerminals = 2) {
  const ptys: FakePty[] = [];
  const spawnCalls: Array<{ file: string; args: string[] }> = [];
  const data: PiTuiDataEvent[] = [];
  const exits: PiTuiExitEvent[] = [];
  const states: PiTuiStatusEvent[] = [];
  const forced: PtyHandle[] = [];
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
    maxLiveTerminals,
    {
      // Injected, never the production `killProcessTree` default: see the B1
      // note above.
      forceKill: (pty) => forced.push(pty),
      exitConfirmMs: 5,
      forceConfirmMs: 5,
    }
  );
  return { controller, ptys, spawnCalls, data, exits, states, forced };
}

describe('resolvePiCliLaunchPlan', () => {
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

    const plan = resolvePiCliLaunchPlan(
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

// Q17 — terminal mode continues the GUI's own conversation instead of starting
// a parallel one, so the terminal has to be bound to that session's JSONL and
// killable by it when the GUI takes the file back.
describe('PiTuiPtyController — session binding (Q17)', () => {
  it('runs `--session <file>` when the terminal continues a chat', async () => {
    const { controller, spawnCalls } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', sessionFile: '/repo/s.jsonl' });

    expect(spawnCalls).toEqual([
      { file: '/app/node', args: ['/app/pi/cli.js', '--session', '/repo/s.jsonl'] },
    ]);
  });

  it('starts a fresh session when opened from a repo with no chat behind it', async () => {
    const { controller, spawnCalls } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo' });

    expect(spawnCalls).toEqual([{ file: '/app/node', args: ['/app/pi/cli.js'] }]);
  });

  it('disposeSession kills only the terminals on that JSONL', async () => {
    const { controller, ptys } = harness();
    await controller.open({ terminalId: 'mine', cwd: '/repo', sessionFile: '/repo/mine.jsonl' });
    await controller.open({ terminalId: 'other', cwd: '/repo', sessionFile: '/repo/other.jsonl' });

    const killed = await controller.disposeSession('/repo/mine.jsonl');

    expect(killed).toEqual({ terminalIds: ['mine'], confirmed: true });
    expect(ptys[0]?.killed).toBe(true);
    expect(ptys[1]?.killed).toBe(false);
    expect(controller.status().terminalIds).toEqual(['other']);
  });

  it('disposeSession matches through path drift, so the GUI handback lands', async () => {
    const { controller, ptys } = harness();
    await controller.open({
      terminalId: 'one',
      cwd: '/repo',
      sessionFile: '/private/var/s.jsonl',
    });

    // The index row says /var/…, the controller was told /private/var/… — the
    // same file. A raw string compare would silently kill nothing and leave two
    // writers on it.
    expect(await controller.disposeSession('/VAR/s.jsonl')).toEqual({
      terminalIds: ['one'],
      confirmed: true,
    });
    expect(ptys[0]?.killed).toBe(true);
  });

  it('reports the session on exit so Main can release ownership', async () => {
    const { controller, ptys, exits } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', sessionFile: '/repo/s.jsonl' });

    ptys[0]?.emitExit(0);

    expect(exits).toEqual([{ terminalId: 'one', exitCode: 0, sessionFile: '/repo/s.jsonl' }]);
  });
});

/**
 * terminal-01 — "the signal was sent" was being reported as "the other writer is
 * gone". It is not: pi installs a SIGHUP handler that tears its runtime down
 * asynchronously and keeps appending to the session file while it does, and
 * node-pty's unix kill swallows its own failures. The handover that follows a
 * disposal re-reads the JSONL, so answering too early is how one file ends up
 * with two writers.
 *
 * Every PTY here is a double. Nothing in this file may signal a real process
 * (engineering standard appendix B1) — the escalation is injected.
 */
describe('PiTuiPtyController — a disposal waits for the process to be gone', () => {
  it('reports success only after the PTY has reported its exit', async () => {
    const { controller, ptys } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', sessionFile: '/repo/s.jsonl' });

    await expect(controller.dispose('one')).resolves.toBe(true);

    expect(ptys[0]?.killed).toBe(true);
    expect(ptys[0]?.exited).toBe(true);
  });

  it('escalates and then reports an unconfirmed exit when the process ignores the kill', async () => {
    const { controller, ptys, forced } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', sessionFile: '/repo/s.jsonl' });
    const pty = ptys[0];
    if (!pty) throw new Error('no PTY was spawned');
    pty.ignoreKill = true;

    const result = await controller.disposeSession('/repo/s.jsonl');

    // The terminal was asked to stop, the escalation ran, and the caller is
    // told the exit was never observed — which is what keeps the ownership
    // guard held and the GUI write refused.
    expect(result).toEqual({ terminalIds: ['one'], confirmed: false });
    expect(forced).toEqual([pty]);
  });

  it('surfaces a kill that threw instead of filing it under "already exited"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { controller, ptys, forced } = harness();
      await controller.open({ terminalId: 'one', cwd: '/repo', sessionFile: '/repo/s.jsonl' });
      const pty = ptys[0];
      if (!pty) throw new Error('no PTY was spawned');
      pty.throwOnKill = true;

      await expect(controller.dispose('one')).resolves.toBe(false);

      expect(warn).toHaveBeenCalled();
      expect(forced).toEqual([pty]);
    } finally {
      warn.mockRestore();
    }
  });

  it('confirms immediately when the process had already exited on its own', async () => {
    const { controller, ptys, forced } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', sessionFile: '/repo/s.jsonl' });
    ptys[0]?.emitExit(0);

    await expect(controller.dispose('one')).resolves.toBe(true);
    expect(forced).toEqual([]);
  });
});

/**
 * terminal-03 (Main half) — the renderer now keeps one terminal id per chat, so
 * this branch should never be reached in the product. It is the defence in
 * depth behind it: a warm PTY is bound to the JSONL it was spawned on, and
 * resuming it for another chat would put the user's typing in the previous
 * chat's file while the UI says they are somewhere else.
 */
describe('PiTuiPtyController — a warm terminal stays on its own chat', () => {
  it('refuses to resume a terminal that was spawned on a different session file', async () => {
    const { controller } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', sessionFile: '/repo/a.jsonl' });

    await expect(
      controller.open({ terminalId: 'one', cwd: '/repo', sessionFile: '/repo/b.jsonl' })
    ).rejects.toThrow(PI_TUI_SESSION_MISMATCH_REASON);
  });

  it('refuses to resume a fresh terminal as if it were continuing a chat', async () => {
    const { controller } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo' });

    await expect(
      controller.open({ terminalId: 'one', cwd: '/repo', sessionFile: '/repo/b.jsonl' })
    ).rejects.toThrow(PI_TUI_SESSION_MISMATCH_REASON);
  });

  it('still resumes through path drift and through a request that claims no session', async () => {
    const { controller } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', sessionFile: '/private/var/s.jsonl' });

    await expect(
      controller.open({ terminalId: 'one', cwd: '/repo', sessionFile: '/VAR/s.jsonl' })
    ).resolves.toMatchObject({ resumed: true });
    // The revive path passes whatever the chat row has; an absent file is "no
    // claim", not "a different chat".
    await expect(controller.open({ terminalId: 'one', cwd: '/repo' })).resolves.toMatchObject({
      resumed: true,
    });
  });
});
