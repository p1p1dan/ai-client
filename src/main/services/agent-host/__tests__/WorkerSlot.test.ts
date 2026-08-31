import type {
  WorkerRpcErrorResponse,
  WorkerRpcEvent,
  WorkerRpcRequest,
  WorkerRpcSuccessResponse,
} from '@shared/types/workerRpc';
import { WORKER_RPC_PROTOCOL_VERSION } from '@shared/types/workerRpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerSlot, WorkerSlotError, type WorkerSlotLifecycleEvent } from '../WorkerSlot';
import type { WorkerTransport, WorkerTransportExit } from '../WorkerTransport';

type Listener<T> = (value: T) => void;

class FakeWorkerTransport implements WorkerTransport {
  readonly pid = 1234;
  readonly postMessage = vi.fn<(message: WorkerRpcRequest) => void>();
  readonly kill = vi.fn(() => true);

  private readonly activeMessages = new Set<Listener<unknown>>();
  private readonly activeErrors = new Set<Listener<Error>>();
  private readonly activeExits = new Set<Listener<WorkerTransportExit>>();
  private readonly activeStderr = new Set<Listener<string>>();

  readonly allMessages: Array<Listener<unknown>> = [];
  readonly allErrors: Array<Listener<Error>> = [];
  readonly allExits: Array<Listener<WorkerTransportExit>> = [];

  onMessage(listener: Listener<unknown>): () => void {
    this.activeMessages.add(listener);
    this.allMessages.push(listener);
    return () => this.activeMessages.delete(listener);
  }

  onError(listener: Listener<Error>): () => void {
    this.activeErrors.add(listener);
    this.allErrors.push(listener);
    return () => this.activeErrors.delete(listener);
  }

  onExit(listener: Listener<WorkerTransportExit>): () => void {
    this.activeExits.add(listener);
    this.allExits.push(listener);
    return () => this.activeExits.delete(listener);
  }

  onStderr(listener: Listener<string>): () => void {
    this.activeStderr.add(listener);
    return () => this.activeStderr.delete(listener);
  }

  emitMessage(message: unknown): void {
    for (const listener of this.activeMessages) listener(message);
  }

  emitError(error: Error): void {
    for (const listener of this.activeErrors) listener(error);
  }

  emitExit(exit: WorkerTransportExit): void {
    for (const listener of this.activeExits) listener(exit);
  }
}

function sentRequest(transport: FakeWorkerTransport, index = 0): WorkerRpcRequest {
  return transport.postMessage.mock.calls[index][0];
}

function successResponse<TResult>(
  request: WorkerRpcRequest,
  result: TResult
): WorkerRpcSuccessResponse<TResult> {
  return {
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    kind: 'response',
    generation: request.generation,
    requestId: request.requestId,
    ok: true,
    result,
  };
}

function errorResponse(
  request: WorkerRpcRequest,
  code: string,
  message: string,
  retryable?: boolean
): WorkerRpcErrorResponse {
  return {
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    kind: 'response',
    generation: request.generation,
    requestId: request.requestId,
    ok: false,
    error: { code, message, retryable },
  };
}

