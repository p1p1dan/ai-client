import { EventEmitter } from 'node:events';
import type { AgentHostCommand } from '@shared/types/agentHost';
import type { RuntimeEvent, RuntimeEventType } from '@shared/types/runtimeEvents';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// AgentHostManager only touches `electron.app` inside startInternal() (process spawn path),
// which these tests never reach — they prime the manager directly into the 'ready' state with
// a fake process. Mocked anyway to match project convention and stay resilient to refactors.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/app',
  },
}));

// electron-log touches app paths at import time; the manager only needs a sink.
// vi.hoisted because vi.mock factories are lifted above plain const declarations.
const logSpy = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../../../utils/logger', () => ({ default: logSpy, initLogger: vi.fn() }));

/** Minimal EventEmitter stand-in for AgentHostProcess: 'event' / 'exit' + isRunning + send(). */
class FakeAgentHostProcess extends EventEmitter {
  isRunning = true;
  send = vi.fn();
}

type ManagerInternals = {
  process: FakeAgentHostProcess | null;
  state: 'stopped' | 'starting' | 'ready' | 'error';
  requestAndWait(
    command: AgentHostCommand,
    eventType: RuntimeEventType,
    timeoutMs?: number
  ): Promise<RuntimeEvent>;
};

async function primeReadyManager() {
  const { AgentHostManager } = await import('../AgentHostManager');
  const manager = new AgentHostManager();
  const proc = new FakeAgentHostProcess();
  const internals = manager as unknown as ManagerInternals;
  // Bypass startInternal (real spawn) — ensureStarted() short-circuits once
  // state is 'ready' and the process reports isRunning, which is all
  // requestAndWait needs to proceed straight to send() + event listening.
  internals.state = 'ready';
  internals.process = proc;
  return { manager, proc, internals };
}

const listHistoryCommand: AgentHostCommand = {
  protocolVersion: 1,
  requestId: 'req-1',
  type: 'session.listHistory',
  payload: { workspacePath: '/ws/a' },
};

/**
 * requestAndWait attaches its 'event'/'exit' listeners only after `await
 * ensureStarted()` settles (one microtask tick, even when already 'ready') and
 * sends the command right after — so tests must wait for that send before
 * emitting on the fake process, otherwise the emit happens before anyone is
 * listening (a real Host can never race this: it can't reply before it's sent).
 */
async function waitUntilSent(proc: FakeAgentHostProcess): Promise<void> {
  await vi.waitFor(() => expect(proc.send).toHaveBeenCalledTimes(1));
}

describe('AgentHostManager.requestAndWait', () => {
  it('resolves with the correlated event and cleans up its listeners', async () => {
    const { proc, internals } = await primeReadyManager();

    const promise = internals.requestAndWait(listHistoryCommand, 'session.historyListed', 200);
    await waitUntilSent(proc);
    const event: RuntimeEvent = {
      type: 'session.historyListed',
      seq: 1,
      requestId: 'req-1',
      timestamp: Date.now(),
      payload: { workspacePath: '/ws/a', sessions: [] },
    };
    proc.emit('event', event);

    await expect(promise).resolves.toEqual(event);
    expect(proc.send).toHaveBeenCalledWith(listHistoryCommand);
    expect(proc.listenerCount('event')).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
  });

  it('ignores events with a different requestId', async () => {
    const { proc, internals } = await primeReadyManager();

    const promise = internals.requestAndWait(listHistoryCommand, 'session.historyListed', 200);
    await waitUntilSent(proc);
    proc.emit('event', {
      type: 'session.historyListed',
      seq: 1,
      requestId: 'req-other',
      timestamp: Date.now(),
      payload: { workspacePath: '/ws/a', sessions: [] },
    } satisfies RuntimeEvent);

    const matching: RuntimeEvent = {
      type: 'session.historyListed',
      seq: 2,
      requestId: 'req-1',
      timestamp: Date.now(),
      payload: { workspacePath: '/ws/a', sessions: [] },
    };
    proc.emit('event', matching);

    await expect(promise).resolves.toEqual(matching);
  });

  it('rejects with code/message when a correlated host.error arrives', async () => {
    const { proc, internals } = await primeReadyManager();

    const promise = internals.requestAndWait(listHistoryCommand, 'session.historyListed', 200);
    await waitUntilSent(proc);
    proc.emit('event', {
      type: 'host.error',
      seq: 1,
      requestId: 'req-1',
      timestamp: Date.now(),
      payload: { code: 'not_implemented', message: 'session.listHistory is not supported' },
    } satisfies RuntimeEvent);

    await expect(promise).rejects.toThrow('not_implemented: session.listHistory is not supported');
    expect(proc.listenerCount('event')).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
  });

  it('rejects immediately on Host process exit, without waiting for the timeout', async () => {
    const { proc, internals } = await primeReadyManager();

    const promise = internals.requestAndWait(listHistoryCommand, 'session.historyListed', 5000);
    await waitUntilSent(proc);
    // If this fell through to the timeout instead, the 5s timeout would blow the test's
    // default timeout budget — exit must reject immediately, not "eventually".
    proc.emit('exit', { code: 1, signal: null });

    await expect(promise).rejects.toThrow(/exited/i);
    expect(proc.listenerCount('event')).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
  });

  it('rejects on timeout when no correlated event ever arrives', async () => {
    const { internals } = await primeReadyManager();

    const promise = internals.requestAndWait(listHistoryCommand, 'session.historyListed', 20);

    await expect(promise).rejects.toThrow(/timed out/i);
  });
});

