import { describe, expect, it, vi } from 'vitest';
import type { PiWorkerRuntimeOptions } from '../../../agent-host/piWorkerRpcServer.ts';
import type { DshHostToMainMessage } from '../../../shared/types/dshHostProtocol.ts';
import { WORKER_RPC_PROTOCOL_VERSION } from '../../../shared/types/workerRpc.ts';
import { type ChannelRuntime, DshChannelMux } from '../channelMux.ts';

/**
 * dsh-rebase P1-3a — the shared host's bridge multiplexer (BR cases of the
 * P1-3 plan) against fake session runtimes: no DSH package, no process. The
 * real engine is exercised by `tools/bridge-smoke.ts`.
 */

interface FakeRuntime {
  busy: boolean;
  disposed: number;
  options: PiWorkerRuntimeOptions;
}

function harness(options: { hangingDispose?: boolean } = {}) {
  const sent: DshHostToMainMessage[] = [];
  const runtimes: FakeRuntime[] = [];
  const log = vi.fn();
  const mux = new DshChannelMux({
    send: (message) => sent.push(message),
    createRuntime: (runtimeOptions) => {
      const runtime = {
        busy: false,
        disposed: 0,
        options: runtimeOptions,
        async bootstrap() {
          return {
            bootstrapped: true,
            logicalSessionId: runtimeOptions.logicalSessionId,
            piSessionId: `aiclient-${runtimeOptions.logicalSessionId}`,
            cwd: runtimeOptions.cwd,
            agentDir: '/dsh-home',
            sessionFile: `/dsh-home/aiclient-sessions/${runtimeOptions.logicalSessionId}.dsh.json`,
            leaf: { activeEntryId: null, fileTailEntryId: null },
            projectTrusted: true,
            permissionGate: 'bundled',
          };
        },
        async startSend(input: { requestId: string }) {
          runtimeOptions.emit({
            type: 'session.status',
            sessionId: runtimeOptions.logicalSessionId,
            requestId: input.requestId,
            payload: { status: 'running' },
          });
          return { accepted: true, requestId: input.requestId };
        },
        async dispose() {
          runtime.disposed += 1;
          if (options.hangingDispose) await new Promise(() => {});
        },
      };
      runtimes.push(runtime);
      return runtime as unknown as ChannelRuntime;
    },
    sample: () => ({ eldMaxMs: 1.5, rssMb: 180.2 }),
    log,
  });
  return { mux, sent, runtimes, log };
}

function rpc(type: string, payload: unknown, requestId: string, generation = 1) {
  return {
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    kind: 'request',
    generation,
    requestId,
    type,
    payload,
  };
}

function bootstrap(ch: string, session: string, requestId = `boot-${ch}`, generation = 1) {
  return {
    ch,
    rpc: rpc(
      'worker.bootstrap',
      { logicalSessionId: session, cwd: '/repo' },
      requestId,
      generation
    ),
  };
}

