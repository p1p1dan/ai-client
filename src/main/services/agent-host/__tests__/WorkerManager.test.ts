import { WORKER_RPC_PROTOCOL_VERSION, type WorkerRpcEvent } from '@shared/types/workerRpc';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveDefaultWorkerCapacity,
  resolveWorkerCapacity,
  WorkerManager,
} from '../WorkerManager';
import type { WorkerSlotLifecycleEvent } from '../WorkerSlot';

interface FakeSlotRecord {
  sessionId: string;
  sessionFile: string;
  generation: number;
  slotKey: string;
  request: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  forceKillNow: ReturnType<typeof vi.fn>;
  emit(event: Record<string, unknown>): void;
  crash(message?: string): void;
}

function createHarness(
  input: {
    capacity?: number;
    now?: () => number;
    bindRuntimeIdentity?: (sessionId: string, sessionFile: string) => Promise<void>;
    createFailureAfter?: number;
    maxRestartAttempts?: number;
  } = {}
) {
  const records: FakeSlotRecord[] = [];
  const events: Array<Record<string, unknown>> = [];
  const bindRuntimeIdentity = vi.fn(
    input.bindRuntimeIdentity ?? (async (_sessionId: string, _sessionFile: string) => undefined)
  );
  let createCount = 0;
  const createSlot = vi.fn(async (options: Record<string, unknown>) => {
    createCount += 1;
    if (input.createFailureAfter !== undefined && createCount > input.createFailureAfter) {
      throw new Error(`restart spawn ${createCount} failed`);
    }
    const sessionId = String(options.logicalSessionId);
    const generation = Number(options.generation ?? 1);
    const sessionFile = String(options.sessionFile ?? `/sessions/${sessionId}.jsonl`);
    const onEvent = options.onEvent as ((event: WorkerRpcEvent) => void) | undefined;
    const onLifecycle = options.onLifecycle as
      | ((event: WorkerSlotLifecycleEvent) => void)
      | undefined;
    const request = vi.fn(async (type: string, payload: unknown) => {
      if (type === 'worker.send') {
        return { accepted: true, requestId: (payload as { requestId: string }).requestId };
      }
      if (type === 'worker.stop') return { stopped: true };
      if (type === 'worker.extensionUi.respond') return { handled: true };
      throw new Error(`unexpected request ${type}`);
    });
    const record: FakeSlotRecord = {
      sessionId,
      sessionFile,
      generation,
      slotKey: String(options.slotKey),
      request,
      dispose: vi.fn(async () => undefined),
      forceKillNow: vi.fn(() => true),
      emit(event) {
        onEvent?.({
          protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
          kind: 'event',
          generation,
          type: 'runtime.event',
          payload: event,
        });
      },
      crash(message = 'worker crashed') {
        onLifecycle?.({
          type: 'crashed',
          slotKey: String(options.slotKey),
          generation,
          error: Object.assign(new Error(message), { code: 'WORKER_EXITED' }),
        } as WorkerSlotLifecycleEvent);
      },
    };
    records.push(record);
    return {
      slot: {
        generation,
        state: 'running',
        pid: 4000 + records.length,
        pendingRequestCount: 0,
        remapSlotKey: vi.fn(),
        request,
        dispose: record.dispose,
        forceKillNow: record.forceKillNow,
      },
      bootstrap: {
        bootstrapped: true,
        logicalSessionId: sessionId,
        piSessionId: `pi-${sessionId}`,
        cwd: String(options.cwd),
        agentDir: '/agent',
        sessionFile,
        projectTrusted: false,
        permissionGate: 'bundled',
      },
    };
  });
  const manager = new WorkerManager({
    createSlot: createSlot as never,
    bindRuntimeIdentity,
    onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    capacity: input.capacity ?? 4,
    idleTimeoutMs: 0,
    idleSweepIntervalMs: 0,
    maxRestartAttempts: input.maxRestartAttempts ?? 2,
    now: input.now,
    createToken: (() => {
      let token = 0;
      return () => `token-${++token}`;
    })(),
  });
  return { manager, records, events, createSlot, bindRuntimeIdentity };
}