describe('AgentHostManager.listHistory', () => {
  it('returns payload.sessions on a successful session.historyListed reply', async () => {
    const { manager, proc } = await primeReadyManager();

    const promise = manager.listHistory('/ws/a');
    await vi.waitFor(() => expect(proc.send).toHaveBeenCalledTimes(1));
    const sentCommand = proc.send.mock.calls[0][0] as AgentHostCommand;

    proc.emit('event', {
      type: 'session.historyListed',
      seq: 1,
      requestId: sentCommand.requestId,
      timestamp: Date.now(),
      payload: {
        workspacePath: '/ws/a',
        sessions: [
          {
            runtimeIdentity: 'r1',
            workspacePath: '/ws/a',
            title: null,
            firstMessage: null,
            createdAt: null,
            lastMessageAt: null,
            model: null,
          },
        ],
      },
    } satisfies RuntimeEvent);

    await expect(promise).resolves.toEqual([
      expect.objectContaining({ runtimeIdentity: 'r1', workspacePath: '/ws/a' }),
    ]);
  });

  it('throws code: message when the historyListed payload carries a non-fatal read error', async () => {
    const { manager, proc } = await primeReadyManager();

    const promise = manager.listHistory('/ws/a');
    await vi.waitFor(() => expect(proc.send).toHaveBeenCalledTimes(1));
    const sentCommand = proc.send.mock.calls[0][0] as AgentHostCommand;

    proc.emit('event', {
      type: 'session.historyListed',
      seq: 1,
      requestId: sentCommand.requestId,
      timestamp: Date.now(),
      payload: {
        workspacePath: '/ws/a',
        sessions: [],
        error: { code: 'read_failed', message: 'boom' },
      },
    } satisfies RuntimeEvent);

    await expect(promise).rejects.toThrow('read_failed: boom');
  });
});

/**
 * `stderr` and `error` had no listener before 2026-07-28: Host diagnostics were
 * dropped on the floor (a bad `cwd` surfaced only as a generic "Session failed"
 * with nothing in main.log), and an unhandled 'error' event on an EventEmitter
 * throws — a spawn failure would have crashed the Main process.
 *
 * attachProcessHandlers() is exercised directly because startInternal() spawns
 * a real child process and cannot run under vitest.
 */