/** Lets each channel's request chain run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((done) => setImmediate(done));
}

function responses(sent: DshHostToMainMessage[], ch: string) {
  return sent
    .filter((message) => 'ch' in message && 'rpc' in message && message.ch === ch)
    .map((message) => (message as unknown as { rpc: Record<string, unknown> }).rpc)
    .filter((message) => message.kind === 'response');
}

describe('DshChannelMux — opening channels (BR-01)', () => {
  it('opens a channel on worker.bootstrap and answers on that channel', async () => {
    const h = harness();
    expect(h.mux.receive(bootstrap('c1-1', 's1'))).toBe(true);
    await settle();
    expect(responses(h.sent, 'c1-1')).toEqual([
      expect.objectContaining({ requestId: 'boot-c1-1', ok: true, generation: 1 }),
    ]);
    expect(h.mux.status()).toEqual([{ ch: 'c1-1', busy: false }]);
    expect(h.runtimes).toHaveLength(1);
  });

  it('answers any other request for an unknown channel WORKER_CHANNEL_UNKNOWN, with its own generation and id', async () => {
    const h = harness();
    h.mux.receive({ ch: 'c2-9', rpc: rpc('worker.history', { logicalSessionId: 's1' }, 'r-9', 4) });
    await settle();
    expect(h.sent).toEqual([
      {
        ch: 'c2-9',
        rpc: {
          protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
          kind: 'response',
          generation: 4,
          requestId: 'r-9',
          ok: false,
          error: {
            code: 'WORKER_CHANNEL_UNKNOWN',
            message: expect.stringContaining('c2-9'),
            retryable: false,
          },
        },
      },
    ]);
    expect(h.runtimes).toHaveLength(0);
    expect(h.mux.status()).toEqual([]);
  });

  it('drops what cannot be answered: a non-request, or an opening request without a generation', async () => {
    const h = harness();
    h.mux.receive({ ch: 'c1-1', rpc: { kind: 'event', type: 'runtime.event', payload: {} } });
    h.mux.receive(bootstrap('c1-2', 's2', 'boot', 0));
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.runtimes).toHaveLength(0);
    expect(h.log).toHaveBeenCalledTimes(2);
  });

  it('leaves everything that is not the bridge’s to the other listeners', () => {
    const h = harness();
    for (const message of [
      { type: 'shutdown' },
      { type: 'create-session', requestId: 'p1' },
      { p06: 'mem', requestId: 'p2' },
      null,
      'text',
    ]) {
      expect(h.mux.receive(message)).toBe(false);
    }
    expect(h.sent).toEqual([]);
  });

  it('consumes an unknown host control kind with one diagnostic, and a malformed envelope too', () => {
    const h = harness();
    expect(h.mux.receive({ host: 'gc', claimed: [] })).toBe(true);
    expect(h.mux.receive({ host: 'gc', claimed: [] })).toBe(true);
    expect(h.mux.receive({ ch: 'slot-1', rpc: {} })).toBe(true);
    expect(h.sent).toEqual([]);
    expect(h.log).toHaveBeenCalledTimes(2);
  });
});

describe('DshChannelMux — isolation (BR-02)', () => {
  it('keeps each channel’s events, answers and generation to itself', async () => {
    const h = harness();
    h.mux.receive(bootstrap('c1-1', 's1', 'b1', 1));
    h.mux.receive(bootstrap('c1-2', 's2', 'b2', 7));
    await settle();
    h.mux.receive({
      ch: 'c1-1',
      rpc: rpc(
        'worker.send',
        { logicalSessionId: 's1', requestId: 'turn-1', attemptId: 'a1', text: 'hi' },
        'send-1',
        1
      ),
    });
    // The generation belongs to the channel: 1 is stale on c1-2.
    h.mux.receive({
      ch: 'c1-2',
      rpc: rpc(
        'worker.send',
        { logicalSessionId: 's2', requestId: 'turn-2', attemptId: 'a2', text: 'hi' },
        'send-2',
        1
      ),
    });
    await settle();
    const events = (ch: string) =>
      h.sent
        .filter((message) => 'ch' in message && message.ch === ch)
        .map((message) => (message as unknown as { rpc: Record<string, unknown> }).rpc)
        .filter((message) => message.kind === 'event')
        .map((message) => (message.payload as { sessionId: string }).sessionId);
    expect(events('c1-1')).toEqual(['s1']);
    expect(events('c1-2')).toEqual([]);
    expect(responses(h.sent, 'c1-1').map((message) => [message.requestId, message.ok])).toEqual([
      ['b1', true],
      ['send-1', true],
    ]);
    expect(responses(h.sent, 'c1-2').map((message) => [message.requestId, message.ok])).toEqual([
      ['b2', true],
      ['send-2', false],
    ]);
    expect(responses(h.sent, 'c1-2')[1]).toMatchObject({
      generation: 1,
      error: { code: 'WORKER_STALE_GENERATION' },
    });
  });
});

describe('DshChannelMux — closing channels (BR-03, BR-04)', () => {
  it('worker.dispose answers its ACK, then closed; the channel never comes back', async () => {
    const h = harness();
    h.mux.receive(bootstrap('c1-1', 's1'));
    await settle();
    h.mux.receive({ ch: 'c1-1', rpc: rpc('worker.dispose', { reason: 'slot-dispose' }, 'd1') });
    await settle();
    const tail = h.sent.slice(-2);
    expect(tail[0]).toMatchObject({ ch: 'c1-1', rpc: { requestId: 'd1', ok: true } });
    expect(tail[1]).toEqual({ host: 'closed', ch: 'c1-1' });
    expect(h.runtimes[0].disposed).toBe(1);
    expect(h.mux.status()).toEqual([]);
    // A late opening request cannot revive a closed id.
    h.mux.receive(bootstrap('c1-1', 's1', 'again'));
    await settle();
    expect(h.sent.at(-1)).toMatchObject({
      ch: 'c1-1',
      rpc: { requestId: 'again', ok: false, error: { code: 'WORKER_CHANNEL_UNKNOWN' } },
    });
    expect(h.runtimes).toHaveLength(1);
  });

  it('close disposes through the channel’s chain and answers closed, never its internal ACK', async () => {
    const h = harness();
    h.mux.receive(bootstrap('c1-1', 's1'));
    h.mux.receive(bootstrap('c1-2', 's2'));
    await settle();
    const before = h.sent.length;
    h.mux.receive({ host: 'close', ch: 'c1-1' });
    h.mux.receive({ host: 'close', ch: 'c1-1' });
    await settle();
    expect(h.sent.slice(before)).toEqual([{ host: 'closed', ch: 'c1-1' }]);
    expect(h.runtimes[0].disposed).toBe(1);
    expect(h.runtimes[1].disposed).toBe(0);
    expect(h.mux.status()).toEqual([{ ch: 'c1-2', busy: false }]);
  });

  it('answers closed at once for a channel it never opened or already closed', async () => {
    const h = harness();
    h.mux.receive({ host: 'close', ch: 'c3-1' });
    expect(h.sent).toEqual([{ host: 'closed', ch: 'c3-1' }]);
    h.mux.receive(bootstrap('c3-2', 's1'));
    await settle();
    h.mux.receive({ ch: 'c3-2', rpc: rpc('worker.dispose', { reason: 'slot-dispose' }, 'd') });
    await settle();
    // The slot's own close can cross the host's `closed` on the wire.
    h.mux.receive({ host: 'close', ch: 'c3-2' });
    expect(h.sent.filter((message) => 'host' in message && message.host === 'closed')).toEqual([
      { host: 'closed', ch: 'c3-1' },
      { host: 'closed', ch: 'c3-2' },
      { host: 'closed', ch: 'c3-2' },
    ]);
  });

  it('never answers closed while the runtime’s disposal hangs (BR-04)', async () => {
    const h = harness({ hangingDispose: true });
    h.mux.receive(bootstrap('c1-1', 's1'));
    await settle();
    h.mux.receive({ host: 'close', ch: 'c1-1' });
    await settle();
    expect(h.sent.some((message) => 'host' in message && message.host === 'closed')).toBe(false);
    expect(h.mux.status()).toEqual([{ ch: 'c1-1', busy: false }]);
    // Main's retry does not queue a second disposal behind the first.
    h.mux.receive({ host: 'close', ch: 'c1-1' });
    await settle();
    expect(h.runtimes[0].disposed).toBe(1);
  });
});

describe('DshChannelMux — heartbeat (BR-05)', () => {
  it('answers ping at once, beside a channel whose chain is stuck, with busy flags', async () => {
    const h = harness({ hangingDispose: true });
    h.mux.receive(bootstrap('c1-1', 's1'));
    h.mux.receive(bootstrap('c1-2', 's2'));
    await settle();
    h.mux.receive({ host: 'close', ch: 'c1-1' });
    h.runtimes[1].busy = true;
    const before = h.sent.length;
    h.mux.receive({ host: 'ping', id: 42 });
    // Synchronous: no session work stands between a ping and its pong.
    expect(h.sent.slice(before)).toEqual([
      {
        host: 'pong',
        id: 42,
        eldMaxMs: 1.5,
        rssMb: 180.2,
        channels: [
          { ch: 'c1-1', busy: false },
          { ch: 'c1-2', busy: true },
        ],
      },
    ]);
  });
});