function createSlot(
  transport = new FakeWorkerTransport(),
  overrides: Partial<ConstructorParameters<typeof WorkerSlot>[0]> = {}
): { slot: WorkerSlot; transport: FakeWorkerTransport } {
  return {
    slot: new WorkerSlot({
      slotKey: 'slot-a',
      cwd: '/workspace/a',
      transport,
      requestTimeoutMs: 100,
      disposeTimeoutMs: 50,
      exitTimeoutMs: 50,
      ...overrides,
    }),
    transport,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkerSlot RPC correlation', () => {
  it('correlates out-of-order responses and keeps request IDs unique', async () => {
    const { slot, transport } = createSlot();

    const first = slot.request<{ value: number }>('first', { input: 1 });
    const second = slot.request<{ value: number }>('second', { input: 2 });
    const firstRequest = sentRequest(transport, 0);
    const secondRequest = sentRequest(transport, 1);

    expect(firstRequest).toMatchObject({
      protocolVersion: 1,
      kind: 'request',
      generation: 1,
      type: 'first',
      payload: { input: 1 },
    });
    expect(firstRequest.requestId).not.toBe(secondRequest.requestId);

    transport.emitMessage(successResponse(secondRequest, { value: 2 }));
    transport.emitMessage(successResponse(firstRequest, { value: 1 }));

    await expect(first).resolves.toEqual({ value: 1 });
    await expect(second).resolves.toEqual({ value: 2 });
    expect(slot.pendingRequestCount).toBe(0);
  });

  it('ignores unknown responses without settling another request', async () => {
    const diagnostics = vi.fn();
    const { slot, transport } = createSlot(new FakeWorkerTransport(), {
      onDiagnostic: diagnostics,
    });
    const response = slot.request<string>('known', {});
    const request = sentRequest(transport);

    transport.emitMessage({
      ...successResponse(request, 'wrong'),
      requestId: 'rpc-unknown',
    });
    expect(slot.pendingRequestCount).toBe(1);

    transport.emitMessage(successResponse(request, 'right'));
    await expect(response).resolves.toBe('right');
    expect(diagnostics).toHaveBeenCalledWith({
      type: 'unknown-response',
      generation: 1,
      requestId: 'rpc-unknown',
    });
  });

  it('rejects a correlated remote error with stable local and remote codes', async () => {
    const { slot, transport } = createSlot();
    const response = slot.request('explode', {});
    const request = sentRequest(transport);

    transport.emitMessage(errorResponse(request, 'BAD_INPUT', 'invalid payload', true));

    await expect(response).rejects.toMatchObject({
      name: 'WorkerSlotError',
      code: 'WORKER_RPC_REMOTE_ERROR',
      remoteCode: 'BAD_INPUT',
      remoteRetryable: true,
      remoteError: { code: 'BAD_INPUT', message: 'invalid payload', retryable: true },
      message: 'BAD_INPUT: invalid payload',
    });
  });

  it('times out and removes the pending request', async () => {
    vi.useFakeTimers();
    const { slot } = createSlot();
    const response = slot.request('slow', {}, { timeoutMs: 25 });
    const rejection = expect(response).rejects.toMatchObject({ code: 'WORKER_RPC_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(slot.pendingRequestCount).toBe(0);
  });

  it('crashes the slot and rejects every pending RPC when postMessage throws', async () => {
    const lifecycle: WorkerSlotLifecycleEvent[] = [];
    const { slot, transport } = createSlot(new FakeWorkerTransport(), {
      onLifecycle: (event) => lifecycle.push(event),
    });
    const first = slot.request('first', {}).catch((error: unknown) => error);
    transport.postMessage.mockImplementationOnce(() => {
      throw new Error('port closed');
    });

    const second = slot.request('second', {}).catch((error: unknown) => error);

    await expect(first).resolves.toMatchObject({ code: 'WORKER_TRANSPORT_ERROR' });
    await expect(second).resolves.toMatchObject({
      code: 'WORKER_TRANSPORT_ERROR',
      message: 'port closed',
    });
    expect(slot.state).toBe('crashed');
    expect(slot.pendingRequestCount).toBe(0);
    expect(transport.kill).toHaveBeenCalledTimes(1);
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]).toMatchObject({
      type: 'crashed',
      error: { code: 'WORKER_TRANSPORT_ERROR' },
    });
  });

  it('does not settle a current request with a stale-generation response', async () => {
    const diagnostics = vi.fn();
    const { slot, transport } = createSlot(new FakeWorkerTransport(), {
      onDiagnostic: diagnostics,
    });
    const response = slot.request<string>('current', {});
    const request = sentRequest(transport);

    transport.emitMessage({ ...successResponse(request, 'stale'), generation: 99 });
    expect(slot.pendingRequestCount).toBe(1);
    transport.emitMessage(successResponse(request, 'current'));

    await expect(response).resolves.toBe('current');
    expect(diagnostics).toHaveBeenCalledWith({
      type: 'stale-generation',
      generation: 1,
      received: 99,
    });
  });

  it('drops malformed and wrong-generation messages with diagnostics', () => {
    const diagnostics = vi.fn();
    const events = vi.fn();
    const { transport } = createSlot(new FakeWorkerTransport(), {
      onDiagnostic: diagnostics,
      onEvent: events,
    });

    transport.emitMessage(null);
    transport.emitMessage({ protocolVersion: 99, generation: 1 });
    transport.emitMessage({
      protocolVersion: 1,
      kind: 'event',
      generation: 99,
      type: 'runtime.event',
      payload: {},
    });

    expect(events).not.toHaveBeenCalled();
    expect(diagnostics.mock.calls.map(([value]) => value.type)).toEqual([
      'malformed-message',
      'protocol-mismatch',
      'stale-generation',
    ]);
  });
});

