import type { WorkerImportConversationPayload } from '@shared/types/legacyImport';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { WORKER_RPC_PROTOCOL_VERSION, type WorkerRpcEvent } from '@shared/types/workerRpc';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveDefaultWorkerCapacity,
  resolveWorkerCapacity,
  WorkerManager,
} from '../WorkerManager';
import type { WorkerSlotLifecycleEvent } from '../WorkerSlot';

function importPayload(): WorkerImportConversationPayload {
  return {
    logicalSessionId: 'import-logical',
    targetPiSessionId: 'import-pi',
    conversation: {
      schemaVersion: 1,
      importerVersion: 'test',
      sourceKind: 'claude-code',
      stableSourceIdentity: 'source-hash',
      sourceSessionId: 'legacy-session',
      workspacePath: '/repo',
      title: 'Imported',
      sourceFingerprint: {
        stableSourceIdentity: 'source-hash',
        contentHash: 'content-hash',
        size: 1,
        mode: 0o100644,
        mtimeMs: 1,
      },
      entries: [
        { kind: 'user', text: 'hello' },
        { kind: 'assistant', blocks: [{ type: 'text', text: 'answer' }] },
      ],
      diagnostics: [],
    },
  };
}

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
    commitResumed?: (input: {
      sessionId: string;
      workspacePath: string;
      runtimeIdentity: string;
      model?: string;
    }) => Promise<void>;
    commitPiLeaf?: (input: {
      sessionId: string;
      runtimeIdentity: string;
      piLeaf: { activeEntryId: string | null; fileTailEntryId: string | null };
    }) => Promise<void>;
    createForked?: (entry: SessionIndexEntry) => Promise<SessionIndexEntry>;
    /**
     * Which Pi JSONL paths exist on disk. Defaults to "all of them", which is
     * the state a session reaches as soon as its first assistant message lands;
     * tests for the not-yet-written window pass their own predicate.
     */
    sessionFileExists?: (sessionFile: string) => Promise<boolean>;
    createFailureAfter?: number;
    maxRestartAttempts?: number;
  } = {}
) {
  const records: FakeSlotRecord[] = [];
  const events: Array<Record<string, unknown>> = [];
  const bindRuntimeIdentity = vi.fn(
    input.bindRuntimeIdentity ?? (async (_sessionId: string, _sessionFile: string) => undefined)
  );
  const commitResumed = vi.fn(input.commitResumed ?? (async () => undefined));
  const commitPiLeaf = vi.fn(input.commitPiLeaf ?? (async () => undefined));
  const createForked = vi.fn(input.createForked ?? (async (entry) => entry));
  const sessionFileExists = vi.fn(input.sessionFileExists ?? (async () => true));
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
      if (type === 'worker.history') {
        const historyPayload = payload as {
          logicalSessionId: string;
          offset?: number;
          limit?: number;
        };
        return {
          logicalSessionId: sessionId,
          sessionFile,
          workspacePath: String(options.cwd),
          page: {
            messages: [],
            offset: historyPayload.offset ?? 0,
            limit: historyPayload.limit ?? 80,
            totalCount: 0,
            hasMore: false,
          },
        };
      }
      if (type === 'worker.tree') {
        return {
          snapshot: {
            logicalSessionId: sessionId,
            sessionFile,
            workspacePath: String(options.cwd),
            leaf: { activeEntryId: 'leaf-a', fileTailEntryId: 'tail-c' },
            nodes: [
              {
                id: 'leaf-a',
                parentId: null,
                depth: 0,
                entryType: 'message',
                role: 'assistant',
                preview: 'A',
                childCount: 2,
                forkable: true,
                active: true,
                leaf: true,
              },
            ],
            totalNodes: 1,
            returnedNodes: 1,
            truncated: false,
          },
        };
      }
      if (type === 'worker.rewind') {
        return {
          logicalSessionId: sessionId,
          sessionFile,
          workspacePath: String(options.cwd),
          targetEntryId: (payload as { targetEntryId: string }).targetEntryId,
          leaf: { activeEntryId: 'leaf-a', fileTailEntryId: 'tail-c' },
          history: {
            logicalSessionId: sessionId,
            sessionFile,
            workspacePath: String(options.cwd),
            page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
          },
          tree: {
            snapshot: {
              logicalSessionId: sessionId,
              sessionFile,
              workspacePath: String(options.cwd),
              leaf: { activeEntryId: 'leaf-a', fileTailEntryId: 'tail-c' },
              nodes: [],
              totalNodes: 0,
              returnedNodes: 0,
              truncated: false,
            },
          },
        };
      }
      if (type === 'worker.fork') {
        return {
          logicalSessionId: sessionId,
          sourceSessionFile: sessionFile,
          sessionFile: '/sessions/forked.jsonl',
          piSessionId: 'pi-forked',
          workspacePath: String(options.cwd),
          leaf: { activeEntryId: 'leaf-a', fileTailEntryId: 'leaf-a' },
          history: {
            logicalSessionId: sessionId,
            sessionFile: '/sessions/forked.jsonl',
            workspacePath: String(options.cwd),
            page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
          },
        };
      }
      if (type === 'worker.fork.discard') return { discarded: true };
      if (type === 'worker.stop') return { stopped: true };
      if (type === 'worker.extensionUi.respond') return { handled: true };
      if (type === 'worker.setPermissionTier') return { applied: true };
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
        leaf: (options.leafCheckpoint as
          | { activeEntryId: string | null; fileTailEntryId: string | null }
          | undefined) ?? { activeEntryId: null, fileTailEntryId: null },
        ...(options.sessionFile
          ? {
              initialHistory: {
                logicalSessionId: sessionId,
                sessionFile,
                workspacePath: String(options.cwd),
                page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
              },
            }
          : {}),
        projectTrusted: false,
        permissionGate: 'bundled',
      },
    };
  });
  const manager = new WorkerManager({
    createSlot: createSlot as never,
    bindRuntimeIdentity,
    commitResumed,
    commitPiLeaf,
    createForked,
    sessionFileExists,
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
  return {
    manager,
    records,
    events,
    createSlot,
    bindRuntimeIdentity,
    commitResumed,
    commitPiLeaf,
    createForked,
    sessionFileExists,
  };
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
  it('loads a generation-bound tree, rewinds with branch replacement, and forks an independent slot', async () => {
    const h = createHarness();
    await create(h.manager, 'source', 11);
    h.events.length = 0;

    await expect(
      h.manager.getSessionTree({ sessionId: 'source', requestSequence: 7, ownerWebContentsId: 11 })
    ).resolves.toMatchObject({
      requestSequence: 7,
      branchRevision: 0,
      snapshot: { leaf: { activeEntryId: 'leaf-a', fileTailEntryId: 'tail-c' } },
    });

    const rewound = await h.manager.rewindSession({
      sessionId: 'source',
      entryId: 'leaf-a',
      confirmed: true,
      ownerWebContentsId: 11,
    });
    expect(rewound).toMatchObject({
      leaf: { activeEntryId: 'leaf-a', fileTailEntryId: 'tail-c' },
    });
    expect(h.commitPiLeaf).toHaveBeenCalledWith({
      sessionId: 'source',
      runtimeIdentity: '/sessions/source.jsonl',
      piLeaf: { activeEntryId: 'leaf-a', fileTailEntryId: 'tail-c' },
    });
    expect(h.events.map((event) => event.type)).toEqual(['session.history', 'session.status']);
    expect(h.events[0]).toMatchObject({ payload: { mode: 'branch' } });

    h.events.length = 0;
    const forked = await h.manager.forkSession({
      sourceSessionId: 'source',
      entryId: 'leaf-a',
      sourceTitle: 'Source',
      ownerWebContentsId: 11,
    });
    expect(forked.session).toMatchObject({
      runtimeIdentity: '/sessions/forked.jsonl',
      title: 'Source (fork)',
      agent: 'pi',
    });
    expect(h.records).toHaveLength(2);
    expect(h.manager.getSlotSnapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logicalSessionId: 'source',
          sessionFile: '/sessions/source.jsonl',
        }),
        expect.objectContaining({
          logicalSessionId: forked.session.sessionId,
          sessionFile: '/sessions/forked.jsonl',
        }),
      ])
    );
    expect(h.events.map((event) => event.type)).toEqual([
      'session.created',
      'session.history',
      'session.status',
    ]);
    await expect(
      h.manager.send({ sessionId: 'source', attemptId: 'after-fork', text: 'continue' })
    ).resolves.toMatch(/^send-/);
  });
  it('discards an uncommitted fork through the provisional target before disposal', async () => {
    const h = createHarness({
      createForked: async () => {
        throw new Error('fork index failed');
      },
    });
    await create(h.manager, 'source');

    await expect(
      h.manager.forkSession({
        sourceSessionId: 'source',
        entryId: 'leaf-a',
        sourceTitle: 'Source',
      })
    ).rejects.toThrow(/fork index failed/);

    expect(h.records).toHaveLength(2);
    expect(h.records[1].request).toHaveBeenCalledWith('worker.fork.discard', {
      logicalSessionId: expect.stringMatching(/^session-fork-/),
      sessionFile: '/sessions/forked.jsonl',
    });
    expect(h.records[1].dispose).toHaveBeenCalledWith('slot-dispose');
    expect(h.manager.getSlotSnapshots()).toEqual([
      expect.objectContaining({ logicalSessionId: 'source', state: 'ready' }),
    ]);
  });

  it('surfaces provisional-slot disposal failure during fork rollback', async () => {
    let rejectIndex: ((reason?: unknown) => void) | undefined;
    const indexGate = new Promise<SessionIndexEntry>((_resolve, reject) => {
      rejectIndex = reject;
    });
    const h = createHarness({ createForked: async () => indexGate });
    await create(h.manager, 'source');

    const forking = h.manager.forkSession({
      sourceSessionId: 'source',
      entryId: 'leaf-a',
      sourceTitle: 'Source',
    });
    await vi.waitFor(() => expect(h.records).toHaveLength(2));
    h.records[1].dispose.mockRejectedValueOnce(new Error('exit not confirmed'));
    rejectIndex?.(new Error('fork index failed'));

    await expect(forking).rejects.toMatchObject({
      code: 'worker_fork_cleanup_failed',
      message: expect.stringContaining('did not confirm disposal'),
    });
    h.manager.forceKillAllNow();
    expect(h.records[1].forceKillNow).toHaveBeenCalledTimes(1);
  });

  it('reserves the source against send while a rewind mutation is in flight', async () => {
    const h = createHarness();
    await create(h.manager, 'source');
    const original = h.records[0].request.getMockImplementation();
    let release: ((value: unknown) => void) | undefined;
    h.records[0].request.mockImplementation((type: string, payload: unknown) => {
      if (type !== 'worker.rewind') return original?.(type, payload);
      return new Promise((resolve) => {
        release = resolve;
      });
    });

    const rewinding = h.manager.rewindSession({
      sessionId: 'source',
      entryId: 'leaf-a',
      confirmed: true,
    });
    await vi.waitFor(() =>
      expect(h.records[0].request).toHaveBeenCalledWith(
        'worker.rewind',
        expect.objectContaining({ targetEntryId: 'leaf-a' })
      )
    );
    await expect(
      h.manager.send({ sessionId: 'source', attemptId: 'during-rewind', text: 'race' })
    ).rejects.toMatchObject({ code: 'session_busy' });
    await expect(
      h.manager.loadHistoryPage({ sessionId: 'source', offset: 0 })
    ).rejects.toMatchObject({ code: 'session_busy' });
    release?.({
      logicalSessionId: 'source',
      sessionFile: '/sessions/source.jsonl',
      workspacePath: '/repo',
      targetEntryId: 'leaf-a',
      leaf: { activeEntryId: 'leaf-a', fileTailEntryId: 'tail-c' },
      history: {
        logicalSessionId: 'source',
        sessionFile: '/sessions/source.jsonl',
        workspacePath: '/repo',
        page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
      },
      tree: {
        snapshot: {
          logicalSessionId: 'source',
          sessionFile: '/sessions/source.jsonl',
          workspacePath: '/repo',
          leaf: { activeEntryId: 'leaf-a', fileTailEntryId: 'tail-c' },
          nodes: [],
          totalNodes: 0,
          returnedNodes: 0,
          truncated: false,
        },
      },
    });
    await expect(rewinding).resolves.toMatchObject({
      requestId: expect.stringMatching(/^rewind-/),
    });
  });

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

  it('reattaches an existing ready slot without closing or spawning another worker', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    h.events.length = 0;

    const requestId = await create(h.manager, 's1', 22);

    expect(h.createSlot).toHaveBeenCalledTimes(1);
    expect(h.records[0].dispose).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      expect.objectContaining({
        type: 'session.created',
        sessionId: 's1',
        requestId,
        payload: { agent: 'pi', runtimeIdentity: '/sessions/s1.jsonl' },
      }),
      expect.objectContaining({
        type: 'session.status',
        sessionId: 's1',
        requestId,
        payload: { status: 'idle' },
      }),
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

    await expect(
      h.manager.send({ sessionId: 's1', attemptId: 'attempt-early', text: 'too early' })
    ).rejects.toMatchObject({
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

  it('rejects an empty renderer attempt before contacting the slot', async () => {
    const h = createHarness();
    await create(h.manager, 's1');

    await expect(
      h.manager.send({ sessionId: 's1', attemptId: '   ', text: 'hello' })
    ).rejects.toMatchObject({ code: 'invalid_send_attempt' });
    expect(h.records[0].request).not.toHaveBeenCalled();
  });

  it('protects active turns and blocking Extension UI requests from eviction', async () => {
    const h = createHarness({ capacity: 2 });
    await create(h.manager, 'active');
    await create(h.manager, 'blocking');
    await h.manager.send({ sessionId: 'active', attemptId: 'attempt-active', text: 'hello' });
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

describe('WorkerManager Pi history and real resume', () => {
  it('opens the exact durable file, commits it, then publishes resumed → history → idle', async () => {
    const h = createHarness();
    const requestId = await h.manager.resumeSession({
      sessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      workspacePath: '/repo',
      ownerWebContentsId: 11,
    });

    expect(h.createSlot).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalSessionId: 's1',
        sessionFile: '/sessions/s1.jsonl',
        cwd: '/repo',
      })
    );
    expect(h.commitResumed).toHaveBeenCalledWith({
      sessionId: 's1',
      workspacePath: '/repo',
      runtimeIdentity: '/sessions/s1.jsonl',
      piLeaf: { activeEntryId: null, fileTailEntryId: null },
    });
    expect(h.events.map((event) => [event.type, event.requestId])).toEqual([
      ['session.resumed', requestId],
      ['session.history', requestId],
      ['session.status', requestId],
    ]);
    expect(h.events[1]).toMatchObject({
      payload: {
        mode: 'initial',
        runtimeIdentity: '/sessions/s1.jsonl',
        offset: 0,
        limit: 80,
        totalCount: 0,
        hasMore: false,
      },
    });
  });

  it('coalesces concurrent duplicate resumes and rejects a conflicting exact file', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = createHarness({ commitResumed: async () => gate });
    const first = h.manager.resumeSession({
      sessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      workspacePath: '/repo',
      ownerWebContentsId: 11,
    });
    const duplicate = h.manager.resumeSession({
      sessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      workspacePath: '/repo',
      ownerWebContentsId: 22,
    });
    await vi.waitFor(() => expect(h.commitResumed).toHaveBeenCalledTimes(1));
    await expect(
      h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: '/sessions/other.jsonl',
        workspacePath: '/repo',
      })
    ).rejects.toMatchObject({ code: 'worker_resume_identity_conflict' });
    release?.();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.stringMatching(/^resume-/),
      expect.stringMatching(/^resume-/),
    ]);
    expect(await first).toBe(await duplicate);
    expect(h.createSlot).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event.type === 'session.resumed')).toHaveLength(1);

    h.records[0].emit({
      type: 'extensionUi.request',
      sessionId: 's1',
      payload: {
        runtimeId: 'runtime-owner',
        uiRequestId: 'ui-owner',
        method: 'confirm',
        args: { message: 'owner?' },
      },
    });
    await expect(
      h.manager.respondExtensionUi(
        { runtimeId: 'runtime-owner', uiRequestId: 'ui-owner', ok: true, value: true },
        11
      )
    ).rejects.toMatchObject({ code: 'extension_ui_owner_mismatch' });
    await expect(
      h.manager.respondExtensionUi(
        { runtimeId: 'runtime-owner', uiRequestId: 'ui-owner', ok: true, value: true },
        22
      )
    ).resolves.toMatch(/^extui-/);
  });

  it('reuses a ready exact slot for fresh history and paginates older rows without spawning', async () => {
    const h = createHarness();
    await h.manager.resumeSession({
      sessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      workspacePath: '/repo',
    });
    h.events.length = 0;
    h.records[0].request.mockClear();

    await h.manager.resumeSession({
      sessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      workspacePath: '/repo',
    });
    const pageRequestId = await h.manager.loadHistoryPage({
      sessionId: 's1',
      offset: 80,
      limit: 40,
    });

    expect(h.createSlot).toHaveBeenCalledTimes(1);
    expect(h.records[0].request).toHaveBeenNthCalledWith(1, 'worker.history', {
      logicalSessionId: 's1',
      offset: 0,
      limit: 80,
    });
    expect(h.records[0].request).toHaveBeenNthCalledWith(2, 'worker.history', {
      logicalSessionId: 's1',
      offset: 80,
      limit: 40,
    });
    expect(h.events.at(-1)).toMatchObject({
      type: 'session.history',
      requestId: pageRequestId,
      payload: { mode: 'older', offset: 80, limit: 40 },
    });
  });

  it('serializes older-page reads and rejects a page from a retired slot generation', async () => {
    const h = createHarness();
    await h.manager.resumeSession({
      sessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      workspacePath: '/repo',
    });
    h.events.length = 0;
    h.records[0].request.mockClear();

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const original = h.records[0].request.getMockImplementation();
    h.records[0].request.mockImplementationOnce(async (...args: unknown[]) => {
      await firstGate;
      return original?.(...args);
    });
    const first = h.manager.loadHistoryPage({ sessionId: 's1', offset: 0, limit: 40 });
    const second = h.manager.loadHistoryPage({ sessionId: 's1', offset: 40, limit: 40 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.records[0].request).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(h.records[0].request).toHaveBeenCalledTimes(2);

    let releaseStale: (() => void) | undefined;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    h.records[0].request.mockImplementationOnce(async (...args: unknown[]) => {
      await staleGate;
      return original?.(...args);
    });
    const stale = h.manager.loadHistoryPage({ sessionId: 's1', offset: 80, limit: 40 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const close = h.manager.closeSession('s1');
    await close;
    releaseStale?.();
    await expect(stale).rejects.toMatchObject({ code: 'worker_history_stale_generation' });
    expect(
      h.events.filter(
        (event) =>
          event.type === 'session.history' &&
          (event.payload as { mode?: string } | undefined)?.mode === 'older'
      )
    ).toHaveLength(2);
  });

  it('disposes a partial resume and publishes nothing when the index commit fails', async () => {
    const h = createHarness({
      commitResumed: async () => {
        throw new Error('disk full');
      },
    });
    await expect(
      h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: '/sessions/s1.jsonl',
        workspacePath: '/repo',
      })
    ).rejects.toThrow(/disk full/);
    expect(h.records[0].dispose).toHaveBeenCalledWith('slot-dispose');
    expect(h.manager.getSlotSnapshots()).toEqual([]);
    expect(h.events).toEqual([]);
  });
});