describe('AgentHostManager.attachProcessHandlers', () => {
  async function attachedManager() {
    const { AgentHostManager } = await import('../AgentHostManager');
    const manager = new AgentHostManager();
    const proc = new FakeAgentHostProcess();
    const internals = manager as unknown as {
      process: FakeAgentHostProcess | null;
      state: string;
      attachProcessHandlers(p: FakeAgentHostProcess): void;
    };
    internals.attachProcessHandlers(proc);
    internals.process = proc;
    internals.state = 'ready';
    return { proc, internals };
  }

  beforeEach(() => {
    logSpy.info.mockClear();
    logSpy.error.mockClear();
  });

  it('logs each complete Host stderr line', async () => {
    const { proc } = await attachedManager();

    proc.emit('stderr', '[agent-host] starting\n[agent-host] cometix resolved\n');

    const logged = logSpy.info.mock.calls.map((c) => c[0] as string);
    expect(logged).toContain('[agent-host:stderr] [agent-host] starting');
    expect(logged).toContain('[agent-host:stderr] [agent-host] cometix resolved');
  });

  it('joins a line split across two stderr chunks instead of logging halves', async () => {
    const { proc } = await attachedManager();

    proc.emit('stderr', 'cometix reso');
    expect(logSpy.info).not.toHaveBeenCalled();

    proc.emit('stderr', 'lved\n');
    expect(logSpy.info).toHaveBeenCalledWith('[agent-host:stderr] cometix resolved');
  });

  it('flushes an unterminated final stderr line on exit', async () => {
    const { proc } = await attachedManager();

    proc.emit('stderr', 'fatal: no newline at the end');
    proc.emit('exit', { code: 1, signal: null });

    const logged = logSpy.info.mock.calls.map((c) => c[0] as string);
    expect(logged).toContain('[agent-host:stderr] fatal: no newline at the end');
    // A non-zero exit is escalated to error level (see host-failure diagnostics below).
    const escalated = logSpy.error.mock.calls.map((c) => String(c[0]));
    expect(escalated).toContain('[agent-host] exited code=1 signal=null');
  });

  it('survives an exit emitted without a payload', async () => {
    const { proc, internals } = await attachedManager();

    expect(() => proc.emit('exit')).not.toThrow();
    expect(internals.state).toBe('stopped');
  });

  it('logs a spawn error and degrades to the error state instead of throwing', async () => {
    const { proc, internals } = await attachedManager();
    const err = new Error('spawn ENOENT');

    // An unhandled 'error' event would throw here — the listener is the fix.
    expect(() => proc.emit('error', err)).not.toThrow();
    expect(logSpy.error).toHaveBeenCalledWith('[agent-host] process error', err);
    expect(internals.state).toBe('error');
  });
});

/**
 * S7 (round-2 iteration-3 review): `getStatus()` only ever read state/pid/
 * driver/cometixVersion — `settings` was never captured off `host.ready` at
 * all, so a consumer that mounts AFTER the live event already fired (e.g.
 * `HistoryErrorNotice` in `MessageTimeline.tsx`, which only ever mounts in
 * session mode, well after boot) read `settings: undefined` forever and
 * silently fell back to the catalog default model instead of the Host's own.
 */
