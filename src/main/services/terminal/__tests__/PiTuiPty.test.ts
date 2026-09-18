import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zhTranslations } from '@shared/i18n';
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
      {
        file: '/app/node',
        // `--session-dir` pins where `/new` writes; see `buildPiTuiArgs`.
        args: ['/app/pi/cli.js', '--session', '/repo/s.jsonl', '--session-dir', '/repo'],
      },
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
  it('ships a Chinese entry for the refusal it sends the renderer', () => {
    // T065 回炉: this sentence is a dictionary KEY (Main has no translator), and
    // since the open path started showing refusals in a toast it is on screen
    // rather than swallowed. `i18nCoverage` only sees `t('literal')` call sites
    // under src/renderer, so it cannot see a key that travels in a variable.
    expect(zhTranslations[PI_TUI_SESSION_MISMATCH_REASON]).toBeTruthy();
  });

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

/**
 * D17 (real-machine point check DEV-14) — switching to another chat and back
 * left the terminal area entirely blank while the PTY was still alive and still
 * echoing keystrokes. Two halves each behaved correctly: the replay buffer only
 * collects output produced WHILE parked, and a parked pi is idle, so there was
 * nothing to send; the renderer meanwhile rebuilt its xterm from scratch, with
 * an empty scrollback. Nobody owned the repaint at the seam.
 */
/**
 * D17 — the screen a parked pi comes back to.
 *
 * The first landing nudged the size off and straight back inside the open call,
 * and the real machine said no: the screen stayed blank, 10 bytes came back, and
 * a manual `piTui.resize(id, 70, 20)` fixed it instantly. Both ioctls ran in one
 * synchronous turn, so the child was scheduled once, after both, and read a
 * winsize identical to its own — a change of zero is not a change. What is
 * pinned here is the property that failure lacked: when the open returns, the
 * PTY is at a size the child does NOT have, and it is still there for the child
 * to read.
 */
describe('PiTuiPtyController — a resumed terminal is told to repaint', () => {
  it('leaves the PTY at a size the parked pi does not have, instead of undoing it', async () => {
    const { controller, ptys } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', cols: 100, rows: 30 });
    await controller.suspend('one');
    // The defect's exact shape: parked, produced nothing, resumed at the size
    // it was parked at — so a plain resize cannot raise SIGWINCH at all.
    const beforeResume = ptys[0]?.resizes.length ?? 0;

    await expect(
      controller.open({ terminalId: 'one', cwd: '/repo', cols: 100, rows: 30 })
    ).resolves.toMatchObject({ resumed: true });

    // One row SHORTER, so the frame pi paints while primed fits in the new
    // xterm rather than scrolling its top line away.
    expect(ptys[0]?.resizes.slice(beforeResume)).toEqual([
      [100, 30],
      [100, 29],
    ]);
    // The assertion the old nudge failed: the change is still standing when the
    // open returns, so the child has something different to read.
    expect(ptys[0]?.resizes.at(-1)).not.toEqual([100, 30]);
  });

  it('goes back to the true size when the renderer confirms it, as a second change', async () => {
    const { controller, ptys } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', cols: 100, rows: 30 });
    await controller.suspend('one');
    await controller.open({ terminalId: 'one', cwd: '/repo', cols: 100, rows: 30 });

    // `useXterm.confirmPiTuiSize`, sent once the rebuilt xterm is attached: a
    // separate IPC message, hence a separate turn with the child scheduled in
    // between — which is what makes this a transition the child can observe.
    await controller.resize('one', 100, 30);

    expect(ptys[0]?.resizes.slice(-2)).toEqual([
      [100, 29],
      [100, 30],
    ]);
  });

  it('primes upwards when the terminal is already at the row floor', async () => {
    // `boundedDimension` clamps rows at 5, so subtracting there would land back
    // on the same number — the exact no-op this fix exists to avoid.
    const { controller, ptys } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', cols: 100, rows: 5 });
    await controller.suspend('one');

    await controller.open({ terminalId: 'one', cwd: '/repo', cols: 100, rows: 5 });

    expect(ptys[0]?.resizes.at(-1)).toEqual([100, 6]);
  });

  it('still flushes the replay buffer, and puts the repaint after it', async () => {
    const { controller, ptys, data } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', cols: 100, rows: 30 });
    await controller.suspend('one');
    ptys[0]?.emitData('parked');

    await controller.open({ terminalId: 'one', cwd: '/repo', cols: 100, rows: 30 });

    expect(data).toEqual([{ terminalId: 'one', data: 'parked' }]);
    // Last, so pi's repaint lands on top of the replayed bytes rather than
    // under them.
    expect(ptys[0]?.resizes.at(-1)).toEqual([100, 29]);
  });

  it('does not prime a terminal that was just spawned', async () => {
    // Reverse check: a fresh PTY is created at the requested size and paints
    // itself, so leaving it at the wrong size would be a real defect rather
    // than a repaint.
    const { controller, ptys } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo', cols: 100, rows: 30 });

    expect(ptys[0]?.resizes).toEqual([]);
  });
});

/**
 * T066 — terminal mode used to start and stop a second process on the user's
 * session file with no line anywhere.
 *
 * The field pass grepped main.log, the daily log and the dev-server output for
 * the spawn, the exit and the exit code, and found none of the three. What is
 * pinned here is that the lines exist, that the spawn summary carries argv
 * only (the environment holds the credentials, and the initial prompt is
 * deliberately kept out of argv), and that a bad exit reaches the warn channel.
 */
describe('PiTuiPtyController logging (T066)', () => {
  let logs: string[];
  let warns: string[];

  beforeEach(() => {
    logs = [];
    warns = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the spawn with the argv summary and the working directory', async () => {
    const { controller } = harness();

    await controller.open({
      terminalId: 'one',
      cwd: '/repo',
      sessionFile: '/home/tester/.pilab/sessions/s1.jsonl',
      initialPrompt: 'secret task',
    });

    const spawn = logs.filter((line) => line.includes('[pi-tui] Spawned terminal one'));
    expect(spawn).toHaveLength(1);
    expect(spawn[0]).toContain('/app/node /app/pi/cli.js --session');
    expect(spawn[0]).toContain('/repo');
    // Two things that must never reach a log line: the prompt (it is written
    // through the PTY for exactly this reason) and the username in a path.
    expect(spawn[0]).not.toContain('secret task');
    expect(spawn[0]).not.toContain('/home/tester');
  });

  it('logs a clean exit with its code on the info channel', async () => {
    const { controller, ptys } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo' });

    ptys[0]?.emitExit(0);

    expect(
      logs.filter((line) => line.includes('[pi-tui] Terminal one exited (code=0'))
    ).toHaveLength(1);
    expect(warns).toEqual([]);
  });

  it('raises a non-zero exit to the warn channel', async () => {
    const { controller, ptys } = harness();
    await controller.open({ terminalId: 'one', cwd: '/repo' });

    ptys[0]?.emitExit(3);

    expect(
      warns.filter((line) => line.includes('[pi-tui] Terminal one exited (code=3'))
    ).toHaveLength(1);
  });
});
