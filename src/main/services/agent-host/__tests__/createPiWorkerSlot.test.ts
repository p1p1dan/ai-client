import { WORKER_RPC_PROTOCOL_VERSION, type WorkerRpcRequest } from '@shared/types/workerRpc';
import { describe, expect, it, vi } from 'vitest';
import { createPiWorkerSlot } from '../createPiWorkerSlot';
import type { WorkerTransport, WorkerTransportExit } from '../WorkerTransport';

class LoopbackTransport implements WorkerTransport {
  readonly pid = 4321;
  readonly requests: WorkerRpcRequest[] = [];
  readonly kill = vi.fn(() => true);
  private messageListeners = new Set<(message: unknown) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private exitListeners = new Set<(exit: WorkerTransportExit) => void>();
  private stderrListeners = new Set<(chunk: string) => void>();

  postMessage(message: WorkerRpcRequest): void {
    this.requests.push(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onExit(listener: (exit: WorkerTransportExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onStderr(listener: (chunk: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  respond(request: WorkerRpcRequest, result: unknown): void {
    for (const listener of this.messageListeners) {
      listener({
        protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
        kind: 'response',
        generation: request.generation,
        requestId: request.requestId,
        ok: true,
        result,
      });
    }
  }

  exit(): void {
    for (const listener of this.exitListeners) listener({ code: 0, signal: null });
  }
}

describe('createPiWorkerSlot', () => {
  it('exposes process ownership before bootstrap acknowledgement', async () => {
    const transport = new LoopbackTransport();
    const onSlotCreated = vi.fn();
    const creating = createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      createTransport: () => transport,
      onSlotCreated,
    });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    expect(onSlotCreated).toHaveBeenCalledTimes(1);
    expect(onSlotCreated.mock.calls[0][0].pid).toBe(4321);
    transport.respond(transport.requests[0], {
      bootstrapped: true,
      logicalSessionId: 'logical-1',
      piSessionId: 'pi-1',
      cwd: '/repo',
      agentDir: '/managed/pi-agent',
      sessionFile: '/managed/pi-agent/sessions/one.jsonl',
      leaf: { activeEntryId: null, fileTailEntryId: null },
      projectTrusted: false,
      permissionGate: 'bundled',
    });
    await creating;
  });

  it('returns a slot only after one valid bootstrap acknowledgement', async () => {
    const transport = new LoopbackTransport();
    const creating = createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      generation: 2,
      model: 'pilab/company-model',
      effort: 'high',
      createTransport: () => transport,
    });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    expect(transport.requests[0]).toMatchObject({
      type: 'worker.bootstrap',
      generation: 2,
      payload: {
        logicalSessionId: 'logical-1',
        cwd: '/repo',
        model: 'pilab/company-model',
        effort: 'high',
      },
    });
    transport.respond(transport.requests[0], {
      bootstrapped: true,
      logicalSessionId: 'logical-1',
      piSessionId: 'pi-1',
      cwd: '/repo',
      agentDir: '/managed/pi-agent',
      sessionFile: '/managed/pi-agent/sessions/one.jsonl',
      leaf: { activeEntryId: null, fileTailEntryId: null },
      model: 'pilab/company-model',
      effort: 'high',
      projectTrusted: false,
      permissionGate: 'bundled',
    });

    const created = await creating;
    expect(created.slot.state).toBe('running');
    expect(created.slot.generation).toBe(2);
    expect(created.bootstrap.sessionFile).toContain('one.jsonl');
  });

  /**
   * P5-5. The catalog travels in the bootstrap payload rather than being read
   * off disk by the worker, and it is omitted entirely when Main has nothing to
   * hand over — an absent field is what keeps a pre-P5-5 install's payload
   * byte-identical to what it was, and what leaves the smoke lanes reading
   * their fixture directory.
   */
  it('carries the model catalog when one is supplied, and omits the field otherwise', async () => {
    const withCatalog = new LoopbackTransport();
    void createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      modelCatalog: {
        models: { providers: { gw: { api: 'anthropic-messages', models: [{ id: 'm' }] } } },
        auth: { gw: { type: 'api_key', key: 'sk' } },
      },
      createTransport: () => withCatalog,
    });
    await vi.waitFor(() => expect(withCatalog.requests).toHaveLength(1));
    expect(withCatalog.requests[0].payload).toMatchObject({
      modelCatalog: { auth: { gw: { type: 'api_key', key: 'sk' } } },
    });

    const without = new LoopbackTransport();
    void createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      createTransport: () => without,
    });
    await vi.waitFor(() => expect(without.requests).toHaveLength(1));
    expect(without.requests[0].payload).not.toHaveProperty('modelCatalog');
  });

  /**
   * Same absence rule for the two prompt cache TTLs: the worker applies the
   * shipped defaults when neither key travels, so an install on the defaults
   * must not start sending fields `sameBootstrap` would then have to compare.
   */
  it('carries the prompt cache TTLs when set, and omits them otherwise', async () => {
    const chosen = new LoopbackTransport();
    void createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      promptCacheTtl: '1h',
      subagentPromptCacheTtl: '5m',
      createTransport: () => chosen,
    });
    await vi.waitFor(() => expect(chosen.requests).toHaveLength(1));
    expect(chosen.requests[0].payload).toMatchObject({
      promptCacheTtl: '1h',
      subagentPromptCacheTtl: '5m',
    });

    const untouched = new LoopbackTransport();
    void createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      createTransport: () => untouched,
    });
    await vi.waitFor(() => expect(untouched.requests).toHaveLength(1));
    expect(untouched.requests[0].payload).not.toHaveProperty('promptCacheTtl');
    expect(untouched.requests[0].payload).not.toHaveProperty('subagentPromptCacheTtl');
  });

  /**
   * The 2026-09-05 startup defect: bootstrap shared `WorkerSlot`'s 10s warm-RPC
   * budget, so a cold start that ran long failed `chat:resumeSession` with
   * `worker.bootstrap timed out after 10000ms` and left the session unopenable.
   * Asserted through the message the user actually saw, since that string is
   * what the timeout is measured in.
   */
  it('gives bootstrap a cold-start budget instead of the warm request timeout', async () => {
    vi.useFakeTimers();
    try {
      const transport = new LoopbackTransport();
      const creating = createPiWorkerSlot({
        slotKey: 'workspace:/repo',
        logicalSessionId: 'logical-1',
        cwd: '/repo',
        createTransport: () => transport,
        // The warm budget the defect used. Bootstrap must not adopt it.
        requestTimeoutMs: 10_000,
        disposeTimeoutMs: 100,
        exitTimeoutMs: 100,
      });
      const rejection = expect(creating).rejects.toThrow(
        /worker\.bootstrap timed out after 60000ms/
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(transport.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(50_000);
      await vi.advanceTimersByTimeAsync(200);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes the process when bootstrap acknowledgement is invalid', async () => {
    const transport = new LoopbackTransport();
    const creating = createPiWorkerSlot({
      slotKey: 'workspace:/repo',
      logicalSessionId: 'logical-1',
      cwd: '/repo',
      createTransport: () => transport,
      disposeTimeoutMs: 100,
      exitTimeoutMs: 100,
    });
    const rejection = expect(creating).rejects.toThrow(/invalid bootstrap acknowledgement/);
    await vi.waitFor(() => expect(transport.requests).toHaveLength(1));
    transport.respond(transport.requests[0], { bootstrapped: false });
    await vi.waitFor(() => expect(transport.requests).toHaveLength(2));
    expect(transport.requests[1].type).toBe('worker.dispose');
    transport.respond(transport.requests[1], { disposed: true });
    transport.exit();

    await rejection;
    expect(transport.kill).toHaveBeenCalledTimes(1);
  });
});