describe('AgentHostManager.getStatus — settings (S7, round-2 iteration-3 review)', () => {
  async function attached() {
    const { AgentHostManager } = await import('../AgentHostManager');
    const manager = new AgentHostManager();
    const proc = new FakeAgentHostProcess();
    const internals = manager as unknown as {
      process: FakeAgentHostProcess | null;
      state: string;
      attachProcessHandlers(p: FakeAgentHostProcess): void;
    };
    internals.attachProcessHandlers(proc);
    internals.process = proc;
    internals.state = 'ready';
    return { manager, proc };
  }

  it('is null before any host.ready event has ever landed', async () => {
    const { manager } = await attached();
    expect(manager.getStatus().settings).toBeNull();
  });

  it('captures the settings diagnostics from a live host.ready event', async () => {
    const { manager, proc } = await attached();

    proc.emit('event', {
      type: 'host.ready',
      seq: 1,
      timestamp: Date.now(),
      payload: {
        protocolVersion: 1,
        driver: 'agent-sdk',
        nodeVersion: 'v24.0.0',
        settings: {
          loaded: true,
          hasAuthToken: true,
          hasBaseUrl: false,
          baseHost: null,
          model: 'opus',
        },
      },
    } satisfies RuntimeEvent);

    expect(manager.getStatus()).toMatchObject({
      state: 'ready',
      settings: {
        loaded: true,
        hasAuthToken: true,
        hasBaseUrl: false,
        baseHost: null,
        model: 'opus',
      },
    });
  });

  it('normalizes an absent settings field (old Host build) to null, not undefined', async () => {
    const { manager, proc } = await attached();

    proc.emit('event', {
      type: 'host.ready',
      seq: 1,
      timestamp: Date.now(),
      payload: { protocolVersion: 1, driver: 'agent-sdk', nodeVersion: 'v24.0.0' },
    } satisfies RuntimeEvent);

    expect(manager.getStatus().settings).toBeNull();
  });

  it('replaces a PRIOR ready event’s settings on a later host.ready (a Host restart reporting different diagnostics)', async () => {
    const { manager, proc } = await attached();

    proc.emit('event', {
      type: 'host.ready',
      seq: 1,
      timestamp: Date.now(),
      payload: {
        protocolVersion: 1,
        driver: 'agent-sdk',
        nodeVersion: 'v24.0.0',
        settings: {
          loaded: true,
          hasAuthToken: true,
          hasBaseUrl: false,
          baseHost: null,
          model: 'opus',
        },
      },
    } satisfies RuntimeEvent);

    proc.emit('event', {
      type: 'host.ready',
      seq: 2,
      timestamp: Date.now(),
      payload: { protocolVersion: 1, driver: 'agent-sdk', nodeVersion: 'v24.0.0', settings: null },
    } satisfies RuntimeEvent);

    expect(manager.getStatus().settings).toBeNull();
  });
});

/**
 * S3 slice 6 (A5): `capabilities` is captured off `host.ready` the same way
 * `settings` is above — a consumer that mounts AFTER the live event already
 * fired (Main-side `getStatus()` callers, e.g. `useHostStatus.ts`'s prime
 * call) must still be able to read `capabilities.agents` (the
 * HostAgentRegistry's wire form) instead of `undefined` forever.
 */
describe('AgentHostManager.getStatus — capabilities (S3 slice 6, A5)', () => {
  async function attached() {
    const { AgentHostManager } = await import('../AgentHostManager');
    const manager = new AgentHostManager();
    const proc = new FakeAgentHostProcess();
    const internals = manager as unknown as {
      process: FakeAgentHostProcess | null;
      state: string;
      attachProcessHandlers(p: FakeAgentHostProcess): void;
    };
    internals.attachProcessHandlers(proc);
    internals.process = proc;
    internals.state = 'ready';
    return { manager, proc };
  }

  it('is null before any host.ready event has ever landed', async () => {
    const { manager } = await attached();
    expect(manager.getStatus().capabilities).toBeNull();
  });

  it('captures capabilities.agents from a live host.ready event', async () => {
    const { manager, proc } = await attached();

    proc.emit('event', {
      type: 'host.ready',
      seq: 1,
      timestamp: Date.now(),
      payload: {
        protocolVersion: 1,
        driver: 'agent-sdk',
        nodeVersion: 'v24.0.0',
        capabilities: {
          history: true,
          thinking: true,
          subagentActivity: false,
          agents: ['claude-code', 'codex'],
        },
      },
    } satisfies RuntimeEvent);

    expect(manager.getStatus()).toMatchObject({
      state: 'ready',
      capabilities: {
        history: true,
        thinking: true,
        subagentActivity: false,
        agents: ['claude-code', 'codex'],
      },
    });
  });

  it('normalizes an absent capabilities field (old Host build) to null, not undefined', async () => {
    const { manager, proc } = await attached();

    proc.emit('event', {
      type: 'host.ready',
      seq: 1,
      timestamp: Date.now(),
      payload: { protocolVersion: 1, driver: 'agent-sdk', nodeVersion: 'v24.0.0' },
    } satisfies RuntimeEvent);

    expect(manager.getStatus().capabilities).toBeNull();
  });

  it('replaces a PRIOR ready event’s capabilities on a later host.ready (a Host restart that lost the flag)', async () => {
    const { manager, proc } = await attached();

    proc.emit('event', {
      type: 'host.ready',
      seq: 1,
      timestamp: Date.now(),
      payload: {
        protocolVersion: 1,
        driver: 'agent-sdk',
        nodeVersion: 'v24.0.0',
        capabilities: { agents: ['claude-code', 'codex'] },
      },
    } satisfies RuntimeEvent);

    proc.emit('event', {
      type: 'host.ready',
      seq: 2,
      timestamp: Date.now(),
      payload: { protocolVersion: 1, driver: 'agent-sdk', nodeVersion: 'v24.0.0' },
    } satisfies RuntimeEvent);

    expect(manager.getStatus().capabilities).toBeNull();
  });

  it('settings and capabilities are captured independently off the same host.ready event', async () => {
    const { manager, proc } = await attached();

    proc.emit('event', {
      type: 'host.ready',
      seq: 1,
      timestamp: Date.now(),
      payload: {
        protocolVersion: 1,
        driver: 'agent-sdk',
        nodeVersion: 'v24.0.0',
        settings: {
          loaded: true,
          hasAuthToken: true,
          hasBaseUrl: false,
          baseHost: null,
          model: 'opus',
        },
        capabilities: { agents: ['claude-code'] },
      },
    } satisfies RuntimeEvent);

    const status = manager.getStatus();
    expect(status.settings).toEqual({
      loaded: true,
      hasAuthToken: true,
      hasBaseUrl: false,
      baseHost: null,
      model: 'opus',
    });
    expect(status.capabilities).toEqual({ agents: ['claude-code'] });
  });
});