/**
 * Pi reserves a session's JSONL name at creation but writes nothing to it until
 * the first assistant message lands (SessionManager._persist's `hasAssistant`
 * guard). Main used to index that reservation as the session's durable runtime
 * identity straight away, so anything that ended the first turn early — a
 * killed worker, a user Stop, quitting the app — left a row pointing at a file
 * that had never existed. Reopening it always failed with
 * WORKER_SESSION_FILE_NOT_FOUND, which burned the restart budget, parked the
 * entry in `error` and left the session unusable for the rest of the run.
 */
describe('WorkerManager unwritten Pi session files', () => {
  const rejectSpawn = () => async () => {
    throw new Error('restart spawn failed');
  };
  /** Let the fire-and-forget identity commit settle before asserting it did not repeat. */
  const sleepTicks = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('publishes no runtime identity while Pi has not written the session file', async () => {
    const h = createHarness({ sessionFileExists: async () => false });

    const requestId = await create(h.manager, 's1');

    expect(h.bindRuntimeIdentity).not.toHaveBeenCalled();
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'session.created',
        sessionId: 's1',
        requestId,
        payload: { agent: 'pi' },
      })
    );
    // The slot itself is fully usable — only the durable claim is withheld.
    expect(h.manager.getSlotSnapshots()[0]).toMatchObject({
      state: 'ready',
      sessionFile: '/sessions/s1.jsonl',
    });
  });

  it('commits and announces the identity the first time the file exists', async () => {
    let written = false;
    const h = createHarness({ sessionFileExists: async () => written });
    await create(h.manager, 's1');
    expect(h.bindRuntimeIdentity).not.toHaveBeenCalled();

    written = true;
    h.records[0].emit({
      type: 'session.completed',
      sessionId: 's1',
      requestId: 'turn-1',
      payload: { status: 'completed' },
    });

    await vi.waitFor(() =>
      expect(h.bindRuntimeIdentity).toHaveBeenCalledWith('s1', '/sessions/s1.jsonl')
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'session.updated',
        sessionId: 's1',
        payload: { runtimeIdentity: '/sessions/s1.jsonl' },
      })
    );
    // The leaf commit is what the index rejects for an unbound session, so it
    // has to land after the identity, not instead of it.
    await vi.waitFor(() =>
      expect(h.commitPiLeaf).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1', runtimeIdentity: '/sessions/s1.jsonl' })
      )
    );
  });

  it('claims the identity mid-turn, not only when the turn ends', async () => {
    let written = false;
    const h = createHarness({ sessionFileExists: async () => written });
    await create(h.manager, 's1');

    // Pi writes the file on the first completed assistant message. A turn that
    // then runs tools for minutes must not leave the session unidentified in
    // the meantime: an app killed there would come back unable to reach a
    // transcript that is sitting on disk.
    written = true;
    h.records[0].emit({
      type: 'message.completed',
      sessionId: 's1',
      requestId: 'turn-1',
      payload: { messageId: 'm1' },
    });

    await vi.waitFor(() =>
      expect(h.bindRuntimeIdentity).toHaveBeenCalledWith('s1', '/sessions/s1.jsonl')
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'session.updated',
        sessionId: 's1',
        payload: { runtimeIdentity: '/sessions/s1.jsonl' },
      })
    );
    // Idempotent: later messages must not re-bind or re-announce.
    h.records[0].emit({
      type: 'message.completed',
      sessionId: 's1',
      requestId: 'turn-1',
      payload: { messageId: 'm2' },
    });
    await sleepTicks();
    expect(h.bindRuntimeIdentity).toHaveBeenCalledTimes(1);
    expect(h.events.filter((event) => event.type === 'session.updated')).toHaveLength(1);
  });

  it('starts a fresh Pi session when the crashed worker never wrote its file', async () => {
    const h = createHarness({ sessionFileExists: async () => false });
    await create(h.manager, 's1');
    const spawn = h.createSlot.getMockImplementation();
    h.createSlot.mockImplementationOnce(async (options: Record<string, unknown>) => {
      const created = await spawn?.(options);
      if (!created) throw new Error('missing fake slot');
      return {
        ...created,
        bootstrap: { ...created.bootstrap, sessionFile: '/sessions/s1-second.jsonl' },
      };
    });

    h.records[0].crash('killed before the first write');

    await vi.waitFor(() =>
      expect(h.manager.getSlotSnapshots()[0]).toMatchObject({
        state: 'ready',
        sessionFile: '/sessions/s1-second.jsonl',
        key: 'session:/sessions/s1-second.jsonl',
        generation: 2,
      })
    );
    // Restarted as a new session rather than reopening a file that never was.
    expect(h.createSlot.mock.calls[1][0]).not.toHaveProperty('sessionFile');
    expect(h.createSlot.mock.calls[1][0]).not.toHaveProperty('leafCheckpoint');
    // The replacement is just as unwritten, so it earns its identity the same way.
    expect(h.bindRuntimeIdentity).not.toHaveBeenCalled();
    await expect(
      h.manager.send({ sessionId: 's1', attemptId: 'after-restart', text: 'again' })
    ).resolves.toMatch(/^send-/);
  });

  // U05-c — the trust posture of an unbound session has to survive everything
  // that respawns its worker, or a crash silently upgrades a scratch session.
  it('carries the unbound posture into the spawn, and keeps it across a crash restart', async () => {
    const h = createHarness({ sessionFileExists: async () => false });
    await h.manager.createSession({
      sessionId: 's1',
      workspacePath: '/tmp/base/unbound-sessions/abc',
      unbound: true,
    });
    expect(h.createSlot.mock.calls[0][0]).toMatchObject({ unbound: true });

    h.records[0].crash('killed');
    await vi.waitFor(() => expect(h.createSlot).toHaveBeenCalledTimes(2));
    expect(h.createSlot.mock.calls[1][0]).toMatchObject({ unbound: true });
  });

  it('omits unbound entirely for a normal session', async () => {
    // Omission, not `unbound: false`: `sameBootstrap` compares the field by
    // identity, so a spawn that sends `false` and one that sends nothing would
    // read as two different sessions to the same worker.
    const h = createHarness();
    await create(h.manager, 's1');
    expect(h.createSlot.mock.calls[0][0]).not.toHaveProperty('unbound');
  });

  it('carries the unbound posture through resume', async () => {
    const h = createHarness();
    await h.manager.resumeSession({
      sessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      workspacePath: '/tmp/base/unbound-sessions/abc',
      unbound: true,
    });
    expect(h.createSlot.mock.calls[0][0]).toMatchObject({ unbound: true });
  });

  it('[release-blocker] a fork inherits its source posture instead of coming back trusted', async () => {
    // A fork shares its source's directory. If it did not share the posture,
    // "fork this chat" would be a one-click trust upgrade on a scratch folder.
    const h = createHarness();
    await h.manager.createSession({
      sessionId: 's1',
      workspacePath: '/tmp/base/unbound-sessions/abc',
      unbound: true,
    });
    await h.manager.forkSession({ sourceSessionId: 's1', entryId: 'e1', sourceTitle: 'Chat' });
    expect(h.createSlot.mock.calls[1][0]).toMatchObject({ unbound: true });
  });

  // U12 fix — the composer chip and the runtime used to be able to disagree,
  // always in the permissive direction. Both drifts are Main's to close,
  // because Main is the only side that outlives a worker.
  describe('permission tier survives every spawn', () => {
    it('carries the tier into the spawn instead of leaving the worker on the default', async () => {
      const h = createHarness();
      await h.manager.createSession({ sessionId: 's1', workspacePath: '/repo', tier: 'readonly' });
      expect(h.createSlot.mock.calls[0][0]).toMatchObject({ tier: 'readonly' });
    });

    it('omits the tier for an untouched session', async () => {
      // Omission keeps an untouched session's bootstrap payload identical to
      // what it was before this fix, so the default stays the worker's own.
      const h = createHarness();
      await create(h.manager, 's1');
      expect(h.createSlot.mock.calls[0][0]).not.toHaveProperty('tier');
    });

    it('carries the tier through resume', async () => {
      const h = createHarness();
      await h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: '/sessions/s1.jsonl',
        workspacePath: '/repo',
        tier: 'readonly',
      });
      expect(h.createSlot.mock.calls[0][0]).toMatchObject({ tier: 'readonly' });
    });

    it('accepts a tier for a session that has no worker yet, without pretending it landed', async () => {
      // Nothing has been sent, so there is no worker to push to. Main does not
      // keep a second copy of the preference for this case — the renderer owns
      // it and hands it to `createSession` on the first send, so a copy here
      // would be a second source of truth with its own eviction problem. What
      // this pins is that the call is a harmless deferral, not a throw.
      // The renderer half is covered by `permissionTierWiring.test.ts` and
      // `chatPiWorkerRouting.test.ts`.
      const h = createHarness();
      await expect(h.manager.setPermissionTier('never-sent', 'readonly')).resolves.toMatch(
        /^permtier-/
      );
      await create(h.manager, 'never-sent');
      expect(h.createSlot.mock.calls[0][0]).not.toHaveProperty('tier');
    });

    it('[regression] respawns a crashed worker on the tier in force, not the default', async () => {
      // Defect B. The authorizer is rebuilt per bootstrap, so a restart used to
      // drop back to the default while the chip still showed the user's tier.
      const h = createHarness({ sessionFileExists: async () => false });
      await create(h.manager, 's1');
      await h.manager.setPermissionTier('s1', 'readonly');

      h.records[0].crash('killed');
      await vi.waitFor(() => expect(h.createSlot).toHaveBeenCalledTimes(2));
      expect(h.createSlot.mock.calls[1][0]).toMatchObject({ tier: 'readonly' });
    });

    it('respawns on the LATEST tier when it changed more than once', async () => {
      const h = createHarness({ sessionFileExists: async () => false });
      await create(h.manager, 's1');
      await h.manager.setPermissionTier('s1', 'fullopen');
      await h.manager.setPermissionTier('s1', 'readonly');

      h.records[0].crash('killed');
      await vi.waitFor(() => expect(h.createSlot).toHaveBeenCalledTimes(2));
      expect(h.createSlot.mock.calls[1][0]).toMatchObject({ tier: 'readonly' });
    });

    it('does not let a fork inherit its source tier', async () => {
      // The opposite call from `unbound`, and deliberately so: inheriting the
      // trust posture is the safe direction, inheriting `fullopen` is not — and
      // the fork's own (empty) stored preference makes its chip read the
      // default, so inheriting would recreate the very drift being fixed.
      const h = createHarness();
      await h.manager.createSession({ sessionId: 's1', workspacePath: '/repo', tier: 'fullopen' });
      await h.manager.forkSession({ sourceSessionId: 's1', entryId: 'e1', sourceTitle: 'Chat' });
      expect(h.createSlot.mock.calls[1][0]).not.toHaveProperty('tier');
    });
  });

  it('still reopens the exact file when a written session goes missing', async () => {
    const present = new Set(['/sessions/s1.jsonl']);
    const h = createHarness({ sessionFileExists: async (file) => present.has(file) });
    await create(h.manager, 's1');
    expect(h.bindRuntimeIdentity).toHaveBeenCalledWith('s1', '/sessions/s1.jsonl');

    // History that once existed and is now gone is real loss: the restart must
    // surface it, never paper over it with an empty replacement session.
    present.clear();
    h.records[0].crash('boom');

    await vi.waitFor(() => expect(h.createSlot).toHaveBeenCalledTimes(2));
    expect(h.createSlot.mock.calls[1][0]).toMatchObject({
      logicalSessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
    });
  });

  it('lets resume clear a session parked in error instead of failing forever', async () => {
    const h = createHarness({ maxRestartAttempts: 2 });
    await create(h.manager, 's1');
    h.createSlot.mockImplementationOnce(rejectSpawn());
    h.createSlot.mockImplementationOnce(rejectSpawn());

    h.records[0].crash('boom');
    await vi.waitFor(() =>
      expect(h.manager.getSlotSnapshots()[0]).toMatchObject({
        state: 'error',
        error: expect.stringContaining('restart budget exhausted'),
      })
    );

    await expect(
      h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: '/sessions/s1.jsonl',
        workspacePath: '/repo',
      })
    ).resolves.toMatch(/^resume-/);
    expect(h.manager.getSlotSnapshots()).toHaveLength(1);
    expect(h.manager.getSlotSnapshots()[0]).toMatchObject({
      logicalSessionId: 's1',
      state: 'ready',
    });
  });

  it('retires a dead slot to make room instead of reporting the pool full', async () => {
    const h = createHarness({ capacity: 1, maxRestartAttempts: 1 });
    await create(h.manager, 's1');
    h.createSlot.mockImplementationOnce(rejectSpawn());

    h.records[0].crash('boom');
    await vi.waitFor(() =>
      expect(h.manager.getSlotSnapshots()[0]).toMatchObject({ state: 'error' })
    );

    await expect(create(h.manager, 's2')).resolves.toMatch(/^create-/);
    expect(h.manager.getSlotSnapshots().map((slot) => slot.logicalSessionId)).toEqual(['s2']);
  });
});

