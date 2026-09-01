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
