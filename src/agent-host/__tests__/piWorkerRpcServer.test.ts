import { describe, expect, it, vi } from 'vitest';
import {
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerBootstrapResult,
  type WorkerRpcRequest,
  type WorkerUtilityStartPayload,
} from '../../shared/types/workerRpc.ts';
import {
  type PiUtilityRuntime,
  PiWorkerRpcServer,
  type PiWorkerRuntime,
} from '../piWorkerRpcServer.ts';
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
    leaf: { activeEntryId: null, fileTailEntryId: null },
    projectTrusted: false,
    permissionGate: 'bundled',
  };
}

function runtime(overrides: Partial<PiWorkerRuntime> = {}): PiWorkerRuntime {
  return {
    bootstrap: async () => bootstrapResult(),
    startSend: async (input) => ({ accepted: true, requestId: input.requestId }),
    history: async (input) => ({
      logicalSessionId: input.logicalSessionId,
      sessionFile: '/managed/pi-agent/sessions/one.jsonl',
      workspacePath: '/repo',
      page: {
        messages: [],
        offset: input.offset ?? 0,
        limit: input.limit ?? 80,
        totalCount: 0,
        hasMore: false,
      },
    }),
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

  it('rejects a duplicate bootstrap that targets a different exact session file', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const createRuntime = vi.fn((_options: PiWorkerSessionOptions) => runtime());
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime,
    });
    server.receive(
      request('first', 'worker.bootstrap', {
        logicalSessionId: 'logical-1',
        cwd: '/repo',
        sessionFile: '/sessions/one.jsonl',
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    server.receive(
      request('conflict', 'worker.bootstrap', {
        logicalSessionId: 'logical-1',
        cwd: '/repo',
        sessionFile: '/sessions/two.jsonl',
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({
      requestId: 'conflict',
      ok: false,
      error: { code: 'WORKER_ALREADY_BOOTSTRAPPED' },
    });
    expect(createRuntime).toHaveBeenCalledTimes(1);
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

  it('routes one-shot utility start and cancellation without constructing a session runtime', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const utility: PiUtilityRuntime = {
      start: vi.fn(async (input: WorkerUtilityStartPayload) => ({
        accepted: true as const,
        operationId: input.operationId,
      })),
      cancel: vi.fn(async () => ({ cancelled: true })),
      dispose: vi.fn(async () => undefined),
    };
    const createRuntime = vi.fn((_options: PiWorkerSessionOptions) => runtime());
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime,
      createUtilityRuntime: () => utility,
    });

    server.receive(
      request('utility-start', 'utility.start', {
        operationId: 'utility-1',
        cwd: '/repo',
        prompt: 'summarize',
        timeoutMs: 60_000,
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({
      requestId: 'utility-start',
      ok: true,
      result: { accepted: true, operationId: 'utility-1' },
    });
    expect(createRuntime).not.toHaveBeenCalled();

    server.receive(
      request('utility-cancel', 'utility.cancel', {
        operationId: 'utility-1',
        reason: 'user',
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(utility.cancel).toHaveBeenCalledTimes(1);

    server.receive(
      request('session-conflict', 'worker.bootstrap', {
        logicalSessionId: 'logical-1',
        cwd: '/repo',
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[2]).toMatchObject({
      requestId: 'session-conflict',
      ok: false,
      error: { code: 'WORKER_UTILITY_SLOT_CONFLICT' },
    });
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

  it('forwards setPermissionTier to the runtime and responds success', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const setPermissionTier = vi.fn();
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime({ setPermissionTier }),
    });
    server.receive(
      request('bootstrap', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    server.receive(
      request('tier', 'worker.setPermissionTier', {
        logicalSessionId: 'logical-1',
        tier: 'readonly',
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(setPermissionTier).toHaveBeenCalledWith('readonly');
    expect(messages[1]).toMatchObject({ requestId: 'tier', ok: true, result: { applied: true } });
  });

  it('rejects setPermissionTier with an invalid payload', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime(),
    });
    server.receive(
      request('bootstrap', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    server.receive(
      request('bad-tier', 'worker.setPermissionTier', {
        logicalSessionId: 'logical-1',
        tier: 'yolo',
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toMatchObject({
      requestId: 'bad-tier',
      ok: false,
      error: { code: 'WORKER_INVALID_PAYLOAD' },
    });
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
