import {
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerRpcEvent,
  type WorkerRpcRequest,
} from '@shared/types/workerRpc';
import { describe, expect, it, vi } from 'vitest';
import { PiUtilityService } from '../PiUtilityService';
import { WorkerSlot } from '../WorkerSlot';
import type { WorkerTransport, WorkerTransportExit } from '../WorkerTransport';

class UtilityTransport implements WorkerTransport {
  readonly pid = 991;
  readonly requests: WorkerRpcRequest[] = [];
  readonly kill = vi.fn(() => true);
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly exitListeners = new Set<(exit: WorkerTransportExit) => void>();
  private readonly stderrListeners = new Set<(chunk: string) => void>();

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
    this.emit({
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'response',
      generation: request.generation,
      requestId: request.requestId,
      ok: true,
      result,
    });
  }

  event(type: WorkerRpcEvent['type'], payload: unknown, generation = 1): void {
    this.emit({
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'event',
      generation,
      type,
      payload,
    });
  }

  exit(): void {
    for (const listener of this.exitListeners) listener({ code: 0, signal: null });
  }

  private emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

function harness(capacity = 2) {
  const transports: UtilityTransport[] = [];
  const service = new PiUtilityService({
    capacity,
    createOperationId: () => `operation-${transports.length + 1}`,
    createSlot: ({ generation, cwd, onEvent, onLifecycle }) => {
      const transport = new UtilityTransport();
      transports.push(transport);
      return new WorkerSlot({
        slotKey: `utility:${generation}`,
        cwd,
        generation,
        transport,
        requestTimeoutMs: 100,
        disposeTimeoutMs: 100,
        exitTimeoutMs: 100,
        onEvent,
        onLifecycle,
      });
    },
  });
  return { service, transports };
}

async function acknowledgeStart(transport: UtilityTransport): Promise<void> {
  await vi.waitFor(() => expect(transport.requests[0]?.type).toBe('utility.start'));
  const request = transport.requests[0];
  const operationId = (request.payload as { operationId: string }).operationId;
  transport.respond(request, { accepted: true, operationId });
}

async function acknowledgeDispose(transport: UtilityTransport): Promise<void> {
  await vi.waitFor(() => expect(transport.requests.at(-1)?.type).toBe('worker.dispose'));
  transport.respond(transport.requests.at(-1)!, { disposed: true });
  transport.exit();
}

describe('PiUtilityService', () => {
  it('streams one sessionless completion and disposes its worker', async () => {
    const { service, transports } = harness();
    const onDelta = vi.fn();
    const completion = service.complete({
      operationId: 'review-1',
      cwd: '/repo',
      prompt: 'review',
      timeoutMs: 1_000,
      onDelta,
    });
    await vi.waitFor(() => expect(transports).toHaveLength(1));
    const transport = transports[0];
    await acknowledgeStart(transport);
    transport.event('utility.delta', { operationId: 'review-1', delta: 'part' });
    transport.event('utility.terminal', {
      operationId: 'review-1',
      state: 'completed',
      text: 'complete',
      model: 'pilab/model',
    });

    await expect(completion).resolves.toEqual({ text: 'complete', model: 'pilab/model' });
    expect(onDelta).toHaveBeenCalledWith('part');
    expect(service.activeCount).toBe(0);
    await acknowledgeDispose(transport);
  });

  it('settles cancellation after the worker acknowledgement even without a terminal event', async () => {
    const { service, transports } = harness();
    const completion = service.complete({
      operationId: 'review-2',
      cwd: '/repo',
      prompt: 'review',
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(transports).toHaveLength(1));
    const transport = transports[0];
    await acknowledgeStart(transport);

    const cancelling = service.cancel('review-2');
    await vi.waitFor(() => expect(transport.requests.at(-1)?.type).toBe('utility.cancel'));
    transport.respond(transport.requests.at(-1)!, { cancelled: true });
    await expect(cancelling).resolves.toBe(true);
    await expect(completion).rejects.toMatchObject({ code: 'PI_UTILITY_CANCELLED' });
    expect(service.activeCount).toBe(0);
    await acknowledgeDispose(transport);
  });

  it('invalidateAll cancels in-flight work at logout and stays usable afterwards', async () => {
    const { service, transports } = harness();
    const completion = service.complete({
      operationId: 'review-3',
      cwd: '/repo',
      prompt: 'review',
      timeoutMs: 60_000,
    });
    await vi.waitFor(() => expect(transports).toHaveLength(1));
    const transport = transports[0];
    await acknowledgeStart(transport);

    const invalidating = service.invalidateAll();
    await vi.waitFor(() => expect(transport.requests.at(-1)?.type).toBe('utility.cancel'));
    transport.respond(transport.requests.at(-1)!, { cancelled: true });
    await expect(completion).rejects.toMatchObject({ code: 'PI_UTILITY_CANCELLED' });
    await acknowledgeDispose(transport);
    await invalidating;
    expect(service.activeCount).toBe(0);

    // Unlike disposeAll, this is a credential-change teardown: the same service
    // must serve the next sign-in rather than reject every later completion.
    const next = service.complete({
      operationId: 'review-4',
      cwd: '/repo',
      prompt: 'review again',
      timeoutMs: 60_000,
    });
    await vi.waitFor(() => expect(transports).toHaveLength(2));
    await acknowledgeStart(transports[1]);
    // Second slot, second generation — an event tagged with the default
    // generation 1 would be filtered out as stale.
    transports[1].event(
      'utility.terminal',
      { operationId: 'review-4', state: 'completed', text: 'done' },
      2
    );
    await expect(next).resolves.toEqual({ text: 'done' });
    await acknowledgeDispose(transports[1]);
  });

  it('enforces its explicit process bound', async () => {
    const { service, transports } = harness(1);
    const first = service.complete({
      operationId: 'first',
      cwd: '/repo',
      prompt: 'one',
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(transports).toHaveLength(1));
    await expect(
      service.complete({ cwd: '/repo', prompt: 'two', timeoutMs: 1_000 })
    ).rejects.toMatchObject({ code: 'PI_UTILITY_CAPACITY_EXCEEDED' });

    const transport = transports[0];
    await acknowledgeStart(transport);
    transport.event('utility.terminal', {
      operationId: 'first',
      state: 'completed',
      text: 'done',
    });
    await first;
    await acknowledgeDispose(transport);
  });
});