describe('WorkerManager isolation and crash recovery', () => {
  it('keeps interleaved multi-slot streams session-scoped and Main-sequenced', async () => {
    const h = createHarness();
    await create(h.manager, 's1');
    await create(h.manager, 's2');
    h.events.length = 0;

    h.records[0].emit({
      type: 'message.started',
      sessionId: 's1',
      requestId: 'turn-a',
      seq: 91,
      timestamp: 91,
      payload: { messageId: 'a1', role: 'assistant' },
    });
    h.records[1].emit({
      type: 'message.started',
      sessionId: 's2',
      requestId: 'turn-b',
      seq: 1,
      timestamp: 1,
      payload: { messageId: 'b1', role: 'assistant' },
    });
    h.records[0].emit({
      type: 'message.delta',
      sessionId: 's1',
      requestId: 'turn-a',
      seq: 92,
      timestamp: 92,
      payload: { messageId: 'a1', blockId: 'a-text', text: 'A' },
    });
    h.records[1].emit({
      type: 'message.delta',
      sessionId: 's2',
      requestId: 'turn-b',
      seq: 2,
      timestamp: 2,
      payload: { messageId: 'b1', blockId: 'b-text', text: 'B' },
    });

    expect(h.events.map((event) => [event.type, event.sessionId])).toEqual([
      ['message.started', 's1'],
      ['message.started', 's2'],
      ['message.delta', 's1'],
      ['message.delta', 's2'],
    ]);
    const managerSequences = h.events.map((event) => Number(event.seq));
    expect(managerSequences).toEqual([...managerSequences].sort((left, right) => left - right));
    expect(new Set(managerSequences)).toHaveLength(managerSequences.length);
    expect(h.events.map((event) => event.timestamp)).not.toEqual([91, 1, 92, 2]);
  });

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

  it('keeps display events non-blocking and resets each runtime on config invalidation', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    await create(h.manager, 's2', 22);
    h.records[0].emit({
      type: 'extensionUi.request',
      sessionId: 's1',
      payload: {
        runtimeId: 'runtime-a',
        uiRequestId: 'status-a',
        method: 'setStatus',
        args: { key: 'lint', text: 'running' },
      },
    });
    h.records[1].emit({
      type: 'extensionUi.request',
      sessionId: 's2',
      payload: {
        runtimeId: 'runtime-b',
        uiRequestId: 'widget-b',
        method: 'setWidget',
        args: { key: 'tests', content: ['running'] },
      },
    });

    expect(h.manager.getSlotSnapshots().map((slot) => slot.pendingBlockingRequests)).toEqual([
      0, 0,
    ]);
    await h.manager.invalidateAll();

    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'extensionUi.reset',
        sessionId: 's1',
        payload: { runtimeId: 'runtime-a', reason: 'session_replaced' },
      })
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'extensionUi.reset',
        sessionId: 's2',
        payload: { runtimeId: 'runtime-b', reason: 'session_replaced' },
      })
    );
    expect(h.records[0].dispose).toHaveBeenCalledWith('slot-replace');
    expect(h.records[1].dispose).toHaveBeenCalledWith('slot-replace');
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

  it('closes one session with cancel/reset and rejects a stale response without touching another slot', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    await create(h.manager, 's2', 22);
    h.records[0].emit({
      type: 'extensionUi.request',
      sessionId: 's1',
      payload: {
        runtimeId: 'runtime-a',
        uiRequestId: 'ui-a',
        method: 'confirm',
        args: { message: 'allow?' },
      },
    });

    await h.manager.closeSession('s1');

    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'extensionUi.cancelled',
        sessionId: 's1',
        payload: {
          runtimeId: 'runtime-a',
          uiRequestIds: ['ui-a'],
          reason: 'session_closed',
        },
      })
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'extensionUi.reset',
        sessionId: 's1',
        payload: { runtimeId: 'runtime-a', reason: 'session_closed' },
      })
    );
    await expect(
      h.manager.respondExtensionUi(
        { runtimeId: 'runtime-a', uiRequestId: 'ui-a', ok: true, value: true },
        11
      )
    ).rejects.toMatchObject({ code: 'extension_ui_request_not_found' });
    expect(h.records[1].request).not.toHaveBeenCalled();
    expect(h.manager.getSlotSnapshots()).toEqual([
      expect.objectContaining({ logicalSessionId: 's2', state: 'ready' }),
    ]);
  });

  it('fails one active turn once, keeps the other slot, and reopens the same durable file', async () => {
    const h = createHarness();
    await create(h.manager, 's1');
    await create(h.manager, 's2');
    const turnId = await h.manager.send({
      sessionId: 's1',
      attemptId: 'attempt-s1',
      text: 'hello',
    });
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
    const restartTriplet = h.events.filter(
      (event) =>
        typeof event.requestId === 'string' && String(event.requestId).startsWith('restart-')
    );
    expect(restartTriplet.map((event) => event.type)).toEqual([
      'session.resumed',
      'session.history',
      'session.status',
    ]);
    expect(restartTriplet[1]).toMatchObject({
      payload: {
        runtimeIdentity: '/sessions/s1.jsonl',
        workspacePath: '/repo',
        mode: 'refresh',
      },
    });
    expect(
      h.manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === 's2')
    ).toMatchObject({
      state: 'ready',
      generation: 1,
    });

    const beforeLate = h.events.length;
    h.records[0].emit({
      type: 'message.delta',
      sessionId: 's1',
      requestId: 'late-old-generation',
      payload: { messageId: 'old-a', blockId: 'old-a-text', text: 'stale A' },
    });
    h.records[1].emit({
      type: 'message.delta',
      sessionId: 's2',
      requestId: 'live-b',
      payload: { messageId: 'live-b', blockId: 'live-b-text', text: 'live B' },
    });
    expect(h.events).toHaveLength(beforeLate + 1);
    expect(h.events.at(-1)).toMatchObject({
      type: 'message.delta',
      sessionId: 's2',
      requestId: 'live-b',
      payload: { text: 'live B' },
    });
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ requestId: 'late-old-generation' })
    );
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
                leaf: { activeEntryId: null, fileTailEntryId: null },
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

  it('owns the bounded legacy import slot and disposes it on app shutdown', async () => {
    const dispose = vi.fn(async () => undefined);
    const forceKillNow = vi.fn(() => true);
    const createImport = vi.fn(async (_payload, options) => {
      options?.onSlotCreated?.({ state: 'running', dispose, forceKillNow } as never);
      return {
        result: {
          logicalSessionId: 'import-logical',
          piSessionId: 'import-pi',
          workspacePath: '/repo',
          stagedSessionFile: '/sessions/.staging/import-pi.jsonl',
          finalSessionFile: '/sessions/import-pi.jsonl',
          leaf: { activeEntryId: 'leaf', fileTailEntryId: 'leaf' },
          history: {
            logicalSessionId: 'import-logical',
            sessionFile: '/sessions/import-pi.jsonl',
            workspacePath: '/repo',
            page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
          },
        },
        pid: 7001,
        discard: vi.fn(async () => true),
        dispose,
        forceKillNow,
      };
    });
    const manager = new WorkerManager({
      createImport,
      reconcileImport: async () => ({ removedFiles: 0, remainingFiles: 0 }),
      idleTimeoutMs: 0,
      idleSweepIntervalMs: 0,
    });
    const imported = await manager.createLegacyImport(importPayload());
    await expect(manager.createLegacyImport(importPayload())).rejects.toMatchObject({
      code: 'worker_import_busy',
    });
    expect(imported.pid).toBe(7001);
    await manager.disposeAll('app-shutdown');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('retains import ownership when dispose and immediate force-kill both fail', async () => {
    const dispose = vi.fn(async () => {
      throw new Error('dispose failed');
    });
    const importForceKill = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const slotForceKill = vi.fn(() => true);
    const createImport = vi.fn(async (_payload, options) => {
      options?.onSlotCreated?.({
        state: 'running',
        dispose,
        forceKillNow: slotForceKill,
      } as never);
      return {
        result: {
          logicalSessionId: 'import-logical',
          piSessionId: 'import-pi',
          workspacePath: '/repo',
          stagedSessionFile: '/sessions/.staging/import-pi.jsonl',
          finalSessionFile: '/sessions/import-pi.jsonl',
          leaf: { activeEntryId: 'leaf', fileTailEntryId: 'leaf' },
          history: {
            logicalSessionId: 'import-logical',
            sessionFile: '/sessions/import-pi.jsonl',
            workspacePath: '/repo',
            page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
          },
        },
        discard: vi.fn(async () => true),
        dispose,
        forceKillNow: importForceKill,
      };
    });
    const manager = new WorkerManager({
      createImport,
      reconcileImport: async () => ({ removedFiles: 0, remainingFiles: 0 }),
      idleTimeoutMs: 0,
      idleSweepIntervalMs: 0,
    });
    const imported = await manager.createLegacyImport(importPayload());
    await expect(imported.dispose()).rejects.toThrow('dispose failed');
    await expect(manager.createLegacyImport(importPayload())).rejects.toMatchObject({
      code: 'worker_import_busy',
    });
    manager.forceKillAllNow();
    expect(importForceKill).toHaveBeenCalledTimes(2);
    expect(slotForceKill).toHaveBeenCalledTimes(1);
  });

  it('tracks and force-kills an in-flight reconciliation WorkerSlot', async () => {
    const forceKillNow = vi.fn(() => true);
    const dispose = vi.fn(async () => undefined);
    let finish: (() => void) | undefined;
    const reconcileImport = vi.fn(
      (_payload, options) =>
        new Promise<{ removedFiles: number; remainingFiles: number }>((resolve) => {
          options?.onSlotCreated?.({ state: 'running', dispose, forceKillNow } as never);
          finish = () => resolve({ removedFiles: 1, remainingFiles: 0 });
        })
    );
    const manager = new WorkerManager({
      createImport: async () => {
        throw new Error('unused');
      },
      reconcileImport,
      idleTimeoutMs: 0,
      idleSweepIntervalMs: 0,
    });
    const reconciling = manager.reconcileLegacyImport({
      logicalSessionId: 'interrupted',
      workspacePath: '/repo',
      targetPiSessionId: 'import-pi',
    });
    await vi.waitFor(() => expect(reconcileImport).toHaveBeenCalledTimes(1));
    manager.forceKillAllNow();
    expect(forceKillNow).toHaveBeenCalledTimes(1);
    finish?.();
    await expect(reconciling).resolves.toEqual({ removedFiles: 1, remainingFiles: 0 });
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
