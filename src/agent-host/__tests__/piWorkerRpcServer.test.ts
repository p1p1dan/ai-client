import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerBootstrapResult,
  type WorkerRpcRequest,
} from '../../shared/types/workerRpc.ts';
import {
  PiWorkerRpcServer,
  type PiWorkerRuntime,
  type PiWorkerRuntimeOptions,
} from '../piWorkerRpcServer.ts';

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

/**
 * A complete `PiWorkerRuntime`.
 *
 * T025 made every method on the interface required, so this fixture has to
 * implement all of them — which is the point: the twelve that used to be
 * optional each had a `WORKER_*_UNAVAILABLE` arm in the server that no test ever
 * asserted and no production runtime could reach. The methods no test cares
 * about throw rather than return a plausible value, so a handler that starts
 * calling one by accident fails loudly instead of passing on a stub.
 */
const notCalled = (method: string) => () => {
  throw new Error(`this test does not expect ${method} to be called`);
};

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
    tree: notCalled('tree') as PiWorkerRuntime['tree'],
    commands: notCalled('commands') as PiWorkerRuntime['commands'],
    compact: notCalled('compact') as PiWorkerRuntime['compact'],
    command: notCalled('command') as PiWorkerRuntime['command'],
    panels: notCalled('panels') as PiWorkerRuntime['panels'],
    killJob: notCalled('killJob') as PiWorkerRuntime['killJob'],
    readJob: notCalled('readJob') as PiWorkerRuntime['readJob'],
    interruptSubagent: notCalled('interruptSubagent') as PiWorkerRuntime['interruptSubagent'],
    rewind: notCalled('rewind') as PiWorkerRuntime['rewind'],
    fork: notCalled('fork') as PiWorkerRuntime['fork'],
    discardFork: notCalled('discardFork') as PiWorkerRuntime['discardFork'],
    acceptFork: notCalled('acceptFork') as PiWorkerRuntime['acceptFork'],
    stop: async () => ({ stopped: true }),
    interject: () => ({ interjected: false }),
    respondPermission: notCalled('respondPermission') as PiWorkerRuntime['respondPermission'],
    respondQuestion: notCalled('respondQuestion') as PiWorkerRuntime['respondQuestion'],
    respondPreview: notCalled('respondPreview') as PiWorkerRuntime['respondPreview'],
    setPermissions: notCalled('setPermissions') as PiWorkerRuntime['setPermissions'],
    setPermissionGear: notCalled('setPermissionGear') as PiWorkerRuntime['setPermissionGear'],
    setPermissionTier: notCalled('setPermissionTier') as PiWorkerRuntime['setPermissionTier'],
    dispose: async () => undefined,
    ...overrides,
  };
}