/**
 * The stderr wiring is only useful if a failure reaches the log FILE. This app
 * ships file logging at 'error' unless the user enables it (logger.ts
 * initLogger defaults enabled=false), so info-level stderr lines are dropped in
 * the configuration almost everyone runs — a failure must escalate its own
 * buffered context to 'error' or the log is empty exactly when it matters.
 */
describe('AgentHostManager host-failure diagnostics', () => {
  async function attached() {
    const { AgentHostManager } = await import('../AgentHostManager');
    const manager = new AgentHostManager();
    const proc = new FakeAgentHostProcess();
    const internals = manager as unknown as {
      process: FakeAgentHostProcess | null;
      state: string;
      attachProcessHandlers(p: FakeAgentHostProcess): void;
    };
    internals.attachProcessHandlers(proc);
    internals.process = proc;
    internals.state = 'ready';
    return { proc, internals };
  }

  beforeEach(() => {
    logSpy.info.mockClear();
    logSpy.error.mockClear();
  });

  const errorText = () => logSpy.error.mock.calls.map((c) => String(c[0]));

  it('replays buffered stderr at error level on a non-zero exit', async () => {
    const { proc } = await attached();

    proc.emit('stderr', '[agent-host] starting\ncometix resolved\n');
    expect(errorText()).toHaveLength(0);

    proc.emit('exit', { code: 1, signal: null });

    expect(errorText()).toContain('[agent-host] exited code=1 signal=null');
    expect(errorText()).toContain('[agent-host:stderr] [agent-host] starting');
    expect(errorText()).toContain('[agent-host:stderr] cometix resolved');
  });

  it('replays buffered stderr at error level on a spawn error', async () => {
    const { proc } = await attached();

    proc.emit('stderr', 'boot banner\n');
    proc.emit('error', new Error('spawn ENOENT'));

    expect(errorText()).toContain('[agent-host:stderr] boot banner');
  });

  it('stays quiet at error level on a clean shutdown', async () => {
    const { proc } = await attached();

    proc.emit('stderr', '[agent-host] starting\n');
    proc.emit('exit', { code: 0, signal: null });

    expect(logSpy.error).not.toHaveBeenCalled();
    expect(logSpy.info).toHaveBeenCalledWith('[agent-host] exited code=0 signal=null');
  });

  it('treats our own SIGTERM shutdown as clean', async () => {
    const { proc } = await attached();

    proc.emit('stderr', '[agent-host] starting\n');
    proc.emit('exit', { code: null, signal: 'SIGTERM' });

    expect(logSpy.error).not.toHaveBeenCalled();
  });
});