async function create(
  manager: WorkerManager,
  sessionId: string,
  ownerWebContentsId?: number
): Promise<string> {
  return manager.createSession({
    sessionId,
    workspacePath: '/repo',
    ownerWebContentsId,
  });
}

describe('WorkerManager identity and capacity', () => {
  it('derives a resource-aware default and accepts only bounded startup overrides', () => {
    expect(resolveDefaultWorkerCapacity(3 * 1024 ** 3)).toBe(2);
    expect(resolveDefaultWorkerCapacity(6 * 1024 ** 3)).toBe(3);
    expect(resolveDefaultWorkerCapacity(16 * 1024 ** 3)).toBe(4);
    expect(resolveWorkerCapacity({ AICLIENT_PI_WORKER_CAPACITY: '1' }, 16 * 1024 ** 3)).toBe(1);
    expect(() =>
      resolveWorkerCapacity({ AICLIENT_PI_WORKER_CAPACITY: '9' }, 16 * 1024 ** 3)
    ).toThrow(/integer from 1 to 8/);
  });

  it('reserves unique temporary keys then atomically remaps and persists identity', async () => {
    const h = createHarness();
    await Promise.all([create(h.manager, 's1'), create(h.manager, 's2')]);

    expect(h.records.map((record) => record.slotKey)).toEqual([
      expect.stringMatching(/^workspace:.*session:s1:create:token-1$/),
      expect.stringMatching(/^workspace:.*session:s2:create:token-2$/),
    ]);
    expect(h.manager.getSlotSnapshots().map((slot) => slot.key)).toEqual([
      'session:/sessions/s1.jsonl',
      'session:/sessions/s2.jsonl',
    ]);
    expect(h.bindRuntimeIdentity.mock.calls).toEqual([
      ['s1', '/sessions/s1.jsonl'],
      ['s2', '/sessions/s2.jsonl'],
    ]);
  });

  it('rejects a durable-key collision without stealing the existing authority', async () => {
    const h = createHarness();
    h.createSlot.mockImplementationOnce(h.createSlot.getMockImplementation() as never);
    await create(h.manager, 's1');
    const original = h.createSlot.getMockImplementation();
    h.createSlot.mockImplementationOnce(async (options: Record<string, unknown>) => {
      const created = await original?.(options);
      if (!created) throw new Error('missing fake slot');
      return {
        ...created,
        bootstrap: { ...created.bootstrap, sessionFile: '/sessions/s1.jsonl' },
      };
    });

    await expect(create(h.manager, 's2')).rejects.toMatchObject({
      code: 'worker_session_identity_conflict',
    });
    expect(h.manager.getSlotSnapshots()).toHaveLength(1);
    expect(h.manager.getSlotSnapshots()[0]?.logicalSessionId).toBe('s1');
    expect(h.records[1].dispose).toHaveBeenCalledWith('slot-dispose');
  });

  it('keeps a remapped slot non-ready until the index commit succeeds', async () => {
    let releaseBinding: (() => void) | undefined;
    const bindingGate = new Promise<void>((resolve) => {
      releaseBinding = resolve;
    });
    const h = createHarness({ bindRuntimeIdentity: async () => bindingGate });
    const creating = create(h.manager, 's1');
    await vi.waitFor(() => expect(h.bindRuntimeIdentity).toHaveBeenCalledTimes(1));

    await expect(h.manager.send({ sessionId: 's1', text: 'too early' })).rejects.toMatchObject({
      code: 'session_not_found',
    });
    expect(h.events.some((event) => event.type === 'session.created')).toBe(false);
    expect(h.manager.getSlotSnapshots()[0]).toMatchObject({
      key: 'session:/sessions/s1.jsonl',
      state: 'creating',
    });

    releaseBinding?.();
    await creating;
    expect(h.manager.getSlotSnapshots()[0]?.state).toBe('ready');
  });

  it('disposes the partial slot and publishes no created event when index binding fails', async () => {
    const h = createHarness({
      bindRuntimeIdentity: async () => {
        throw new Error('disk full');
      },
    });
    await expect(create(h.manager, 's1')).rejects.toThrow(/disk full/);
    expect(h.records[0].dispose).toHaveBeenCalledWith('slot-dispose');
    expect(h.manager.getSlotSnapshots()).toEqual([]);
    expect(h.events.some((event) => event.type === 'session.created')).toBe(false);
  });

  it('evicts the oldest safe background slot and rejects an all-protected pool', async () => {
    let clock = 10;
    const h = createHarness({ capacity: 2, now: () => clock });
    await create(h.manager, 's1', 1);
    clock = 20;
    await create(h.manager, 's2', 2);
    h.manager.releaseSession('s1');
    clock = 30;
    await create(h.manager, 's3', 3);
    expect(h.records[0].dispose).toHaveBeenCalledWith('slot-replace');
    expect(h.manager.getSlotSnapshots().map((slot) => slot.logicalSessionId)).toEqual(['s2', 's3']);

    await expect(create(h.manager, 's4', 4)).rejects.toMatchObject({
      code: 'worker_capacity_reached',
      retryable: true,
    });
  });

  it('reclaims only expired safe idle slots', async () => {
    let clock = 0;
    const records: FakeSlotRecord[] = [];
    const base = createHarness({ capacity: 3, now: () => clock });
    records.push(...base.records);
    // Recreate with a finite TTL; the shared harness disables it by default.
    const manager = new WorkerManager({
      createSlot: base.createSlot as never,
      bindRuntimeIdentity: async () => undefined,
      capacity: 3,
      idleTimeoutMs: 100,
      idleSweepIntervalMs: 0,
      now: () => clock,
    });
    await create(manager, 'idle');
    clock = 50;
    await create(manager, 'foreground', 9);
    clock = 150;
    await manager.reclaimIdle();
    expect(manager.getSlotSnapshots().map((slot) => slot.logicalSessionId)).toEqual(['foreground']);
  });

  it('protects active turns and blocking Extension UI requests from eviction', async () => {
    const h = createHarness({ capacity: 2 });
    await create(h.manager, 'active');
    await create(h.manager, 'blocking');
    await h.manager.send({ sessionId: 'active', text: 'hello' });
    h.records[1].emit({
      type: 'extensionUi.request',
      sessionId: 'blocking',
      payload: {
        runtimeId: 'runtime-b',
        uiRequestId: 'ui-b',
        method: 'confirm',
        args: { message: 'allow?' },
      },
    });

    await expect(create(h.manager, 'third')).rejects.toMatchObject({
      code: 'worker_capacity_reached',
    });
    expect(h.records[0].dispose).not.toHaveBeenCalled();
    expect(h.records[1].dispose).not.toHaveBeenCalled();
  });
});

