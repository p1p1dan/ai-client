import { EventEmitter } from 'node:events';
import type { AgentHostCommand } from '@shared/types/agentHost';
import type { RuntimeEvent, RuntimeEventType } from '@shared/types/runtimeEvents';
import { describe, expect, it, vi } from 'vitest';

// AgentHostManager only touches `electron.app` inside startInternal() (process spawn path),
// which these tests never reach — they prime the manager directly into the 'ready' state with
// a fake process. Mocked anyway to match project convention and stay resilient to refactors.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/app',
  },
}));

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
