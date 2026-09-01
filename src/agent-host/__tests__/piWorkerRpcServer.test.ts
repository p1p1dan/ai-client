import { describe, expect, it, vi } from 'vitest';
import {
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerBootstrapResult,
  type WorkerRpcRequest,
} from '../../shared/types/workerRpc.ts';
import { PiWorkerRpcServer, type PiWorkerRuntime } from '../piWorkerRpcServer.ts';
import type { PiWorkerSessionOptions } from '../piWorkerSession.ts';

function request(
  requestId: string,
  type: string,
  payload: unknown,
  generation = 3
): WorkerRpcRequest {
  return {
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    kind: 'request',
    generation,
    requestId,
    type,
    payload,
  };
}

function bootstrapResult(): WorkerBootstrapResult {
  return {
    bootstrapped: true,
    logicalSessionId: 'logical-1',
    piSessionId: 'pi-1',
    cwd: '/repo',
    agentDir: '/managed/pi-agent',
    sessionFile: '/managed/pi-agent/sessions/one.jsonl',
    projectTrusted: false,
    permissionGate: 'bundled',
  };
}

function runtime(overrides: Partial<PiWorkerRuntime> = {}): PiWorkerRuntime {
  return {
    bootstrap: async () => bootstrapResult(),
    startSend: async (input) => ({ accepted: true, requestId: input.requestId }),
    stop: async () => ({ stopped: true }),
    respondExtensionUi: () => true,
    dispose: async () => undefined,
    ...overrides,
  };
}

describe('PiWorkerRpcServer', () => {
  it('echoes correlation and constructs only one runtime for duplicate bootstrap', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const createRuntime = vi.fn((_options: PiWorkerSessionOptions) => runtime());
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime,
    });
    const payload = { logicalSessionId: 'logical-1', cwd: '/repo' };
    server.receive(request('rpc-1', 'worker.bootstrap', payload));
    server.receive(request('rpc-2', 'worker.bootstrap', payload));
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(messages.map((message) => message.requestId)).toEqual(['rpc-1', 'rpc-2']);
  });

  it('ACKs send admission before the held prompt completes and dispatches stop', async () => {
    const messages: Array<Record<string, unknown>> = [];
    let promptFinished = false;
    const startSend = vi.fn(async (input) => {
      void new Promise<void>(() => undefined).then(() => {
        promptFinished = true;
      });
      return { accepted: true as const, requestId: input.requestId };
    });
    const stop = vi.fn(async () => ({ stopped: true }));
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime({ startSend, stop }),
    });
    server.receive(
      request('bootstrap', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    server.receive(
      request('send-rpc', 'worker.send', {
        logicalSessionId: 'logical-1',
        requestId: 'turn-1',
        attemptId: 'attempt-1',
        text: 'hold',
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({
      requestId: 'send-rpc',
      ok: true,
      result: { accepted: true, requestId: 'turn-1' },
    });
    expect(promptFinished).toBe(false);

    server.receive(
      request('stop-rpc', 'worker.stop', { logicalSessionId: 'logical-1', reason: 'user' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(messages[2]).toMatchObject({
      requestId: 'stop-rpc',
      ok: true,
      result: { stopped: true },
    });
  });

  it('wraps runtime events with generation and sequence', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: true,
      createRuntime: (options) =>
        runtime({
          bootstrap: async () => {
            options.emit({
              type: 'session.status',
              sessionId: 'logical-1',
              payload: { status: 'idle' },
            });
            return bootstrapResult();
          },
        }),
    });
    server.receive(
      request('bootstrap', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0]).toMatchObject({
      kind: 'event',
      generation: 3,
      type: 'runtime.event',
      payload: { type: 'session.status', sessionId: 'logical-1', seq: 1 },
    });
  });

  it('routes Extension UI responses to the owned runtime', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const respondExtensionUi = vi.fn(() => true);
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime({ respondExtensionUi }),
    });
    server.receive(
      request('bootstrap', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    server.receive(
      request('ui', 'worker.extensionUi.respond', {
        logicalSessionId: 'logical-1',
        response: { runtimeId: 'runtime-1', uiRequestId: 'ui-1', ok: false },
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(respondExtensionUi).toHaveBeenCalledTimes(1);
    expect(messages[1]).toMatchObject({ result: { handled: true } });
  });

  it('returns correlated errors for stale, malformed, unknown, and pre-bootstrap send', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
    });
    server.receive(request('stale', 'worker.bootstrap', {}, 2));
    server.receive(request('invalid', 'worker.send', { text: 'x' }));
    server.receive(
      request('preboot', 'worker.send', {
        logicalSessionId: 'logical-1',
        requestId: 'turn',
        attemptId: 'attempt-preboot',
        text: 'x',
      })
    );
    server.receive(request('unknown', 'other.method', {}));
    await vi.waitFor(() => expect(messages).toHaveLength(4));
    expect(messages.map((message) => (message.error as { code: string }).code)).toEqual([
      'WORKER_STALE_GENERATION',
      'WORKER_INVALID_PAYLOAD',
      'WORKER_NOT_BOOTSTRAPPED',
      'WORKER_METHOD_NOT_FOUND',
    ]);
  });

  it('waits for disposal before ACK and exit hook', async () => {
    const messages: Array<Record<string, unknown>> = [];
    let finishDispose: () => void = () => undefined;
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDispose = resolve;
        })
    );
    const onDisposed = vi.fn();
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime({ dispose }),
      onDisposed,
    });
    server.receive(
      request('bootstrap', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    server.receive(request('dispose', 'worker.dispose', { reason: 'slot-dispose' }));
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(messages).toHaveLength(1);
    finishDispose();
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({ requestId: 'dispose', result: { disposed: true } });
    expect(onDisposed).toHaveBeenCalledTimes(1);
  });
});