describe('WorkerManager isolation and crash recovery', () => {
  it('keeps one foreground session per window and releases only that window claims', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    await create(h.manager, 's2', 22);
    expect(
      h.manager.getSlotSnapshots().map((slot) => [slot.logicalSessionId, slot.foreground])
    ).toEqual([
      ['s1', true],
      ['s2', true],
    ]);

    h.manager.claimSession('s1', 22);
    expect(
      h.manager.getSlotSnapshots().map((slot) => [slot.logicalSessionId, slot.foreground])
    ).toEqual([
      ['s1', true],
      ['s2', false],
    ]);
    h.manager.releaseWindow(22);
    expect(h.manager.getSlotSnapshots().every((slot) => !slot.foreground)).toBe(true);
  });

  it('dismisses a blocking request when its owning window closes', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    const dismissGate: { finish?: () => void } = {};
    h.records[0].request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          dismissGate.finish = () => resolve({ handled: true });
        })
    );
    h.records[0].emit({
      type: 'extensionUi.request',
      sessionId: 's1',
      payload: {
        runtimeId: 'runtime-1',
        uiRequestId: 'ui-close',
        method: 'confirm',
        args: { message: 'allow?' },
      },
    });

    h.manager.releaseWindow(11);
    await vi.waitFor(() =>
      expect(h.records[0].request).toHaveBeenCalledWith(
        'worker.extensionUi.respond',
        expect.objectContaining({
          logicalSessionId: 's1',
          response: expect.objectContaining({ uiRequestId: 'ui-close', ok: false }),
        })
      )
    );
    await expect(
      h.manager.respondExtensionUi(
        { runtimeId: 'runtime-1', uiRequestId: 'ui-close', ok: true, value: true },
        22
      )
    ).rejects.toMatchObject({ code: 'extension_ui_request_not_found' });
    dismissGate.finish?.();
    await vi.waitFor(() =>
      expect(h.manager.getSlotSnapshots()[0]?.pendingBlockingRequests).toBe(0)
    );
    expect(h.events.at(-1)).toMatchObject({
      type: 'extensionUi.cancelled',
      sessionId: 's1',
      payload: { uiRequestIds: ['ui-close'], reason: 'aborted' },
    });
  });

  it('routes a blocking response to its exact slot and rejects another window', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    await create(h.manager, 's2', 22);
    h.records[0].emit({
      type: 'extensionUi.request',
      sessionId: 's1',
      payload: {
        runtimeId: 'runtime-1',
        uiRequestId: 'ui-1',
        method: 'select',
        args: { options: ['a'] },
      },
    });

    await expect(
      h.manager.respondExtensionUi(
        { runtimeId: 'runtime-1', uiRequestId: 'ui-1', ok: true, value: 'a' },
        22
      )
    ).rejects.toMatchObject({ code: 'extension_ui_owner_mismatch' });
    await h.manager.respondExtensionUi(
      { runtimeId: 'runtime-1', uiRequestId: 'ui-1', ok: true, value: 'a' },
      11
    );
    expect(h.records[0].request).toHaveBeenCalledWith(
      'worker.extensionUi.respond',
      expect.objectContaining({ logicalSessionId: 's1' })
    );
    expect(h.records[1].request).not.toHaveBeenCalled();
  });

  it('fails one active turn once, keeps the other slot, and reopens the same durable file', async () => {
    const h = createHarness();
    await create(h.manager, 's1');
    await create(h.manager, 's2');
    const turnId = await h.manager.send({ sessionId: 's1', text: 'hello' });
    h.records[0].emit({
      type: 'extensionUi.request',
      sessionId: 's1',
      payload: {
        runtimeId: 'runtime-crash',
        uiRequestId: 'ui-crash',
        method: 'confirm',
        args: { message: 'allow?' },
      },
    });
    h.records[0].crash('boom');

    await vi.waitFor(() => expect(h.records).toHaveLength(3));
    await vi.waitFor(() =>
      expect(
        h.manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === 's1')?.state
      ).toBe('ready')
    );
    const terminal = h.events.filter(
      (event) => event.type === 'session.failed' && event.requestId === turnId
    );
    expect(terminal).toHaveLength(1);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'extensionUi.cancelled',
        sessionId: 's1',
        payload: expect.objectContaining({
          runtimeId: 'runtime-crash',
          uiRequestIds: ['ui-crash'],
          reason: 'host_shutdown',
        }),
      })
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'extensionUi.reset',
        sessionId: 's1',
        payload: { runtimeId: 'runtime-crash', reason: 'host_shutdown' },
      })
    );
    expect(h.createSlot.mock.calls[2][0]).toMatchObject({
      logicalSessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      generation: 2,
    });
    expect(
      h.manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === 's2')
    ).toMatchObject({
      state: 'ready',
      generation: 1,
    });

    const beforeLate = h.events.length;
    h.records[0].emit({
      type: 'session.completed',
      sessionId: 's1',
      requestId: 'late-old-generation',
      payload: {},
    });
    expect(h.events).toHaveLength(beforeLate);
  });

  it('does not spawn a replacement when old-process exit is unconfirmed', async () => {
    const h = createHarness({ maxRestartAttempts: 2 });
    await create(h.manager, 's1');
    h.records[0].dispose.mockRejectedValue(new Error('exit not confirmed'));
    h.records[0].crash('boom');

    await vi.waitFor(() =>
      expect(h.manager.getSlotSnapshots()[0]).toMatchObject({
        state: 'error',
        error: expect.stringContaining('restart budget exhausted'),
      })
    );
    expect(h.createSlot).toHaveBeenCalledTimes(1);
    h.manager.forceKillAllNow();
    expect(h.records[0].forceKillNow).toHaveBeenCalledTimes(1);
  });

  it('stops after the bounded restart budget is exhausted', async () => {
    const h = createHarness({ createFailureAfter: 1, maxRestartAttempts: 2 });
    await create(h.manager, 's1');
    h.records[0].crash('boom');

    await vi.waitFor(() =>
      expect(h.manager.getSlotSnapshots()[0]).toMatchObject({
        state: 'error',
        error: expect.stringContaining('restart budget exhausted'),
      })
    );
    expect(h.createSlot).toHaveBeenCalledTimes(3);
  });

  it('owns and force-kills a worker even while bootstrap is still pending', async () => {
    const forceKillNow = vi.fn(() => true);
    const dispose = vi.fn(async () => undefined);
    const bootstrapGate: { finish?: () => void } = {};
    const createSlot = vi.fn(
      (options: Record<string, unknown>) =>
        new Promise((resolve) => {
          const slot = {
            generation: 1,
            state: 'running',
            pid: 4999,
            pendingRequestCount: 1,
            remapSlotKey: vi.fn(),
            request: vi.fn(),
            dispose,
            forceKillNow,
          };
          (options.onSlotCreated as (slot: unknown) => void)(slot);
          bootstrapGate.finish = () =>
            resolve({
              slot,
              bootstrap: {
                bootstrapped: true,
                logicalSessionId: 'pending',
                piSessionId: 'pi-pending',
                cwd: '/repo',
                agentDir: '/agent',
                sessionFile: '/sessions/pending.jsonl',
                projectTrusted: false,
                permissionGate: 'bundled',
              },
            });
        })
    );
    const manager = new WorkerManager({
      createSlot: createSlot as never,
      bindRuntimeIdentity: async () => undefined,
      capacity: 1,
      idleTimeoutMs: 0,
      idleSweepIntervalMs: 0,
    });
    const creating = create(manager, 'pending');
    await vi.waitFor(() => expect(createSlot).toHaveBeenCalledTimes(1));
    manager.forceKillAllNow();
    expect(forceKillNow).toHaveBeenCalledTimes(1);
    bootstrapGate.finish?.();
    await expect(creating).rejects.toMatchObject({ code: 'worker_create_superseded' });
  });

  it('retains physical ownership after disposal failure so deadline cleanup can retry kill', async () => {
    const h = createHarness();
    await create(h.manager, 's1');
    h.records[0].dispose.mockRejectedValueOnce(new Error('exit not confirmed'));

    await h.manager.disposeAll('app-shutdown');
    expect(h.records[0].forceKillNow).not.toHaveBeenCalled();
    h.manager.forceKillAllNow();
    expect(h.records[0].forceKillNow).toHaveBeenCalledTimes(1);
  });

  it('starts every slot disposal before awaiting completion and force-kills all owned slots', async () => {
    const h = createHarness();
    await create(h.manager, 's1');
    await create(h.manager, 's2');
    const gates: Array<() => void> = [];
    for (const record of h.records) {
      record.dispose.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            gates.push(resolve);
          })
      );
    }

    const disposing = h.manager.disposeAll('app-shutdown');
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    h.manager.forceKillAllNow();
    expect(h.records[0].forceKillNow).toHaveBeenCalledTimes(1);
    expect(h.records[1].forceKillNow).toHaveBeenCalledTimes(1);
    for (const release of gates) release();
    await disposing;
    expect(h.manager.getSlotSnapshots()).toEqual([]);
  });
});