describe('WorkerSlot lifecycle', () => {
  it('force-kills synchronously, detaches routing, and rejects pending RPCs', async () => {
    const lifecycle: WorkerSlotLifecycleEvent[] = [];
    const { slot, transport } = createSlot(new FakeWorkerTransport(), {
      onLifecycle: (event) => lifecycle.push(event),
    });
    const pending = slot.request('held', {}).catch((error: unknown) => error);

    expect(slot.forceKillNow()).toBe(true);
    await expect(pending).resolves.toMatchObject({ code: 'WORKER_SLOT_DISPOSING' });
    expect(slot.state).toBe('disposed');
    expect(slot.pendingRequestCount).toBe(0);
    expect(transport.kill).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual([{ type: 'disposed', slotKey: 'slot-a', generation: 1 }]);
    expect(slot.forceKillNow()).toBe(true);
    expect(transport.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects outstanding work, waits for dispose ACK, kills once, and is idempotent', async () => {
    const lifecycle: WorkerSlotLifecycleEvent[] = [];
    const { slot, transport } = createSlot(new FakeWorkerTransport(), {
      onLifecycle: (event) => lifecycle.push(event),
    });
    const pending = slot.request('pending', {}).catch((error: unknown) => error);

    const disposing = slot.dispose('app-shutdown');
    expect(slot.state).toBe('disposing');
    expect(slot.pendingRequestCount).toBe(1);
    const disposeRequest = sentRequest(transport, 1);
    expect(disposeRequest).toMatchObject({
      type: 'worker.dispose',
      payload: { reason: 'app-shutdown' },
    });

    let settled = false;
    void disposing.then(() => {
      settled = true;
    });
    transport.emitMessage(successResponse(disposeRequest, { disposed: true }));
    await Promise.resolve();
    expect(settled).toBe(false);
    transport.emitExit({ code: 0, signal: null });

    await expect(disposing).resolves.toBeUndefined();
    await expect(pending).resolves.toMatchObject({ code: 'WORKER_SLOT_DISPOSING' });
    expect(slot.state).toBe('disposed');
    expect(slot.pendingRequestCount).toBe(0);
    expect(transport.kill).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual([{ type: 'disposed', slotKey: 'slot-a', generation: 1 }]);

    await expect(slot.dispose()).resolves.toBeUndefined();
    expect(transport.kill).toHaveBeenCalledTimes(1);
    expect(transport.postMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid dispose ACK after forcing local cleanup', async () => {
    const { slot, transport } = createSlot();

    const disposing = slot.dispose();
    const rejection = expect(disposing).rejects.toMatchObject({
      code: 'WORKER_RPC_REMOTE_ERROR',
    });
    const request = sentRequest(transport);
    transport.emitMessage(successResponse(request, { disposed: false }));
    await Promise.resolve();
    transport.emitExit({ code: 0, signal: null });

    await rejection;
    expect(slot.state).toBe('disposed');
    expect(transport.kill).toHaveBeenCalledTimes(1);
  });

  it('forces local cleanup and rejects when dispose ACK times out', async () => {
    vi.useFakeTimers();
    const { slot, transport } = createSlot();

    const disposing = slot.dispose();
    const rejection = expect(disposing).rejects.toMatchObject({ code: 'WORKER_RPC_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(50);
    transport.emitExit({ code: 0, signal: null });

    await rejection;
    expect(slot.state).toBe('disposed');
    expect(slot.pendingRequestCount).toBe(0);
    expect(transport.kill).toHaveBeenCalledTimes(1);
  });

  it('fails disposal when process exit cannot be confirmed', async () => {
    vi.useFakeTimers();
    const lifecycle: WorkerSlotLifecycleEvent[] = [];
    const { slot, transport } = createSlot(new FakeWorkerTransport(), {
      onLifecycle: (event) => lifecycle.push(event),
    });
    transport.kill.mockImplementation(() => {
      throw new Error('kill failed');
    });

    const disposing = slot.dispose();
    const rejection = expect(disposing).rejects.toMatchObject({
      code: 'WORKER_EXIT_TIMEOUT',
    });
    const request = sentRequest(transport);
    transport.emitMessage(successResponse(request, { disposed: true }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(slot.state).toBe('dispose-failed');
    expect(transport.kill).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual([]);
  });

  it('finishes as disposed when the worker exits before the dispose ACK', async () => {
    const lifecycle: WorkerSlotLifecycleEvent[] = [];
    const { slot, transport } = createSlot(new FakeWorkerTransport(), {
      onLifecycle: (event) => lifecycle.push(event),
    });

    const disposing = slot.dispose();
    const rejection = expect(disposing).rejects.toMatchObject({ code: 'WORKER_EXITED' });
    transport.emitExit({ code: 7, signal: null });

    await rejection;
    expect(slot.state).toBe('disposed');
    expect(transport.kill).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual([{ type: 'disposed', slotKey: 'slot-a', generation: 1 }]);
  });

  it('rejects all pending RPCs and emits one crash contract on transport failure', async () => {
    const lifecycle: WorkerSlotLifecycleEvent[] = [];
    const { slot, transport } = createSlot(new FakeWorkerTransport(), {
      onLifecycle: (event) => lifecycle.push(event),
    });
    const first = slot.request('first', {}).catch((error: unknown) => error);
    const second = slot.request('second', {}).catch((error: unknown) => error);

    transport.emitError(new Error('fatal utility process error'));
    transport.allExits[0]({ code: 17, signal: null });

    await expect(first).resolves.toMatchObject({ code: 'WORKER_TRANSPORT_ERROR' });
    await expect(second).resolves.toMatchObject({ code: 'WORKER_TRANSPORT_ERROR' });
    expect(slot.state).toBe('crashed');
    expect(slot.pendingRequestCount).toBe(0);
    expect(transport.kill).toHaveBeenCalledTimes(1);
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]).toMatchObject({
      type: 'crashed',
      slotKey: 'slot-a',
      generation: 1,
      error: { code: 'WORKER_TRANSPORT_ERROR' },
    });

    const disposing = slot.dispose();
    transport.emitExit({ code: 0, signal: null });
    await expect(disposing).resolves.toBeUndefined();
    expect(slot.state).toBe('disposed');
    expect(transport.kill).toHaveBeenCalledTimes(1);
    expect(lifecycle[1]).toEqual({ type: 'disposed', slotKey: 'slot-a', generation: 1 });
  });

  it('refuses replacement until the crashed process exit is confirmed', async () => {
    vi.useFakeTimers();
    const { slot, transport } = createSlot();
    transport.emitError(new Error('fatal'));
    const replacementTransport = new FakeWorkerTransport();

    const replacement = slot.replaceCrashedTransport(replacementTransport);
    const rejection = expect(replacement).rejects.toMatchObject({ code: 'WORKER_EXIT_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(slot.state).toBe('crashed');
    expect(slot.generation).toBe(1);
    expect(replacementTransport.kill).toHaveBeenCalledTimes(1);
  });

  it('serializes replacement before a concurrent dispose', async () => {
    const oldTransport = new FakeWorkerTransport();
    const { slot } = createSlot(oldTransport);
    oldTransport.emitExit({ code: 9, signal: null });

    const replacementTransport = new FakeWorkerTransport();
    const replacement = slot.replaceCrashedTransport(replacementTransport);
    const disposing = slot.dispose();

    await expect(replacement).resolves.toBe(2);
    await vi.waitFor(() => expect(replacementTransport.postMessage).toHaveBeenCalledTimes(1));
    const disposeRequest = sentRequest(replacementTransport);
    replacementTransport.emitMessage(successResponse(disposeRequest, { disposed: true }));
    await Promise.resolve();
    replacementTransport.emitExit({ code: 0, signal: null });

    await expect(disposing).resolves.toBeUndefined();
    expect(slot.state).toBe('disposed');
    expect(slot.generation).toBe(2);
    expect(replacementTransport.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects a second concurrent replacement', async () => {
    const oldTransport = new FakeWorkerTransport();
    const { slot } = createSlot(oldTransport);
    oldTransport.emitExit({ code: 9, signal: null });

    const firstTransport = new FakeWorkerTransport();
    const first = slot.replaceCrashedTransport(firstTransport);
    const second = slot.replaceCrashedTransport(new FakeWorkerTransport());

    await expect(second).rejects.toMatchObject({ code: 'WORKER_SLOT_NOT_RUNNING' });
    await expect(first).resolves.toBe(2);
    expect(slot.state).toBe('running');
    expect(slot.generation).toBe(2);
  });

  it('advances generation on replacement and ignores retired transport callbacks', async () => {
    const diagnostics = vi.fn();
    const events: WorkerRpcEvent[] = [];
    const oldTransport = new FakeWorkerTransport();
    const { slot } = createSlot(oldTransport, {
      onDiagnostic: diagnostics,
      onEvent: (event) => events.push(event),
    });

    oldTransport.emitExit({ code: 9, signal: null });
    expect(slot.state).toBe('crashed');

    const newTransport = new FakeWorkerTransport();
    await expect(slot.replaceCrashedTransport(newTransport)).resolves.toBe(2);
    expect(slot.state).toBe('running');

    oldTransport.allMessages[0]({
      protocolVersion: 1,
      kind: 'event',
      generation: 1,
      type: 'runtime.event',
      payload: { stale: true },
    });
    oldTransport.allExits[0]({ code: 0, signal: null });

    const currentEvent: WorkerRpcEvent = {
      protocolVersion: 1,
      kind: 'event',
      generation: 2,
      type: 'runtime.event',
      payload: { current: true },
    };
    newTransport.emitMessage(currentEvent);

    const response = slot.request<string>('current', {});
    const request = sentRequest(newTransport);
    newTransport.emitMessage(successResponse(request, 'ok'));

    await expect(response).resolves.toBe('ok');
    expect(events).toEqual([currentEvent]);
    expect(diagnostics).toHaveBeenCalledWith({
      type: 'late-transport-event',
      generation: 1,
      event: 'message',
    });
    expect(diagnostics).toHaveBeenCalledWith({
      type: 'late-transport-event',
      generation: 1,
      event: 'exit',
    });
  });

  it('rejects new requests after crash or dispose', async () => {
    const crashed = createSlot();
    crashed.transport.emitExit({ code: 1, signal: null });
    await expect(crashed.slot.request('after-crash', {})).rejects.toBeInstanceOf(WorkerSlotError);
    await expect(crashed.slot.request('after-crash', {})).rejects.toMatchObject({
      code: 'WORKER_SLOT_NOT_RUNNING',
    });

    const disposed = createSlot();
    const disposing = disposed.slot.dispose();
    const request = sentRequest(disposed.transport);
    disposed.transport.emitMessage(successResponse(request, { disposed: true }));
    await Promise.resolve();
    disposed.transport.emitExit({ code: 0, signal: null });
    await disposing;
    await expect(disposed.slot.request('after-dispose', {})).rejects.toMatchObject({
      code: 'WORKER_SLOT_DISPOSED',
    });
  });
});