describe('PiWorkerRpcServer', () => {
  it('echoes correlation and constructs only one runtime for duplicate bootstrap', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const createRuntime = vi.fn((_options: PiWorkerRuntimeOptions) => runtime());
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
    const createRuntime = vi.fn((_options: PiWorkerRuntimeOptions) => runtime());
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

  /**
   * cutover-10 — the opt-in extension parameter is gone, not merely unused.
   *
   * Main filled `AICLIENT_PI_OPT_IN_EXTENSIONS`, the entry read it, this server
   * forwarded it as `optInExtensions`, and no runtime ever declared the field.
   * A dead parameter on a construction call reads as configuration, which is
   * why it survived P6-5 unnoticed; these two checks are what make it come back
   * loudly rather than silently.
   */
  describe('no opt-in extension transport', () => {
    it('hands the runtime factory nothing named after opt-in extensions', async () => {
      const messages: Array<Record<string, unknown>> = [];
      const createRuntime = vi.fn((_options: PiWorkerRuntimeOptions) => runtime());
      const server = new PiWorkerRpcServer({
        port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
        generation: 3,
        projectTrusted: true,
        createRuntime,
        // A caller from an older build may still pass it; it must not survive
        // into the runtime options either way.
        ...({ optInExtensions: 'subagents' } as Record<string, unknown>),
      });
      server.receive(
        request('rpc-1', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
      );
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      const options = createRuntime.mock.calls[0][0] as unknown as Record<string, unknown>;
      expect(Object.keys(options).some((key) => /optIn/i.test(key))).toBe(false);
    });

    it('leaves no reader of the opt-in variable in the worker entry or this server', () => {
      // The native worker entry was the other reader; it left with P1-12 step 3.
      for (const file of ['../piWorkerRpcServer.ts']) {
        const source = readFileSync(join(__dirname, file), 'utf8');
        expect(source).not.toContain('PI_OPT_IN_EXTENSIONS_ENV');
        expect(source).not.toContain('AICLIENT_PI_OPT_IN_EXTENSIONS');
      }
    });
  });

  // U05-c — an unbound session runs in a throwaway directory, so it must not
  // load or write the project-scoped permission config. `unbound` is how Main
  // says so, and it is one-way by construction.
  describe('unbound sessions and project trust', () => {
    function bootstrapWith(projectTrusted: boolean, payload: Record<string, unknown>) {
      const messages: Array<Record<string, unknown>> = [];
      const createRuntime = vi.fn((_options: PiWorkerRuntimeOptions) => runtime());
      const server = new PiWorkerRpcServer({
        port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
        generation: 3,
        projectTrusted,
        createRuntime,
      });
      server.receive(request('rpc-1', 'worker.bootstrap', payload));
      return { messages, createRuntime, server };
    }

    it('withholds project trust when the payload says the session is unbound', async () => {
      const { messages, createRuntime } = bootstrapWith(true, {
        logicalSessionId: 'logical-1',
        cwd: '/tmp/base/unbound-sessions/abc',
        unbound: true,
      });
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(createRuntime.mock.calls[0][0].projectTrusted).toBe(false);
    });

    it('leaves a normal session on the process posture', async () => {
      const { messages, createRuntime } = bootstrapWith(true, {
        logicalSessionId: 'logical-1',
        cwd: '/repo',
      });
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(createRuntime.mock.calls[0][0].projectTrusted).toBe(true);
    });

    it('[release-blocker] unbound can only remove trust, never grant it', async () => {
      // The direction that matters. A process started untrusted (managed
      // credentials) must stay untrusted no matter what the payload claims.
      const { messages, createRuntime } = bootstrapWith(false, {
        logicalSessionId: 'logical-1',
        cwd: '/repo',
        unbound: false,
      });
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(createRuntime.mock.calls[0][0].projectTrusted).toBe(false);
    });

    it('refuses to answer a re-bootstrap that flips the trust posture', async () => {
      // Without this, the second call would be served by the runtime built for
      // the first one — i.e. a scratch session answered by a trusted runtime.
      const messages: Array<Record<string, unknown>> = [];
      const createRuntime = vi.fn((_options: PiWorkerRuntimeOptions) => runtime());
      const server = new PiWorkerRpcServer({
        port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
        generation: 3,
        projectTrusted: true,
        createRuntime,
      });
      server.receive(
        request('first', 'worker.bootstrap', {
          logicalSessionId: 'logical-1',
          cwd: '/repo',
          unbound: true,
        })
      );
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      server.receive(
        request('second', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
      );
      await vi.waitFor(() => expect(messages).toHaveLength(2));
      expect(messages[1]).toMatchObject({
        requestId: 'second',
        ok: false,
        error: { code: 'WORKER_ALREADY_BOOTSTRAPPED' },
      });
      expect(createRuntime).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-boolean unbound rather than coercing it', async () => {
      const { messages, createRuntime } = bootstrapWith(true, {
        logicalSessionId: 'logical-1',
        cwd: '/repo',
        unbound: 'yes',
      });
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(messages[0]).toMatchObject({ ok: false, error: { code: 'WORKER_INVALID_PAYLOAD' } });
      expect(createRuntime).not.toHaveBeenCalled();
    });
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

  /**
   * dsh-rebase P1-12 step 3 (decision 147, risk R9): the import writer, the
   * one-shot utility engine and `worker.reload` left with the native worker.
   * Main calls none of them any more; a caller from an older build gets the
   * generic unknown-method answer and no runtime is ever constructed for it.
   */
  it('answers the retired native-only methods as unknown, without building a runtime', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const createRuntime = vi.fn((_options: PiWorkerRuntimeOptions) => runtime());
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime,
    });
    const retired = [
      'worker.import',
      'worker.import.inspect',
      'worker.import.reconcile',
      'worker.import.discard',
      'utility.start',
      'utility.cancel',
      'worker.reload',
    ];
    for (const [index, type] of retired.entries()) {
      server.receive(request(`retired-${index}`, type, { logicalSessionId: 'logical-1' }));
    }
    await vi.waitFor(() => expect(messages).toHaveLength(retired.length));
    for (const [index, type] of retired.entries()) {
      expect(messages[index], type).toMatchObject({
        requestId: `retired-${index}`,
        ok: false,
        error: { code: 'WORKER_METHOD_NOT_FOUND' },
      });
    }
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('returns correlated errors for stale, malformed, unknown, and pre-bootstrap send', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime(),
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

  it('validates and forwards both D14 axes, rejecting invalid values', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const setPermissions = vi.fn();
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime({ setPermissions }),
    });
    server.receive(
      request('boot', 'worker.bootstrap', {
        logicalSessionId: 'logical-1',
        cwd: '/repo',
        permissions: { mode: 'plan', gear: 'ask' },
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    server.receive(
      request('settings', 'worker.setPermissions', {
        logicalSessionId: 'logical-1',
        permissions: { mode: 'plan', gear: 'auto' },
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(setPermissions).toHaveBeenCalledWith({ mode: 'plan', gear: 'auto' });
    expect(messages[1]).toMatchObject({ ok: true, result: { applied: true } });
    server.receive(
      request('bad', 'worker.setPermissions', {
        logicalSessionId: 'logical-1',
        permissions: { mode: 'goal', gear: 'auto' },
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[2]).toMatchObject({ ok: false, error: { code: 'WORKER_INVALID_PAYLOAD' } });
    expect(setPermissions).toHaveBeenCalledTimes(1);
  });

  it('forwards the gear-only change and refuses one that names no valid gear', async () => {
    // The mid-turn path. It carries no `mode` at all, which is what makes it a
    // different call rather than a looser version of the one above: there is no
    // way to spell a mode change on this method, so the lock the running turn
    // keeps cannot be talked around by sending the wrong payload.
    const messages: Array<Record<string, unknown>> = [];
    const setPermissionGear = vi.fn();
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime({ setPermissionGear }),
    });
    server.receive(
      request('boot', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    server.receive(
      request('gear', 'worker.setPermissionGear', { logicalSessionId: 'logical-1', gear: 'bypass' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(setPermissionGear).toHaveBeenCalledWith('bypass');
    expect(messages[1]).toMatchObject({ ok: true, result: { applied: true } });
    server.receive(
      request('bad', 'worker.setPermissionGear', {
        logicalSessionId: 'logical-1',
        gear: 'fullopen',
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[2]).toMatchObject({ ok: false, error: { code: 'WORKER_INVALID_PAYLOAD' } });
    expect(setPermissionGear).toHaveBeenCalledTimes(1);
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

  it('never answers a permission tier with success before a runtime exists', async () => {
    // T025 replaced this test's old subject. It used to hand the dispatcher a
    // runtime with no `setPermissionTier` and assert `WORKER_UNSUPPORTED`; the
    // method is required now, so that shape does not compile and the branch is
    // gone. What still has to hold is the reason the branch existed: the tier is
    // a security axis — Main records it and the composer chip shows it — so
    // `applied: true` must never be answered by a server that applied nothing.
    const messages: Array<Record<string, unknown>> = [];
    const setPermissionTier = vi.fn();
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime({ setPermissionTier }),
    });
    server.receive(
      request('tier', 'worker.setPermissionTier', {
        logicalSessionId: 'logical-1',
        tier: 'readonly',
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ requestId: 'tier', ok: false });
    expect(messages[0]).not.toMatchObject({ result: { applied: true } });
    expect(setPermissionTier).not.toHaveBeenCalled();
  });

  it('separates a compact before bootstrap from one the runtime serves', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const compact = vi.fn(async () => ({ compacted: true }) as never);
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime({ compact }),
    });
    server.receive(request('early', 'worker.compact', { logicalSessionId: 'logical-1' }));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ error: { code: 'WORKER_NOT_BOOTSTRAPPED' } });

    server.receive(
      request('bootstrap', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    server.receive(request('compact', 'worker.compact', { logicalSessionId: 'logical-1' }));
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    // T025: `WORKER_COMPACT_UNAVAILABLE` used to be asserted here for a runtime
    // that implements no compaction. `compact` is required on the interface now,
    // so the only distinction left is the one that was always real — a worker
    // that has not bootstrapped yet versus one that has.
    expect(compact).toHaveBeenCalledWith({ logicalSessionId: 'logical-1' });
    expect(messages[2]).toMatchObject({ requestId: 'compact', ok: true });
  });

  it('finishes the tear-down and still exits when the engine fails to dispose', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const onDisposed = vi.fn();
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () =>
        runtime({
          dispose: async () => {
            throw new Error('exec shutdown never confirmed');
          },
        }),
      onDisposed,
    });
    server.receive(
      request('bootstrap', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    server.receive(request('dispose', 'worker.dispose', { reason: 'slot-dispose' }));
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    // The failure is reported to Main...
    expect(messages[1]).toMatchObject({ requestId: 'dispose', ok: false });
    // ...and everything else still happened. `onDisposed` is the only way this
    // process ever exits, and the slot really is finished rather than stuck
    // half torn down with its engine references still held.
    expect(onDisposed).toHaveBeenCalledTimes(1);
    server.receive(request('after', 'worker.history', { logicalSessionId: 'logical-1' }));
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[2]).toMatchObject({ error: { code: 'WORKER_DISPOSED' } });
  });

  it('lets the events a tear-down emits out before the port closes', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: (options) =>
        runtime({
          dispose: async () => {
            // What the engine really does here: deny every parked permission
            // gate, question and preview through the path a user answer takes,
            // which emits. Dropping these strands the dialogs Main is showing.
            options.emit({
              type: 'session.status',
              sessionId: 'logical-1',
              payload: { status: 'idle' },
            });
          },
        }),
    });
    server.receive(
      request('bootstrap', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    server.receive(request('dispose', 'worker.dispose', { reason: 'slot-dispose' }));
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[1]).toMatchObject({ kind: 'event', type: 'runtime.event' });
    expect(messages[2]).toMatchObject({ requestId: 'dispose', result: { disposed: true } });
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

/**
 * R02-a — routing the slash-command list.
 *
 * Asked by the composer as the user types `/`, so the two states that matter
 * are "a session exists" and "one does not yet" — the second is the ordinary
 * case on the start screen, not a fault.
 */
describe('PiWorkerRpcServer — worker.commands', () => {
  function serverWith(overrides: Partial<PiWorkerRuntime> = {}) {
    const messages: Array<Record<string, unknown>> = [];
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime(overrides),
    });
    return { messages, server };
  }

  it('routes to the runtime and returns its list', async () => {
    const commands = vi.fn(async () => ({
      commands: [{ name: 'skill:pdf', source: 'skill' }],
      truncated: false,
    }));
    const { messages, server } = serverWith({ commands });
    server.receive(
      request('bootstrap', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    server.receive(request('cmds', 'worker.commands', { logicalSessionId: 'logical-1' }));
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(commands).toHaveBeenCalledWith({ logicalSessionId: 'logical-1' });
    expect(messages[1]).toMatchObject({
      requestId: 'cmds',
      result: { commands: [{ name: 'skill:pdf', source: 'skill' }], truncated: false },
    });
  });

  it('answers an un-bootstrapped worker with an empty list, not an error', async () => {
    // The composer asks while the user types, and on the start screen there is
    // no session yet. An error here would have to be translated back into "no
    // commands" by every caller.
    const { messages, server } = serverWith();
    server.receive(request('cmds', 'worker.commands', { logicalSessionId: 'logical-1' }));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({
      requestId: 'cmds',
      result: { commands: [], truncated: false },
    });
  });

  it('rejects a payload without a session id', async () => {
    const { messages, server } = serverWith();
    server.receive(request('cmds', 'worker.commands', {}));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({
      requestId: 'cmds',
      error: { code: 'WORKER_INVALID_PAYLOAD' },
    });
  });
});

/**
 * dsh-rebase P1-7a (decision 118): the goal bar's out-of-band command and the
 * panels' rehydration. `worker.panels` is a read the renderer makes for every
 * chat it shows, so an un-bootstrapped worker answers no panels, as
 * `worker.commands` answers an empty menu; `worker.command` acts on a session
 * and needs one.
 */
describe('PiWorkerRpcServer — worker.command and worker.panels (P1-7a)', () => {
  function serverWith(overrides: Partial<PiWorkerRuntime> = {}) {
    const messages: Array<Record<string, unknown>> = [];
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime(overrides),
    });
    return { messages, server };
  }
  const bootstrap = request('bootstrap', 'worker.bootstrap', {
    logicalSessionId: 'logical-1',
    cwd: '/repo',
  });

  it('[P7A-RPC-CMD] routes a command line to the runtime and returns its answer', async () => {
    const command = vi.fn(async () => ({ ok: false as const, error: 'No goal is currently set' }));
    const { messages, server } = serverWith({ command });
    server.receive(bootstrap);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    server.receive(
      request('cmd', 'worker.command', { logicalSessionId: 'logical-1', line: '/goal pause' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(command).toHaveBeenCalledWith({ logicalSessionId: 'logical-1', line: '/goal pause' });
    expect(messages[1]).toMatchObject({
      requestId: 'cmd',
      result: { ok: false, error: 'No goal is currently set' },
    });
  });

  it('[P7A-RPC-CMD-PAYLOAD] refuses a line that is not a command, and an un-bootstrapped worker', async () => {
    const { messages, server } = serverWith();
    server.receive(request('bad', 'worker.command', { logicalSessionId: 'logical-1', line: 'hi' }));
    server.receive(
      request('early', 'worker.command', { logicalSessionId: 'logical-1', line: '/goal' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0]).toMatchObject({
      requestId: 'bad',
      error: { code: 'WORKER_INVALID_PAYLOAD' },
    });
    expect(messages[1]).toMatchObject({
      requestId: 'early',
      error: { code: 'WORKER_NOT_BOOTSTRAPPED' },
    });
  });

  it('[P7A-RPC-PANELS] routes to the runtime; an un-bootstrapped worker answers no panels', async () => {
    const panels = vi.fn(async () => ({
      projections: [{ key: 'todos' as const, view: null }],
    }));
    const { messages, server } = serverWith({ panels });
    server.receive(request('early', 'worker.panels', { logicalSessionId: 'logical-1' }));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ requestId: 'early', result: { projections: [] } });
    expect(panels).not.toHaveBeenCalled();

    server.receive(bootstrap);
    server.receive(request('panels', 'worker.panels', { logicalSessionId: 'logical-1' }));
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[2]).toMatchObject({
      requestId: 'panels',
      result: { projections: [{ key: 'todos', view: null }] },
    });
  });
});

/**
 * dsh-rebase P1-7b (decision 119): the jobs and subagents windows' three
 * RPCs. Each acts on a live session, so each needs a bootstrapped runtime,
 * as `worker.command` does, and each checks its payload first.
 */
describe('PiWorkerRpcServer — worker.job.kill, worker.job.read, worker.subagent.interrupt (P1-7b)', () => {
  function serverWith(overrides: Partial<PiWorkerRuntime> = {}) {
    const messages: Array<Record<string, unknown>> = [];
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime(overrides),
    });
    return { messages, server };
  }
  const bootstrap = request('bootstrap', 'worker.bootstrap', {
    logicalSessionId: 'logical-1',
    cwd: '/repo',
  });

  it('[P7B-RPC-ROUTE] routes each to the runtime and returns its answer', async () => {
    const killJob = vi.fn(async () => ({ outcome: 'requested' as const }));
    const readJob = vi.fn(async () => ({
      text: 'hi',
      from: 0,
      next: 2,
      omittedBytes: 0,
      lossy: false,
    }));
    const interruptSubagent = vi.fn(async () => ({ interrupted: true }));
    const { messages, server } = serverWith({ killJob, readJob, interruptSubagent });
    server.receive(bootstrap);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    server.receive(
      request('kill', 'worker.job.kill', { logicalSessionId: 'logical-1', jobId: 'bash-2' })
    );
    server.receive(
      request('read', 'worker.job.read', {
        logicalSessionId: 'logical-1',
        jobId: 'bash-2',
        from: 4,
      })
    );
    server.receive(
      request('int', 'worker.subagent.interrupt', {
        logicalSessionId: 'logical-1',
        childId: 'aiclient-kid',
      })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(4));
    expect(killJob).toHaveBeenCalledWith({ logicalSessionId: 'logical-1', jobId: 'bash-2' });
    expect(readJob).toHaveBeenCalledWith({
      logicalSessionId: 'logical-1',
      jobId: 'bash-2',
      from: 4,
    });
    expect(interruptSubagent).toHaveBeenCalledWith({
      logicalSessionId: 'logical-1',
      childId: 'aiclient-kid',
    });
    expect(messages.slice(1)).toEqual([
      expect.objectContaining({ requestId: 'kill', result: { outcome: 'requested' } }),
      expect.objectContaining({
        requestId: 'read',
        result: expect.objectContaining({ text: 'hi' }),
      }),
      expect.objectContaining({ requestId: 'int', result: { interrupted: true } }),
    ]);
  });

  it('[P7B-RPC-PAYLOAD] refuses a malformed payload, and a worker not bootstrapped', async () => {
    const { messages, server } = serverWith();
    server.receive(request('bad-kill', 'worker.job.kill', { logicalSessionId: 'logical-1' }));
    server.receive(
      request('bad-read', 'worker.job.read', {
        logicalSessionId: 'logical-1',
        jobId: 'bash-2',
        from: -3,
      })
    );
    server.receive(
      request('bad-int', 'worker.subagent.interrupt', { logicalSessionId: 'logical-1' })
    );
    server.receive(
      request('early', 'worker.job.kill', { logicalSessionId: 'logical-1', jobId: 'bash-2' })
    );
    await vi.waitFor(() => expect(messages).toHaveLength(4));
    for (const id of ['bad-kill', 'bad-read', 'bad-int']) {
      expect(messages.find((message) => message.requestId === id)).toMatchObject({
        error: { code: 'WORKER_INVALID_PAYLOAD' },
      });
    }
    expect(messages.find((message) => message.requestId === 'early')).toMatchObject({
      error: { code: 'WORKER_NOT_BOOTSTRAPPED' },
    });
  });
});
