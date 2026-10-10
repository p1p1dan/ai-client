import { STDERR_FORWARD_MAX_LINES_PER_TURN } from '@shared/stderrRedaction';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import {
  WORKER_COMPACT_BUDGET_MS,
  WORKER_COMPACT_REQUEST_TIMEOUT_MS,
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerRpcEvent,
} from '@shared/types/workerRpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeWorkerPath, sessionWorkerKey } from '../workerSessionKey';

// Normalize a POSIX-style path to the current platform's canonical form so
// fixture paths and assertion values agree on Windows and Linux alike.
const norm = (p: string) => normalizeWorkerPath(p);
const slotKey = (p: string) => sessionWorkerKey(p);

import { DSH_HOST_RESTART_BUDGET, DshHostSupervisorError } from '../DshHostSupervisor';
import {
  HOST_RESTART_DRAIN_MS,
  resolveDefaultWorkerCapacity,
  resolveWorkerCapacity,
  STOP_WATCHDOG_MS,
  WorkerManager,
  type WorkerManagerHost,
} from '../WorkerManager';
import { WorkerSlotError, type WorkerSlotLifecycleEvent } from '../WorkerSlot';
import { installKillTripwire } from './fakeDshHost';

interface FakeSlotRecord {
  sessionId: string;
  sessionFile: string;
  generation: number;
  slotKey: string;
  /** The slot object the manager holds; `state` moves like WorkerSlot's. */
  slot: { state: string };
  /** Its channel on the shared host, as the host's pong names it (P1-3d). */
  channelId: string;
  request: ReturnType<typeof vi.fn>;
  /**
   * Decision 155: the channel's answer to a `worker.dispose` request (not the
   * slot's own `dispose`). By default the bridge's: the ACK, then the channel
   * closes (`cause: 'channel-closed'`).
   */
  drain: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  forceKillNow: ReturnType<typeof vi.fn>;
  emit(event: Record<string, unknown>): void;
  /** One raw stderr chunk, split at whatever boundary the OS handed over. */
  stderr(chunk: string): void;
  crash(
    message?: string,
    exit?: { code: number | null; signal: string | null; cause?: string }
  ): void;
  /** The host confirms this channel closed (`closed`), as after a `worker.dispose`. */
  closeChannel(): void;
}

/**
 * dsh-rebase P1-3c — the shared DSH host every fake slot of one harness runs
 * on: the supervisor's interface (`WorkerManagerHost`) with its restart budget
 * (decision 020 rule 4) and its user-action bypass. The harness's `hostCrash`
 * ends every live slot's channel at once, the way a real host exit does.
 */
interface FakeHost {
  state: 'ready' | 'idle' | 'restarting' | 'failed' | 'disposed';
  generation: number;
  /** Hosts brought up after the first. */
  starts: number;
  faults: number[];
  lastExit?: { generation: number; reason: string; code: null; signal: string; at: number };
  failure?: Error;
  status: ReturnType<typeof vi.fn>;
  ensureHost: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  forceKillNow: ReturnType<typeof vi.fn>;
  /** Channels the last pong called busy (P1-3d). */
  busy: Set<string>;
  collectSessions?: ReturnType<typeof vi.fn>;
  /** The model plan revision the running host was configured with (P1-5a). */
  planRevision?: string;
  /** The plugin selection the running host was launched with (P1-10b). */
  pluginSelection?: string;
  /** One-shot completions in flight on the host (P1-15). */
  completions?: number;
}

const BUDGETED_HOST_EXITS = new Set([
  'crashed',
  'hung',
  'disconnected',
  'start-failed',
  'stuck-session',
]);

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
    /** session-index-09 — the index rows the startup sweep reconciles against. */
    listIndexedSessions?: () => Promise<SessionIndexEntry[]>;
    /** Names in a session directory, as the startup sweep reads them. */
    readSessionDirectory?: (directory: string) => Promise<string[]>;
    removeSessionFile?: (file: string) => Promise<void>;
    createFailureAfter?: number;
    maxRestartAttempts?: number;
    /** D10: the gate the bootstrap ack reports. Defaults to the injected copy. */
    permissionGate?: 'bundled' | 'user_configured';
    /**
     * What bootstrap reports it actually opened, given what was requested.
     *
     * A legacy (pre-v4) resume cannot open the requested file in place: the
     * native runtime converts it and opens the copy, so the ack names a
     * different file and declares the request as its source. Defaults to
     * "opened exactly what was asked for".
     */
    bootstrapFile?: (requested: string) => { sessionFile: string; sessionSourceFile?: string };
    /** P5-2-3: the preview surface. Default refuses, like a manager with no host. */
    showPreview?: (request: { path: string; focus: boolean }) => Promise<void>;
    /**
     * main-aux-06 — the per-line diagnostic sink. Production leaves it unset
     * (info level is off in the shipped log configuration), so a test is the
     * only place its content can be inspected at all.
     */
    log?: (...args: unknown[]) => void;
    /** dsh-rebase P1-3c — give every slot one shared fake DSH host (`FakeHost`). */
    host?: boolean;
    /** dsh-rebase P1-3d — the host's orphan collection (decision 024), when it has one. */
    collectSessions?: ReturnType<typeof vi.fn>;
    orphanCollectionDelayMs?: number;
    readDshStub?: (file: string) => Promise<unknown>;
  } = {}
) {
  const records: FakeSlotRecord[] = [];
  const events: Array<Record<string, unknown>> = [];
  const host: FakeHost | null = input.host ? createFakeHost() : null;

  function createFakeHost(): FakeHost {
    const fake: FakeHost = {
      state: 'ready',
      generation: 1,
      starts: 0,
      faults: [],
      busy: new Set(),
      ...(input.collectSessions ? { collectSessions: input.collectSessions } : {}),
      status: vi.fn(() => ({
        state: fake.state,
        generation: fake.generation,
        channels: 0,
        recentFaults: fake.faults.length,
        lastPong: {
          at: 0,
          eldMaxMs: 0,
          rssMb: 180,
          channels: [...fake.busy].map((ch) => ({ ch, busy: true })),
        },
        ...(fake.lastExit ? { lastExit: { ...fake.lastExit } } : {}),
        ...(fake.state === 'ready' && fake.planRevision ? { planRevision: fake.planRevision } : {}),
        ...(fake.state === 'ready' && fake.pluginSelection
          ? { pluginSelection: fake.pluginSelection }
          : {}),
        completions: fake.completions ?? 0,
      })),
      ensureHost: vi.fn(async (options: { userInitiated?: boolean } = {}) => {
        if (fake.state === 'disposed') {
          throw new DshHostSupervisorError('DSH_HOST_DISPOSED', 'the supervisor is disposed');
        }
        if (fake.state === 'ready') return { generation: fake.generation, pid: 4242 };
        if (!options.userInitiated) {
          if (fake.state === 'failed' && fake.failure) throw fake.failure;
          const cutoff = Date.now() - DSH_HOST_RESTART_BUDGET.windowMs;
          fake.faults = fake.faults.filter((at) => at > cutoff);
          if (fake.faults.length > DSH_HOST_RESTART_BUDGET.restarts) {
            fake.state = 'failed';
            fake.failure = new DshHostSupervisorError(
              'DSH_HOST_UNAVAILABLE',
              `the DSH host went down ${fake.faults.length} times within 5 min`
            );
            throw fake.failure;
          }
        }
        fake.generation += 1;
        fake.starts += 1;
        fake.state = 'ready';
        fake.failure = undefined;
        return { generation: fake.generation, pid: 4242 + fake.generation };
      }),
      restart: vi.fn(async (reason: string, options: { userInitiated?: boolean } = {}) => {
        // A graceful takedown: every live channel ends with the old host.
        if (fake.state === 'ready') hostCrash(reason);
        return fake.ensureHost(options);
      }),
      shutdown: vi.fn(async (reason: string) => {
        if (fake.state === 'ready') hostCrash(reason);
        fake.state = reason === 'app-quit' ? 'disposed' : 'idle';
      }),
      forceKillNow: vi.fn(() => {
        fake.state = 'disposed';
        return true;
      }),
    };
    return fake;
  }

  /** The host exits: every slot still running ends with `cause: 'host-exit'`, in one burst. */
  function hostCrash(reason = 'crashed'): void {
    if (!host) throw new Error('this harness has no host');
    host.lastExit = {
      generation: host.generation,
      reason,
      code: null,
      signal: 'SIGKILL',
      at: Date.now(),
    };
    if (BUDGETED_HOST_EXITS.has(reason)) host.faults.push(Date.now());
    if (host.state === 'ready') host.state = 'idle';
    for (const record of records.filter((candidate) => candidate.slot.state === 'running')) {
      record.crash('Worker exited (code=null signal=SIGKILL)', {
        code: null,
        signal: 'SIGKILL',
        cause: 'host-exit',
      });
    }
  }
  const bindRuntimeIdentity = vi.fn(
    input.bindRuntimeIdentity ?? (async (_sessionId: string, _sessionFile: string) => undefined)
  );
  const commitResumed = vi.fn(input.commitResumed ?? (async () => undefined));
  const commitPiLeaf = vi.fn(input.commitPiLeaf ?? (async () => undefined));
  const createForked = vi.fn(input.createForked ?? (async (entry) => entry));
  const sessionFileExists = vi.fn(input.sessionFileExists ?? (async () => true));
  const listIndexedSessions = vi.fn(input.listIndexedSessions ?? (async () => []));
  const readSessionDirectory = vi.fn(input.readSessionDirectory ?? (async () => []));
  const removeSessionFile = vi.fn(input.removeSessionFile ?? (async () => undefined));
  let createCount = 0;
  const createSlot = vi.fn(async (options: Record<string, unknown>) => {
    createCount += 1;
    if (input.createFailureAfter !== undefined && createCount > input.createFailureAfter) {
      throw new Error(`restart spawn ${createCount} failed`);
    }
    // What `createDshChatSlot` does first: open a channel, which brings the
    // shared host up, and only a user's spawn past a failed one (decision 020).
    if (host) await host.ensureHost({ userInitiated: options.userInitiated === true });
    const sessionId = String(options.logicalSessionId);
    const generation = Number(options.generation ?? 1);
    // Normalize the fallback so the mock's sessionFile always matches the
    // platform-canonical form WorkerManager stores in the slot.
    const sessionFile = String(options.sessionFile ?? norm(`/sessions/${sessionId}.jsonl`));
    const opened = input.bootstrapFile?.(sessionFile) ?? { sessionFile };
    const onEvent = options.onEvent as ((event: WorkerRpcEvent) => void) | undefined;
    const onLifecycle = options.onLifecycle as
      | ((event: WorkerSlotLifecycleEvent) => void)
      | undefined;
    const onStderr = options.onStderr as ((chunk: string, generation: number) => void) | undefined;
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
          // Use a platform-canonical path so WorkerManager's normalizeWorkerPath
          // produces the same key on both Windows and POSIX.
          sessionFile: norm('/sessions/forked.jsonl'),
          piSessionId: 'pi-forked',
          workspacePath: String(options.cwd),
          leaf: { activeEntryId: 'leaf-a', fileTailEntryId: 'leaf-a' },
          history: {
            logicalSessionId: sessionId,
            sessionFile: norm('/sessions/forked.jsonl'),
            workspacePath: String(options.cwd),
            page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
          },
        };
      }
      if (type === 'worker.commands') {
        return {
          commands: [{ name: `skill:from-${sessionId}`, source: 'skill' }],
          truncated: false,
        };
      }
      if (type === 'worker.compact') return { compacted: true };
      if (type === 'worker.dispose') return record.drain(payload);
      if (type === 'worker.fork.discard') return { discarded: true };
      if (type === 'worker.fork.accept') return { accepted: true };
      if (type === 'worker.stop') return { stopped: true };
      if (type === 'worker.preview.respond') return { handled: true };
      if (
        type === 'worker.setPermissionTier' ||
        type === 'worker.setPermissions' ||
        type === 'worker.setPermissionGear'
      )
        return { applied: true };
      throw new Error(`unexpected request ${type}`);
    });
    const slotState = { state: 'running' };
    const channelId = `c1-${records.length + 1}`;
    const record: FakeSlotRecord = {
      sessionId,
      sessionFile,
      generation,
      slotKey: String(options.slotKey),
      slot: slotState,
      channelId,
      request,
      drain: vi.fn(async () => {
        queueMicrotask(() => record.closeChannel());
        return { disposed: true };
      }),
      dispose: vi.fn(async () => {
        slotState.state = 'disposed';
      }),
      forceKillNow: vi.fn(() => {
        slotState.state = 'disposed';
        return true;
      }),
      emit(event) {
        onEvent?.({
          protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
          kind: 'event',
          generation,
          type: 'runtime.event',
          payload: event,
        });
      },
      stderr(chunk) {
        onStderr?.(chunk, generation);
      },
      crash(message = 'worker crashed', exit) {
        if (slotState.state === 'running') slotState.state = 'crashed';
        onLifecycle?.({
          type: 'crashed',
          slotKey: String(options.slotKey),
          generation,
          error: Object.assign(new Error(message), { code: 'WORKER_EXITED' }),
          ...(exit ? { exit } : {}),
        } as WorkerSlotLifecycleEvent);
      },
      closeChannel() {
        record.crash('Worker exited (code=0 signal=null)', {
          code: 0,
          signal: null,
          cause: 'channel-closed',
        });
      },
    };
    records.push(record);
    return {
      slot: Object.assign(slotState, {
        generation,
        channelId,
        pid: 4000 + records.length,
        pendingRequestCount: 0,
        remapSlotKey: vi.fn(),
        request,
        dispose: record.dispose,
        forceKillNow: record.forceKillNow,
      }),
      bootstrap: {
        bootstrapped: true,
        logicalSessionId: sessionId,
        piSessionId: `pi-${sessionId}`,
        cwd: String(options.cwd),
        agentDir: '/agent',
        sessionFile: opened.sessionFile,
        ...(opened.sessionSourceFile ? { sessionSourceFile: opened.sessionSourceFile } : {}),
        // T025: `leafCheckpoint` left the bootstrap payload, so a spawn cannot
        // dictate the leaf any more. The fake reports the empty leaf a fresh
        // native session reports; the real runtime resolves it from the file.
        leaf: { activeEntryId: null, fileTailEntryId: null } as {
          activeEntryId: string | null;
          fileTailEntryId: string | null;
        },
        ...(options.sessionFile
          ? {
              initialHistory: {
                logicalSessionId: sessionId,
                sessionFile: opened.sessionFile,
                workspacePath: String(options.cwd),
                page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
              },
            }
          : {}),
        projectTrusted: false,
        permissionGate: input.permissionGate ?? 'bundled',
        // T026: what the worker reported it brought up. Present for `s1` only,
        // so "this build reported nothing" stays distinguishable in the tests
        // below.
        ...(sessionId === 's1'
          ? {
              capabilities: { skills: 2 },
            }
          : {}),
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
    listIndexedSessions,
    readSessionDirectory,
    removeSessionFile,
    ...(input.showPreview ? { showPreview: input.showPreview } : {}),
    onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    ...(input.log ? { log: input.log } : {}),
    ...(host ? { host: host as unknown as WorkerManagerHost } : {}),
    ...(input.orphanCollectionDelayMs !== undefined
      ? { orphanCollectionDelayMs: input.orphanCollectionDelayMs }
      : {}),
    ...(input.readDshStub ? { readDshStub: input.readDshStub } : {}),
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
    host,
    hostCrash,
    createSlot,
    bindRuntimeIdentity,
    commitResumed,
    commitPiLeaf,
    createForked,
    sessionFileExists,
    listIndexedSessions,
    readSessionDirectory,
    removeSessionFile,
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
      runtimeIdentity: norm('/sessions/source.jsonl'),
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
      runtimeIdentity: norm('/sessions/forked.jsonl'),
      title: 'Source (fork)',
      agent: 'dsh',
    });
    expect(h.records).toHaveLength(2);
    expect(h.manager.getSlotSnapshots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logicalSessionId: 'source',
          sessionFile: norm('/sessions/source.jsonl'),
        }),
        expect.objectContaining({
          logicalSessionId: forked.session.sessionId,
          sessionFile: norm('/sessions/forked.jsonl'),
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
      sessionFile: norm('/sessions/forked.jsonl'),
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
    // D12 (U24) raised the ceiling to 10: past capacity a new session does not
    // queue — it fails with `worker_capacity_reached` — so the old ceiling made
    // "about ten conversations at once" impossible rather than slow.
    // [WMH-10] dsh-rebase decision 019: on the shared DSH host a session is a
    // channel of one process, so only <=4 GiB hosts keep a lower number, 6.
    expect(resolveDefaultWorkerCapacity(3 * 1024 ** 3)).toBe(6);
    expect(resolveDefaultWorkerCapacity(4 * 1024 ** 3)).toBe(6);
    expect(resolveDefaultWorkerCapacity(4 * 1024 ** 3 + 1)).toBe(10);
    expect(resolveDefaultWorkerCapacity(6 * 1024 ** 3)).toBe(10);
    expect(resolveDefaultWorkerCapacity(16 * 1024 ** 3)).toBe(10);
    expect(resolveWorkerCapacity({ AICLIENT_PI_WORKER_CAPACITY: '1' }, 16 * 1024 ** 3)).toBe(1);
    expect(resolveWorkerCapacity({ AICLIENT_PI_WORKER_CAPACITY: '10' }, 4 * 1024 ** 3)).toBe(10);
    expect(() =>
      resolveWorkerCapacity({ AICLIENT_PI_WORKER_CAPACITY: '11' }, 16 * 1024 ** 3)
    ).toThrow(/integer from 1 to 10/);
  });

  it('reserves unique temporary keys then atomically remaps and persists identity', async () => {
    const h = createHarness();
    await Promise.all([create(h.manager, 's1'), create(h.manager, 's2')]);

    expect(h.records.map((record) => record.slotKey)).toEqual([
      expect.stringMatching(/^workspace:.*session:s1:create:token-1$/),
      expect.stringMatching(/^workspace:.*session:s2:create:token-2$/),
    ]);
    expect(h.manager.getSlotSnapshots().map((slot) => slot.key)).toEqual([
      slotKey('/sessions/s1.jsonl'),
      slotKey('/sessions/s2.jsonl'),
    ]);
    expect(h.bindRuntimeIdentity.mock.calls).toEqual([
      ['s1', norm('/sessions/s1.jsonl')],
      ['s2', norm('/sessions/s2.jsonl')],
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
        payload: {
          agent: 'dsh',
          runtimeIdentity: norm('/sessions/s1.jsonl'),
          // D10: which permission system the worker actually bootstrapped on,
          // read off the bootstrap ack. The tier control needs it to stop
          // offering tiers the runtime will ignore.
          permissionGate: 'bundled',
        },
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
      key: slotKey('/sessions/s1.jsonl'),
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

  it('D12: announces a capacity eviction so the renderer can drop its stale binding', async () => {
    let clock = 10;
    const h = createHarness({ capacity: 2, now: () => clock });
    await create(h.manager, 's1', 1);
    clock = 20;
    await create(h.manager, 's2', 2);
    h.manager.releaseSession('s1');
    h.events.length = 0;
    clock = 30;
    await create(h.manager, 's3', 3);

    // Without this the renderer keeps `s1` in `hostBoundSessionIds`, so its
    // next send skips `createSession` and addresses a worker that is gone.
    const evicted = h.events.find(
      (event) =>
        event.type === 'session.status' &&
        (event.payload as { disconnectReason?: string }).disconnectReason === 'capacity_reclaimed'
    );
    expect(evicted).toMatchObject({
      sessionId: 's1',
      payload: { status: 'disconnected', disconnectReason: 'capacity_reclaimed' },
    });
  });

  it('D12: the idle sweep never claims a full pool; it says `released` (decision 145)', async () => {
    // Announcing a 15-minute timeout as `capacity_reclaimed` would tell the user
    // the pool is full when it is not. D12 left the idle sweep's wording alone;
    // P1-7e e6 (problem 37) has it say `released`, so the renderer drops the
    // binding of a session that is no longer on the engine, without a toast.
    let clock = 0;
    const base = createHarness({ capacity: 3, now: () => clock });
    const events: Array<Record<string, unknown>> = [];
    const manager = new WorkerManager({
      createSlot: base.createSlot as never,
      bindRuntimeIdentity: async () => undefined,
      capacity: 3,
      idleTimeoutMs: 100,
      idleSweepIntervalMs: 0,
      now: () => clock,
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    await create(manager, 'idle');
    clock = 150;
    await manager.reclaimIdle();

    expect(
      events.some(
        (event) =>
          (event.payload as { disconnectReason?: string } | undefined)?.disconnectReason ===
          'capacity_reclaimed'
      )
    ).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'session.status',
        sessionId: 'idle',
        payload: { status: 'disconnected', disconnectReason: 'released' },
      })
    );
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

  it('protects active turns from eviction', async () => {
    const h = createHarness({ capacity: 2 });
    await create(h.manager, 'active');
    await create(h.manager, 'second');
    await h.manager.send({ sessionId: 'active', attemptId: 'attempt-active', text: 'hello' });
    await h.manager.send({ sessionId: 'second', attemptId: 'attempt-second', text: 'hello' });

    await expect(create(h.manager, 'third')).rejects.toMatchObject({
      code: 'worker_capacity_reached',
    });
    expect(h.records[0].dispose).not.toHaveBeenCalled();
    expect(h.records[1].dispose).not.toHaveBeenCalled();
  });
});

/**
 * D10. The tiers are an `authorizerChain` link in the config.json shipped beside
 * our bundled plugin copy, and on the `user_configured` path that copy is never
 * injected — so the link is registered and never consulted. The renderer cannot
 * see any of that; this payload is the only way it learns the picker is
 * disconnected, which is why the value must travel on BOTH lifecycle events and
 * must not be defaulted when nothing reported it.
 */
/**
 * rpc-projector-17 — the worker's stderr as a session event.
 *
 * Everything downstream of this has existed since T-35 and had nothing to
 * consume: the Context panel's "Host stderr" group, the runtime-facts ring, and
 * the liveness classifier that reads a stderr line as proof the subprocess is
 * alive. Until this producer landed, a worker that printed its reason for
 * failing put it in a log file the user never opens.
 */
describe('WorkerManager worker stderr forwarding', () => {
  it('forwards whole redacted lines and holds an unfinished one back', async () => {
    const h = createHarness();
    await create(h.manager, 's1');
    h.events.length = 0;

    // Two lines and the start of a third, split mid-line the way a pipe does.
    h.records[0].stderr('boot ok\nfailed with sk-ant-abc123secret\npartial');
    expect(h.events.map((event) => event.payload)).toEqual([
      { line: 'boot ok' },
      // The credential is destroyed BEFORE the event crosses IPC; the bridge
      // downstream is content-agnostic and gets no second chance.
      { line: 'failed with [redacted]' },
    ]);
    expect(h.events.every((event) => event.sessionId === 's1')).toBe(true);
    expect(h.events.every((event) => event.type === 'session.stderr')).toBe(true);

    h.events.length = 0;
    h.records[0].stderr(' line\n');
    expect(h.events.map((event) => event.payload)).toEqual([{ line: 'partial line' }]);
  });

  it('redacts on the way in, so the log sink and the crash replay are covered too (main-aux-06)', async () => {
    // Redaction used to live inside `forwardStderr`, i.e. on the IPC exit
    // only. The same assembled line also goes to the `log` sink and into the
    // replay buffer that `dumpWorkerStderr` prints with `console.error` — and
    // console.error is the one exit that reaches main.log in the shipped
    // configuration, because electron-log keeps `error` level even with file
    // logging off. The UI showed a masked line while the log kept the key.
    const logged: string[] = [];
    const h = createHarness({ log: (...args) => logged.push(args.join(' ')) });
    await create(h.manager, 's1');
    h.events.length = 0;
    const secret = `sk-ant-api03-${'x'.repeat(40)}`;
    const envDump = `ANTHROPIC_AUTH_TOKEN=plain-${'x'.repeat(40)}`;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // Two whole lines plus an unterminated third: the tail is flushed by the
      // crash dump and is its own exit.
      h.records[0].stderr(`spawn failed: ${secret}\n${envDump}\nstill holding ${secret}`);

      const sink = logged.join('\n');
      expect(sink).toContain('[redacted]');
      expect(sink).not.toContain(secret);
      expect(sink).not.toContain('plain-xxxx');
      expect(JSON.stringify(h.events)).not.toContain(secret);

      h.records[0].crash('boom');
      const dumped = consoleError.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(dumped).toContain('last 3 stderr line(s)');
      expect(dumped).toContain('[redacted]');
      expect(dumped).not.toContain(secret);
      expect(dumped).not.toContain('sk-ant-api03');
      expect(dumped).not.toContain('plain-xxxx');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('caps a chatty turn and says that it did', async () => {
    const h = createHarness();
    await create(h.manager, 's1');
    h.events.length = 0;

    const lines = STDERR_FORWARD_MAX_LINES_PER_TURN + 5;
    h.records[0].stderr(`${Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n')}\n`);
    // The cap, plus one line that says the rest is in the log — a silent
    // cutoff would leave the panel showing a stale excerpt as if it were live.
    expect(h.events).toHaveLength(STDERR_FORWARD_MAX_LINES_PER_TURN + 1);
    expect(h.events.at(-1)?.payload).toMatchObject({
      line: expect.stringContaining('worker log only'),
    });
  });
});

describe('WorkerManager permission gate reporting (D10)', () => {
  it('reports the degraded gate on session.created', async () => {
    const h = createHarness({ permissionGate: 'user_configured' });
    await create(h.manager, 's1');
    const created = h.events.find((event) => event.type === 'session.created');
    expect(created?.payload).toMatchObject({ permissionGate: 'user_configured' });
  });

  it('reports it again on resume, since that is how a restored session learns', async () => {
    const h = createHarness({ permissionGate: 'user_configured' });
    await h.manager.resumeSession({
      sessionId: 's1',
      sessionFile: '/sessions/s1.jsonl',
      workspacePath: '/repo',
      ownerWebContentsId: 11,
    });
    const resumed = h.events.find((event) => event.type === 'session.resumed');
    expect(resumed?.payload).toMatchObject({ permissionGate: 'user_configured' });
  });

  it('omits the field entirely when no bootstrap has been acknowledged', () => {
    // "Unknown" must stay distinguishable from "bundled": a UI that reads an
    // absent field as bundled would go on promising four working tiers.
    const h = createHarness();
    const entry = { bootstrap: null } as never;
    expect(
      (h.manager as unknown as { gatePayload: (e: never) => object }).gatePayload(entry)
    ).toEqual({});
  });
});

/**
 * cutover-03 — the sidebar panel's data, after `getSessionExtensions` went.
 *
 * That method answered from `bootstrap.extensions`, a field no backend has
 * written since P6-5, and folded a missing value into `[]` — so the sidebar
 * reported a definite "0 plugins" for every session while the MCP servers and
 * skills the session really had went unmentioned. The replacement reports the
 * session's own capabilities and keeps "nobody reported" as `null`.
 */
describe('WorkerManager session capabilities', () => {
  it('answers from the cached bootstrap without touching the worker', async () => {
    const h = createHarness();
    await create(h.manager, 's1');
    expect(h.manager.getSessionCapabilities('s1')).toEqual({ skills: 2 });
    // No RPC: the inventory cannot change without a new bootstrap, so a UI
    // panel must never queue behind a running turn to read it.
    expect(h.records[0].request).not.toHaveBeenCalled();
  });

  it('reports null both for no slot and for a build that reported nothing', async () => {
    const h = createHarness();
    // Both are "nobody has told us", which the sidebar renders in words. The
    // one thing it must never do is turn either into a zero.
    expect(h.manager.getSessionCapabilities('never-started')).toBeNull();
    await create(h.manager, 's2');
    expect(h.manager.getSessionCapabilities('s2')).toBeNull();
  });
});

describe('WorkerManager Pi history and real resume', () => {
  it('adopts the converted copy a legacy resume opens and moves the durable identity onto it', async () => {
    // Every session whose indexed identity still names a pre-v4 file used to be
    // unopenable on the native backend: the runtime converts it, opens
    // `<file>.native-v4.jsonl`, and the identity check saw a file it had not
    // asked for. The redirect is legitimate exactly when the worker declares
    // the requested file as the copy's source.
    const h = createHarness({
      bootstrapFile: (requested) => ({
        sessionFile: `${requested}.native-v4.jsonl`,
        sessionSourceFile: requested,
      }),
    });

    await h.manager.resumeSession({
      sessionId: 's1',
      sessionFile: '/sessions/legacy-v3.jsonl',
      workspacePath: '/repo',
      ownerWebContentsId: 11,
    });

    expect(h.bindRuntimeIdentity).toHaveBeenCalledWith(
      's1',
      norm('/sessions/legacy-v3.jsonl.native-v4.jsonl')
    );
    // The index row now names the copy, so the commit that follows must too —
    // commitResumed rejects an identity that disagrees with the stored one.
    expect(h.commitResumed).toHaveBeenCalledWith({
      sessionId: 's1',
      workspacePath: norm('/repo'),
      runtimeIdentity: norm('/sessions/legacy-v3.jsonl.native-v4.jsonl'),
      agent: 'dsh',
      piLeaf: { activeEntryId: null, fileTailEntryId: null },
    });
    expect(h.manager.getSlotSnapshots()).toEqual([
      expect.objectContaining({
        logicalSessionId: 's1',
        sessionFile: norm('/sessions/legacy-v3.jsonl.native-v4.jsonl'),
      }),
    ]);
  });

  it('still rejects a different file when the worker declares no source for it', async () => {
    const h = createHarness({
      bootstrapFile: (requested) => ({ sessionFile: `${requested}.other.jsonl` }),
    });

    await expect(
      h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: '/sessions/s1.jsonl',
        workspacePath: '/repo',
        ownerWebContentsId: 11,
      })
    ).rejects.toThrow('did not open the requested exact session file');
    expect(h.bindRuntimeIdentity).not.toHaveBeenCalled();
    expect(h.commitResumed).not.toHaveBeenCalled();
  });

  it('rejects a converted copy whose declared source is not what was requested', async () => {
    const h = createHarness({
      bootstrapFile: () => ({
        sessionFile: '/sessions/someone-else.jsonl.native-v4.jsonl',
        sessionSourceFile: '/sessions/someone-else.jsonl',
      }),
    });

    await expect(
      h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: '/sessions/s1.jsonl',
        workspacePath: '/repo',
        ownerWebContentsId: 11,
      })
    ).rejects.toThrow('did not open the requested exact session file');
    expect(h.bindRuntimeIdentity).not.toHaveBeenCalled();
  });

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
        sessionFile: norm('/sessions/s1.jsonl'),
        cwd: norm('/repo'),
      })
    );
    expect(h.commitResumed).toHaveBeenCalledWith({
      sessionId: 's1',
      workspacePath: norm('/repo'),
      runtimeIdentity: norm('/sessions/s1.jsonl'),
      agent: 'dsh',
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
        runtimeIdentity: norm('/sessions/s1.jsonl'),
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
        payload: { agent: 'dsh', permissionGate: 'bundled' },
      })
    );
    // The slot itself is fully usable — only the durable claim is withheld.
    expect(h.manager.getSlotSnapshots()[0]).toMatchObject({
      state: 'ready',
      sessionFile: norm('/sessions/s1.jsonl'),
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
      expect(h.bindRuntimeIdentity).toHaveBeenCalledWith('s1', norm('/sessions/s1.jsonl'))
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'session.updated',
        sessionId: 's1',
        payload: { runtimeIdentity: norm('/sessions/s1.jsonl') },
      })
    );
    // The leaf commit is what the index rejects for an unbound session, so it
    // has to land after the identity, not instead of it.
    await vi.waitFor(() =>
      expect(h.commitPiLeaf).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1', runtimeIdentity: norm('/sessions/s1.jsonl') })
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
      expect(h.bindRuntimeIdentity).toHaveBeenCalledWith('s1', norm('/sessions/s1.jsonl'))
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'session.updated',
        sessionId: 's1',
        payload: { runtimeIdentity: norm('/sessions/s1.jsonl') },
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
        sessionFile: norm('/sessions/s1-second.jsonl'),
        key: slotKey('/sessions/s1-second.jsonl'),
        generation: 2,
      })
    );
    // Restarted as a new session rather than reopening a file that never was.
    expect(h.createSlot.mock.calls[1][0]).not.toHaveProperty('sessionFile');
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

  /**
   * session-index-02 — the spawn knew the fork was unbound, the index row did
   * not. Without the marker the renderer finds no workspace for the scratch
   * path and reports "could not be materialized" on a fork that landed, and the
   * next start drops the row as an orphan.
   */
  it('[release-blocker] records a fork of an unbound session as unbound in the index', async () => {
    const h = createHarness();
    await h.manager.createSession({
      sessionId: 's1',
      workspacePath: '/tmp/base/unbound-sessions/abc',
      unbound: true,
    });
    await h.manager.forkSession({ sourceSessionId: 's1', entryId: 'e1', sourceTitle: 'Chat' });
    expect(h.createForked).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: norm('/tmp/base/unbound-sessions/abc'),
        unbound: true,
      })
    );
  });

  it('leaves the fork of a bound session unmarked', async () => {
    // Absent rather than `unbound: false`, like every other writer of this row:
    // the index file is plain JSON and a false key would still read as "scratch"
    // to anything that only checks for presence.
    const h = createHarness();
    await create(h.manager, 's1');
    await h.manager.forkSession({ sourceSessionId: 's1', entryId: 'e1', sourceTitle: 'Chat' });
    expect(h.createForked.mock.calls[0][0]).not.toHaveProperty('unbound');
  });

  /**
   * session-index-04 — the fork state machine only had its discard half wired.
   * The source worker kept every fork it ever made in its "uncommitted
   * artifact" table, so a second discard caller would have been allowed to
   * delete a session the user is already using.
   */
  it('tells the source worker the fork was adopted once the index row lands', async () => {
    const h = createHarness();
    await create(h.manager, 'source');
    await h.manager.forkSession({
      sourceSessionId: 'source',
      entryId: 'leaf-a',
      sourceTitle: 'Source',
    });
    expect(h.records[0].request).toHaveBeenCalledWith('worker.fork.accept', {
      logicalSessionId: 'source',
      sessionFile: norm('/sessions/forked.jsonl'),
    });
  });

  it('does not claim adoption when the index write failed', async () => {
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
    expect(h.records[0].request).not.toHaveBeenCalledWith(
      'worker.fork.accept',
      expect.anything() as never
    );
  });

  it('keeps the fork when the source worker cannot confirm adoption', async () => {
    // Best effort by design: the row is already committed, so failing the call
    // here would discard a session that exists.
    const h = createHarness();
    await create(h.manager, 'source');
    const answer = h.records[0].request.getMockImplementation();
    h.records[0].request.mockImplementation(async (type: string, payload: unknown) => {
      if (type === 'worker.fork.accept') throw new Error('source worker gone');
      return answer?.(type, payload);
    });
    await expect(
      h.manager.forkSession({
        sourceSessionId: 'source',
        entryId: 'leaf-a',
        sourceTitle: 'Source',
      })
    ).resolves.toMatchObject({ session: { runtimeIdentity: norm('/sessions/forked.jsonl') } });
  });

  /**
   * session-index-09 — a fork's transcript is on disk before its index row is,
   * so a crash (or a kill, or a failed cleanup) inside that window used to
   * leave a full copy of the user's conversation in the session directory with
   * nothing pointing at it and no way to delete it from the app.
   *
   * The sweep only ever looks at directories the index itself names, and only
   * deletes a transcript that BOTH carries a staging marker and is claimed by
   * no row — so a session that merely never got its "adopted" acknowledgement
   * keeps its file and loses only the marker.
   */
  describe('startup sweep for staged fork files', () => {
    function indexRow(sessionId: string, runtimeIdentity: string): SessionIndexEntry {
      return {
        sessionId,
        agent: 'pi',
        workspacePath: '/repo',
        title: sessionId,
        updatedAt: 1,
        archived: false,
        runtimeIdentity,
      };
    }

    it('deletes a staged transcript no index row claims, marker included', async () => {
      const h = createHarness({
        listIndexedSessions: async () => [indexRow('source', '/sessions/source.jsonl')],
        readSessionDirectory: async () => [
          'source.jsonl',
          'abandoned.jsonl',
          'abandoned.jsonl.staged',
        ],
      });

      await h.manager.ensureReady();

      expect(h.readSessionDirectory).toHaveBeenCalledWith(norm('/sessions'));
      expect(h.removeSessionFile.mock.calls.map((call) => call[0])).toEqual([
        norm('/sessions/abandoned.jsonl'),
        norm('/sessions/abandoned.jsonl.staged'),
      ]);
    });

    it('keeps a transcript the index claims and clears only its stale marker', async () => {
      const h = createHarness({
        listIndexedSessions: async () => [
          indexRow('source', '/sessions/source.jsonl'),
          indexRow('forked', '/sessions/forked.jsonl'),
        ],
        readSessionDirectory: async () => ['source.jsonl', 'forked.jsonl', 'forked.jsonl.staged'],
      });

      await h.manager.ensureReady();

      expect(h.removeSessionFile.mock.calls.map((call) => call[0])).toEqual([
        norm('/sessions/forked.jsonl.staged'),
      ]);
    });

    it('leaves the marker in place when the transcript cannot be removed', async () => {
      // The marker is the only durable record that this file is unclaimed:
      // dropping it while the transcript survives would make the leak permanent.
      const h = createHarness({
        listIndexedSessions: async () => [indexRow('source', '/sessions/source.jsonl')],
        readSessionDirectory: async () => ['abandoned.jsonl', 'abandoned.jsonl.staged'],
        removeSessionFile: async (file: string) => {
          if (file.endsWith('.jsonl')) throw new Error('EBUSY');
        },
      });

      await h.manager.ensureReady();

      expect(h.removeSessionFile.mock.calls.map((call) => call[0])).toEqual([
        norm('/sessions/abandoned.jsonl'),
      ]);
    });

    it('sweeps once per run and never scans a directory the index does not name', async () => {
      const h = createHarness({
        listIndexedSessions: async () => [],
        readSessionDirectory: async () => ['abandoned.jsonl.staged'],
      });

      await h.manager.ensureReady();
      await h.manager.ensureReady();

      expect(h.readSessionDirectory).not.toHaveBeenCalled();
      expect(h.listIndexedSessions).toHaveBeenCalledTimes(1);
      expect(h.removeSessionFile).not.toHaveBeenCalled();
    });
  });

  // U12 fix — the composer chip and the runtime used to be able to disagree,
  // always in the permissive direction. Both drifts are Main's to close,
  // because Main is the only side that outlives a worker.
  describe('D14 permissions survive worker lifecycle', () => {
    it('carries both axes on create, updates them through RPC and restores them after crash', async () => {
      const h = createHarness({ sessionFileExists: async () => false });
      await h.manager.createSession({
        sessionId: 's1',
        workspacePath: '/repo',
        permissions: { mode: 'plan', gear: 'ask' },
      });
      expect(h.createSlot.mock.calls[0][0]).toMatchObject({
        permissions: { mode: 'plan', gear: 'ask' },
      });
      await h.manager.setPermissions('s1', { mode: 'agent', gear: 'accept-edits' });
      expect(h.records[0].request).toHaveBeenCalledWith('worker.setPermissions', {
        logicalSessionId: 's1',
        permissions: { mode: 'agent', gear: 'accept-edits' },
      });
      h.records[0].crash('killed');
      await vi.waitFor(() => expect(h.createSlot).toHaveBeenCalledTimes(2));
      expect(h.createSlot.mock.calls[1][0]).toMatchObject({
        permissions: { mode: 'agent', gear: 'accept-edits' },
      });
    });
    it('synchronizes a changed stored preference when create reuses a live worker', async () => {
      const h = createHarness();
      await create(h.manager, 's1');
      await h.manager.createSession({
        sessionId: 's1',
        workspacePath: '/repo',
        permissions: { mode: 'plan', gear: 'ask' },
      });
      expect(h.createSlot).toHaveBeenCalledTimes(1);
      expect(h.records[0].request).toHaveBeenCalledWith('worker.setPermissions', {
        logicalSessionId: 's1',
        permissions: { mode: 'plan', gear: 'ask' },
      });
    });
    it('carries plan plus auto through resume without collapsing it into a tier', async () => {
      const h = createHarness();
      await h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: '/sessions/s1.jsonl',
        workspacePath: '/repo',
        permissions: { mode: 'plan', gear: 'auto' },
      });
      expect(h.createSlot.mock.calls[0][0]).toMatchObject({
        permissions: { mode: 'plan', gear: 'auto' },
      });
    });
    it('moves the gear during a live turn but still refuses a mode change', async () => {
      // What the composer needs while an approval card is up: the gear is the
      // setting that stops the asking, so locking it until the turn ends meant
      // the only way to stop being asked was to answer everything first. The
      // mode stays locked — it decides which tools the turn was handed.
      const h = createHarness({ sessionFileExists: async () => false });
      await h.manager.createSession({
        sessionId: 's1',
        workspacePath: '/repo',
        permissions: { mode: 'agent', gear: 'ask' },
      });
      await h.manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go' });

      await h.manager.setPermissions('s1', { mode: 'agent', gear: 'auto' });
      // The narrow RPC, which carries no mode at all — see its payload doc.
      expect(h.records[0].request).toHaveBeenCalledWith('worker.setPermissionGear', {
        logicalSessionId: 's1',
        gear: 'auto',
      });
      expect(h.records[0].request).not.toHaveBeenCalledWith(
        'worker.setPermissions',
        expect.anything()
      );

      await expect(
        h.manager.setPermissions('s1', { mode: 'plan', gear: 'auto' })
      ).rejects.toMatchObject({ code: 'session_busy' });

      // The gear that did land is Main's record now, so a crash restart brings
      // the worker back on it rather than on what the session started with.
      h.records[0].crash('killed');
      await vi.waitFor(() => expect(h.createSlot).toHaveBeenCalledTimes(2));
      expect(h.createSlot.mock.calls[1][0]).toMatchObject({
        permissions: { mode: 'agent', gear: 'auto' },
      });
    });
    it('does not replace the saved setting when the worker rejects a change', async () => {
      const h = createHarness({ sessionFileExists: async () => false });
      await h.manager.createSession({
        sessionId: 's1',
        workspacePath: '/repo',
        permissions: { mode: 'plan', gear: 'ask' },
      });
      h.records[0].request.mockRejectedValueOnce(new Error('not applied'));
      await expect(h.manager.setPermissions('s1', { mode: 'agent', gear: 'auto' })).rejects.toThrow(
        'not applied'
      );
      h.records[0].crash('killed');
      await vi.waitFor(() => expect(h.createSlot).toHaveBeenCalledTimes(2));
      expect(h.createSlot.mock.calls[1][0]).toMatchObject({
        permissions: { mode: 'plan', gear: 'ask' },
      });
    });
  });

  /**
   * dsh-rebase decision 169: a plan review's approval switches the posture
   * inside the worker, mid-turn. Main takes that change only for an approval
   * it forwarded itself, with the posture it derives from that answer, and
   * hands it back to a renderer that reopens the chat with an older one.
   */
  describe('plan review posture (decision 169)', () => {
    const REVIEW = {
      kind: 'plan',
      source: 'exit_plan_mode',
      title: 'Plan',
      plan: '# Plan',
      goalObjective: '# Plan',
    };

    async function reviewing() {
      const h = createHarness({ sessionFileExists: async () => false });
      await h.manager.createSession({
        sessionId: 's1',
        workspacePath: '/repo',
        permissions: { mode: 'plan', gear: 'auto' },
      });
      await h.manager.send({ sessionId: 's1', attemptId: 'a1', text: 'plan it' });
      const record = h.records[0];
      record.emit({
        type: 'question.requested',
        sessionId: 's1',
        payload: { questionId: 'q1', questions: [], review: REVIEW },
      });
      /** The worker's answer to `worker.question.respond`: it reports `claimed` first. */
      const answerWith = (claimed: Record<string, unknown> | null) => {
        record.request.mockImplementation(async (type: string) => {
          if (type === 'worker.question.respond') {
            if (claimed) {
              record.emit({
                type: 'session.permissions',
                sessionId: 's1',
                payload: { cause: 'plan-approved', questionId: 'q1', ...claimed },
              });
            }
            record.emit({
              type: 'question.resolved',
              sessionId: 's1',
              payload: { questionId: 'q1', outcome: 'answered' },
            });
            return { handled: true };
          }
          if (type === 'worker.setPermissionGear' || type === 'worker.setPermissions')
            return { applied: true };
          return {};
        });
      };
      const postures = () => h.events.filter((event) => event.type === 'session.permissions');
      return { h, record, answerWith, postures };
    }

    it('takes the posture an approval it forwarded names, then lets the gear move mid-turn', async () => {
      const { h, record, answerWith, postures } = await reviewing();
      answerWith({ permissions: { mode: 'agent', gear: 'auto' }, goal: { set: true } });
      await expect(
        h.manager.respondQuestion({
          sessionId: 's1',
          questionId: 'q1',
          answers: { 'plan-review': 'goal:auto' },
        })
      ).resolves.toBe(true);
      expect(postures()).toEqual([
        expect.objectContaining({
          sessionId: 's1',
          payload: {
            cause: 'plan-approved',
            questionId: 'q1',
            permissions: { mode: 'agent', gear: 'auto' },
            goal: { set: true },
          },
        }),
      ]);
      // Main's record moved: a gear change mid-turn is no longer a mode change.
      await h.manager.setPermissions('s1', { mode: 'agent', gear: 'bypass' });
      expect(record.request).toHaveBeenCalledWith('worker.setPermissionGear', {
        logicalSessionId: 's1',
        gear: 'bypass',
      });
      record.crash('killed');
      await vi.waitFor(() => expect(h.createSlot).toHaveBeenCalledTimes(2));
      expect(h.createSlot.mock.calls[1][0]).toMatchObject({
        permissions: { mode: 'agent', gear: 'bypass' },
      });
    });

    it('drops a posture no forwarded approval names: unasked, another gear, or a review not approved', async () => {
      for (const [answer, claimed] of [
        [
          { answers: { 'plan-review': 'goal:auto' } },
          { permissions: { mode: 'agent', gear: 'bypass' } },
        ],
        [
          { answers: { 'plan-review': 'keep-planning' }, response: 'more' },
          { permissions: { mode: 'agent', gear: 'auto' } },
        ],
        [{ cancel: true }, { permissions: { mode: 'agent', gear: 'auto' } }],
        [
          { answers: { 'plan-review': 'goal:auto' } },
          { permissions: { mode: 'agent', gear: 'auto' }, questionId: 'q9' },
        ],
      ] as const) {
        const { h, record, answerWith, postures } = await reviewing();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        answerWith(claimed);
        await h.manager.respondQuestion({ sessionId: 's1', questionId: 'q1', ...answer });
        expect(postures()).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('posture change refused'));
        warn.mockRestore();
        // Still plan mode in Main's eyes: a mode change mid-turn is refused.
        await expect(
          h.manager.setPermissions('s1', { mode: 'agent', gear: 'auto' })
        ).rejects.toMatchObject({ code: 'session_busy' });
        record.crash('killed');
        await vi.waitFor(() => expect(h.createSlot).toHaveBeenCalledTimes(2));
        expect(h.createSlot.mock.calls[1][0]).toMatchObject({
          permissions: { mode: 'plan', gear: 'auto' },
        });
      }
    });

    it('a posture the worker sends unasked, with no review up, is dropped', async () => {
      const h = createHarness({ sessionFileExists: async () => false });
      await h.manager.createSession({
        sessionId: 's1',
        workspacePath: '/repo',
        permissions: { mode: 'plan', gear: 'auto' },
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      h.records[0].emit({
        type: 'session.permissions',
        sessionId: 's1',
        payload: { cause: 'plan-approved', permissions: { mode: 'agent', gear: 'bypass' } },
      });
      warn.mockRestore();
      expect(h.events.filter((event) => event.type === 'session.permissions')).toEqual([]);
    });

    it('hands the approved posture back to a renderer that reopens the chat with an older one', async () => {
      const { h, record, answerWith, postures } = await reviewing();
      answerWith({ permissions: { mode: 'agent', gear: 'auto' } });
      await h.manager.respondQuestion({
        sessionId: 's1',
        questionId: 'q1',
        answers: { 'plan-review': 'run:auto' },
      });
      record.emit({ type: 'session.completed', sessionId: 's1', payload: {} });
      record.request.mockClear();
      // The window reloaded before it stored the approval: it still says plan mode.
      await h.manager.createSession({
        sessionId: 's1',
        workspacePath: '/repo',
        permissions: { mode: 'plan', gear: 'auto' },
      });
      expect(record.request).not.toHaveBeenCalledWith('worker.setPermissions', expect.anything());
      expect(postures().at(-1)).toMatchObject({
        payload: { cause: 'sync', permissions: { mode: 'agent', gear: 'auto' } },
      });
      // Once the renderer picks a posture itself, its stored one is applied again.
      await h.manager.setPermissions('s1', { mode: 'agent', gear: 'auto' });
      await h.manager.createSession({
        sessionId: 's1',
        workspacePath: '/repo',
        permissions: { mode: 'plan', gear: 'auto' },
      });
      expect(record.request).toHaveBeenCalledWith('worker.setPermissions', {
        logicalSessionId: 's1',
        permissions: { mode: 'plan', gear: 'auto' },
      });
    });
  });

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

  /**
   * concurrency-02 — the forced writer-lock takeover, and the one rule that
   * makes it safe: it belongs to a single spawn, never to the session.
   */
  describe('forced writer-lock takeover', () => {
    it('[WM-force-01] carries the takeover into the spawn the user asked for', async () => {
      const h = createHarness();
      await h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: '/sessions/s1.jsonl',
        workspacePath: '/repo',
        forceTakeover: true,
      });
      expect(h.createSlot.mock.calls[0][0]).toMatchObject({ forceTakeover: true });
    });

    it('[WM-force-02] never lets a respawn inherit it', async () => {
      // The reverse assertion, and the reason `ManagedSlot` has no field for
      // this. A takeover is one authorisation about one lock at one moment: a
      // worker that crashes half an hour later and comes back forcing would
      // strip whoever legitimately holds the file by then, with nobody having
      // asked for it.
      const h = createHarness();
      await h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: '/sessions/s1.jsonl',
        workspacePath: '/repo',
        forceTakeover: true,
      });
      expect(h.createSlot.mock.calls[0][0]).toMatchObject({ forceTakeover: true });

      h.records[0].crash('killed');
      await vi.waitFor(() => expect(h.createSlot).toHaveBeenCalledTimes(2));
      expect(h.createSlot.mock.calls[1][0]).not.toHaveProperty('forceTakeover');
    });

    it('[WM-force-03] omits it for an ordinary resume', async () => {
      const h = createHarness();
      await h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: '/sessions/s1.jsonl',
        workspacePath: '/repo',
      });
      expect(h.createSlot.mock.calls[0][0]).not.toHaveProperty('forceTakeover');
    });

    it('[WM-force-04] refuses to answer a forced resume with a plain one already in flight', async () => {
      // The takeover is part of the de-duplication fingerprint. Without it the
      // second call would be handed the first call's promise, and the user
      // would press "Force takeover" to watch the same refusal come back.
      const h = createHarness();
      const plain = h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: '/sessions/s1.jsonl',
        workspacePath: '/repo',
      });
      await expect(
        h.manager.resumeSession({
          sessionId: 's1',
          sessionFile: '/sessions/s1.jsonl',
          workspacePath: '/repo',
          forceTakeover: true,
        })
      ).rejects.toThrow('already has a different resume in flight');
      await plain;
    });
  });

  it('still reopens the exact file when a written session goes missing', async () => {
    const present = new Set([norm('/sessions/s1.jsonl')]);
    const h = createHarness({ sessionFileExists: async (file) => present.has(file) });
    await create(h.manager, 's1');
    expect(h.bindRuntimeIdentity).toHaveBeenCalledWith('s1', norm('/sessions/s1.jsonl'));

    // History that once existed and is now gone is real loss: the restart must
    // surface it, never paper over it with an empty replacement session.
    present.clear();
    h.records[0].crash('boom');

    await vi.waitFor(() => expect(h.createSlot).toHaveBeenCalledTimes(2));
    expect(h.createSlot.mock.calls[1][0]).toMatchObject({
      logicalSessionId: 's1',
      sessionFile: norm('/sessions/s1.jsonl'),
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

  /**
   * dsh-rebase decision 156 (decision 145's finding 6): Main stopped reopening
   * the session, so it says `released` once — the renderer drops the binding
   * and the chat leaves "Active now" — and the eviction that later retires the
   * dead entry adds no `capacity_reclaimed` for a session already let go.
   */
  it('[E156-6] a session parked in error is released once, and its eviction says nothing more', async () => {
    const h = createHarness({ capacity: 1, maxRestartAttempts: 1 });
    await create(h.manager, 's1');
    h.createSlot.mockImplementationOnce(rejectSpawn());
    h.records[0].crash('boom');
    await vi.waitFor(() =>
      expect(h.manager.getSlotSnapshots()[0]).toMatchObject({ state: 'error' })
    );
    const releases = () =>
      h.events.filter(
        (event) =>
          event.sessionId === 's1' &&
          event.type === 'session.status' &&
          (event.payload as { disconnectReason?: string }).disconnectReason !== undefined
      );
    expect(releases().map((event) => event.payload)).toEqual([
      { status: 'disconnected', disconnectReason: 'released' },
    ]);
    // Main keeps the entry, as before: a user's open retires it.
    expect(h.manager.getStatus().state).toBe('degraded');

    await create(h.manager, 's2');
    expect(releases()).toHaveLength(1);
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

  it('replaces every slot on config invalidation', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    await create(h.manager, 's2', 22);

    await h.manager.invalidateAll();

    expect(h.records[0].dispose).toHaveBeenCalledWith('slot-replace');
    expect(h.records[1].dispose).toHaveBeenCalledWith('slot-replace');
  });

  it('closes one session without touching another slot', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    await create(h.manager, 's2', 22);

    await h.manager.closeSession('s1');

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
    expect(h.createSlot.mock.calls[2][0]).toMatchObject({
      logicalSessionId: 's1',
      sessionFile: norm('/sessions/s1.jsonl'),
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
        runtimeIdentity: norm('/sessions/s1.jsonl'),
        workspacePath: norm('/repo'),
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

describe('WorkerManager compaction budget', () => {
  it("gives a compaction a model-sized budget, and waits out the worker's own cutoff", async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);

    await expect(h.manager.compactSession({ sessionId: 's1' })).resolves.toEqual({
      compacted: true,
    });
    const compactCall = h.records[0]?.request.mock.calls.find(
      ([type]) => type === 'worker.compact'
    );
    expect(compactCall?.[2]).toEqual({ timeoutMs: WORKER_COMPACT_REQUEST_TIMEOUT_MS });
    // The order is the contract: the worker aborts its own summary first, so
    // the answer Main reports is the outcome the session file actually has. A
    // timeout here only rejects this promise — it does not stop the worker.
    expect(WORKER_COMPACT_BUDGET_MS).toBeLessThan(WORKER_COMPACT_REQUEST_TIMEOUT_MS);
  });
});

// 2026-09-04 bug: creating a session showed "Pi session service stopped · click
// Retry" while the very next message answered normally. Workers spawn lazily,
// so an empty pool is the manager's IDLE state — deriving `stopped` from it
// turned a healthy service into a scary ribbon with a Retry button.
describe('WorkerManager manager-level state', () => {
  it('reports stopped only before it has ever been readied', () => {
    const h = createHarness();
    expect(h.manager.getStatus().state).toBe('stopped');
  });

  it('stays ready with an empty pool once readied — lazy spawn is not a stop', async () => {
    const h = createHarness();
    await h.manager.ensureReady();
    expect(h.manager.getStatus().state).toBe('ready');

    // A session that comes and goes must leave the service reported as usable.
    await create(h.manager, 's1', 11);
    expect(h.manager.getStatus().state).toBe('ready');
    await h.manager.closeSession('s1');
    expect(h.manager.getSlotSnapshots()).toEqual([]);
    expect(h.manager.getStatus().state).toBe('ready');
  });

  it('reports stopped again after an explicit shutdown, and does not drift back', async () => {
    const h = createHarness();
    await h.manager.ensureReady();
    await create(h.manager, 's1', 11);
    await h.manager.disposeAll('app-shutdown');
    expect(h.manager.getStatus().state).toBe('stopped');

    // A late disposal recomputing the state must not resurrect it as ready.
    await h.manager.closeSession('s1');
    expect(h.manager.getStatus().state).toBe('stopped');
  });
});

/**
 * R02-b — the composer's command menu.
 *
 * This read is deliberately unlike every other one on WorkerManager: no ready
 * session required, no idle assertion, no ownership claim. It is asked while
 * the user types, including on the start screen where no session exists.
 */
/**
 * main-host-03 — the dispose drain window.
 *
 * The worker orders its teardown so that the engine can still emit while it
 * denies parked permission gates and cancels parked questions: see the comment
 * on `handleDispose` (dsh-host/bridge/bridgeRpcServer.ts) and `dispose()`
 * in the bridge's dshSessionRuntime.ts. Main used to close its event gate
 * before asking for that teardown, so every one of those resolutions was
 * dropped and the cards stayed on screen with nothing left to answer them.
 */
describe('WorkerManager dispose drain window', () => {
  it('forwards the resolutions a worker emits while it drains, then closes the gate', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    const record = h.records[0];
    record.dispose.mockImplementationOnce(async () => {
      // Exactly what the worker does before it acks: deny the parked gate and
      // cancel the parked question, both through the emitting path.
      record.emit({
        type: 'permission.resolved',
        sessionId: 's1',
        payload: {
          permissionId: 'perm-1',
          allow: false,
          decision: 'deny',
          autoReason: 'session_closed',
        },
      });
      record.emit({
        type: 'question.resolved',
        sessionId: 's1',
        payload: { questionId: 'q-1', outcome: 'cancelled' },
      });
    });
    h.events.length = 0;

    await h.manager.invalidateAll();

    // P1-7e e6 (decision 145): Main's own `released` comes first, at the
    // retirement; the drained resolutions follow it.
    expect(h.events.map((event) => event.type)).toEqual([
      'session.status',
      'permission.resolved',
      'question.resolved',
    ]);
    expect(h.events[0]).toMatchObject({
      sessionId: 's1',
      payload: { status: 'disconnected', disconnectReason: 'released' },
    });
    expect(h.events[1]).toMatchObject({
      sessionId: 's1',
      payload: { permissionId: 'perm-1', autoReason: 'session_closed' },
    });

    // The window is bounded by the disposal itself: anything the dead slot
    // says afterwards is gone.
    record.emit({
      type: 'permission.resolved',
      sessionId: 's1',
      payload: { permissionId: 'perm-late', allow: false },
    });
    expect(h.events).toHaveLength(3);
  });

  it('opens the window for resolutions only, not for the rest of the stream', async () => {
    // A retired session must not keep appending to a transcript the renderer
    // has moved on from. Only the two events that RETRACT a pending card ride
    // the window.
    const h = createHarness();
    await create(h.manager, 's1', 11);
    const record = h.records[0];
    record.dispose.mockImplementationOnce(async () => {
      record.emit({
        type: 'message.delta',
        sessionId: 's1',
        payload: { messageId: 'm-1', blockId: 'b-1', text: 'still talking' },
      });
      record.emit({
        type: 'session.completed',
        sessionId: 's1',
        payload: { reason: 'completed' },
      });
    });
    h.events.length = 0;

    await h.manager.invalidateAll();

    // Only Main's own `released` (decision 145); nothing the worker said.
    expect(h.events.map((event) => event.type)).toEqual(['session.status']);
  });

  it('drops a drain resolution that names another session', async () => {
    // The window relaxes the map-membership gate, so the session-ownership
    // check is the only thing left standing between two workers' streams.
    const h = createHarness();
    await create(h.manager, 's1', 11);
    const record = h.records[0];
    record.dispose.mockImplementationOnce(async () => {
      record.emit({
        type: 'permission.resolved',
        sessionId: 'someone-else',
        payload: { permissionId: 'perm-1', allow: false },
      });
    });
    h.events.length = 0;

    await h.manager.invalidateAll();

    // Only Main's own `released` for `s1` (decision 145).
    expect(h.events.map((event) => [event.type, event.sessionId])).toEqual([
      ['session.status', 's1'],
    ]);
  });
});

describe('WorkerManager slash commands', () => {
  it('forwards to a ready worker and returns its list', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);

    await expect(h.manager.getSlashCommands({ sessionId: 's1' })).resolves.toEqual({
      commands: [{ name: 'skill:from-s1', source: 'skill' }],
      truncated: false,
    });
  });

  it('answers with an empty list when no worker exists at all', async () => {
    // The start screen. Throwing here would make every caller translate the
    // error back into "no commands".
    const h = createHarness();
    await expect(h.manager.getSlashCommands()).resolves.toEqual({
      commands: [],
      truncated: false,
    });
  });

  it('still answers from the nearest worker when no session is named', async () => {
    // The start screen: there is no session to hand a wrong list to, and the
    // agent-dir and user scopes are the same for every worker.
    const h = createHarness();
    await create(h.manager, 's1', 11);

    await expect(h.manager.getSlashCommands()).resolves.toEqual({
      commands: [{ name: 'skill:from-s1', source: 'skill' }],
      truncated: false,
    });
  });

  // main-host-01 — the fallback used to take the first ready worker in the
  // pool, on the strength of a comment saying the command set does not vary by
  // working directory. Decision 009 made project scope trusted and loaded, so
  // it does: every row carries an absolute `path` under the answering worker's
  // cwd.
  it('falls back to a worker in the same workspace when the named session has none', async () => {
    const h = createHarness({ createFailureAfter: 2, maxRestartAttempts: 1 });
    await h.manager.createSession({ sessionId: 'alpha-a', workspacePath: '/work/alpha' });
    await h.manager.createSession({ sessionId: 'alpha-b', workspacePath: '/work/alpha' });
    h.records[1].crash('worker died');
    await vi.waitFor(() =>
      expect(
        h.manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === 'alpha-b')
      ).toMatchObject({ state: 'error' })
    );

    // Same cwd, so the project-scoped skills and prompts the live worker
    // scanned are the ones this session would load too.
    await expect(h.manager.getSlashCommands({ sessionId: 'alpha-b' })).resolves.toEqual({
      commands: [{ name: 'skill:from-alpha-a', source: 'skill' }],
      truncated: false,
    });
  });

  it('never answers a named session from another workspace worker', async () => {
    const h = createHarness({ createFailureAfter: 2, maxRestartAttempts: 1 });
    await h.manager.createSession({ sessionId: 'alpha', workspacePath: '/work/alpha' });
    await h.manager.createSession({ sessionId: 'beta', workspacePath: '/work/beta' });
    h.records[1].crash('worker died');
    await vi.waitFor(() =>
      expect(
        h.manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === 'beta')
      ).toMatchObject({ state: 'error' })
    );

    await expect(h.manager.getSlashCommands({ sessionId: 'beta' })).resolves.toEqual({
      commands: [],
      truncated: false,
    });
    expect(h.records[0].request).not.toHaveBeenCalledWith('worker.commands', expect.anything());
  });

  it('answers empty for a named session the pool has never started', async () => {
    // The reported case: session B in another repo, created but never sent to,
    // so it has no entry at all and no workspace this class can compare.
    const h = createHarness();
    await h.manager.createSession({ sessionId: 'alpha', workspacePath: '/work/alpha' });

    await expect(h.manager.getSlashCommands({ sessionId: 'never-started' })).resolves.toEqual({
      commands: [],
      truncated: false,
    });
    expect(h.records[0].request).not.toHaveBeenCalledWith('worker.commands', expect.anything());
  });

  it('does not require the session to be idle', async () => {
    // The menu is needed exactly while a turn is running.
    const h = createHarness();
    await create(h.manager, 's1', 11);
    await h.manager.send({
      sessionId: 's1',
      attemptId: 'attempt-1',
      text: 'hello',
      ownerWebContentsId: 11,
    });

    await expect(h.manager.getSlashCommands({ sessionId: 's1' })).resolves.toMatchObject({
      commands: [{ name: 'skill:from-s1' }],
    });
  });

  it('drops a malformed row rather than failing the menu', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    record?.request.mockImplementation(async (type: string) =>
      type === 'worker.commands'
        ? {
            commands: [{ name: 'good', source: 'skill' }, { source: 'nameless' }, null],
            truncated: false,
          }
        : {}
    );

    await expect(h.manager.getSlashCommands({ sessionId: 's1' })).resolves.toEqual({
      commands: [{ name: 'good', source: 'skill' }],
      truncated: false,
    });
  });
});

/**
 * dsh-rebase P1-7a (decision 118): the goal bar's out-of-band command and the
 * panels' rehydration. The command acts on a ready session and passes the
 * engine's answer through; the panels are a read that answers nothing, not an
 * error, for a session with no ready slot.
 */
describe('WorkerManager goal bar and panels (P1-7a)', () => {
  it('[P7A-WM-CMD] forwards a command line to the ready slot and passes its answer on', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    record?.request.mockImplementation(async (type: string) =>
      type === 'worker.command' ? { ok: false, error: 'No goal is currently set.' } : {}
    );

    await expect(
      h.manager.runSessionCommand({ sessionId: 's1', line: '/goal pause', ownerWebContentsId: 11 })
    ).resolves.toEqual({ ok: false, error: 'No goal is currently set.' });
    expect(record?.request).toHaveBeenCalledWith('worker.command', {
      logicalSessionId: 's1',
      line: '/goal pause',
    });
  });

  it('[P7A-WM-CMD-REFUSED] no ready slot, or a malformed answer, is an error', async () => {
    const h = createHarness();
    await expect(
      h.manager.runSessionCommand({ sessionId: 'never-started', line: '/goal pause' })
    ).rejects.toMatchObject({ code: 'session_not_found' });
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    record?.request.mockImplementation(async () => ({ ok: 'maybe' }));
    await expect(
      h.manager.runSessionCommand({ sessionId: 's1', line: '/goal pause' })
    ).rejects.toMatchObject({ code: 'worker_command_failed' });
  });

  it('[P7A-WM-PANELS] reads the ready slot, keeps known keys; no slot answers no panels', async () => {
    const h = createHarness();
    await expect(h.manager.getSessionPanels({ sessionId: 'never-started' })).resolves.toEqual({
      projections: [],
    });
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    record?.request.mockImplementation(async (type: string) =>
      type === 'worker.panels'
        ? {
            projections: [
              { key: 'todos', view: [{ content: 'a', status: 'pending' }] },
              { key: 'nonsense', view: 1 },
            ],
          }
        : {}
    );

    await expect(h.manager.getSessionPanels({ sessionId: 's1' })).resolves.toEqual({
      projections: [{ key: 'todos', view: [{ content: 'a', status: 'pending' }] }],
    });
    expect(record?.request).toHaveBeenCalledWith('worker.panels', { logicalSessionId: 's1' });
  });
});

/**
 * dsh-rebase P1-7b (decision 119): the jobs and subagents windows. A kill and
 * an interrupt act on a ready session and are claimed for the window; the
 * output read answers `null`, not an error, for a session whose worker went.
 */
describe('WorkerManager jobs and subagents windows (P1-7b)', () => {
  it('[P7B-WM-KILL] forwards a kill to the ready slot and claims the session', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    record?.request.mockImplementation(async (type: string) =>
      type === 'worker.job.kill' ? { outcome: 'requested' } : {}
    );
    await expect(
      h.manager.killSessionJob({ sessionId: 's1', jobId: 'bash-2', ownerWebContentsId: 11 })
    ).resolves.toEqual({ outcome: 'requested' });
    expect(record?.request).toHaveBeenCalledWith('worker.job.kill', {
      logicalSessionId: 's1',
      jobId: 'bash-2',
    });
  });

  it('[P7B-WM-KILL-REFUSED] no ready slot, or a malformed answer, is an error', async () => {
    const h = createHarness();
    await expect(
      h.manager.killSessionJob({ sessionId: 'never-started', jobId: 'bash-2' })
    ).rejects.toMatchObject({ code: 'session_not_found' });
    await expect(
      h.manager.interruptSubagent({ sessionId: 'never-started', childId: 'kid' })
    ).rejects.toMatchObject({ code: 'session_not_found' });
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    record?.request.mockImplementation(async () => ({ outcome: 'maybe', interrupted: 'yes' }));
    await expect(
      h.manager.killSessionJob({ sessionId: 's1', jobId: 'bash-2' })
    ).rejects.toMatchObject({ code: 'worker_job_failed' });
    await expect(
      h.manager.interruptSubagent({ sessionId: 's1', childId: 'kid' })
    ).rejects.toMatchObject({ code: 'worker_subagent_failed' });
  });

  it('[P7B-WM-READ] reads through the ready slot, sanitized; no slot answers null', async () => {
    const h = createHarness();
    await expect(
      h.manager.readSessionJob({ sessionId: 'never-started', jobId: 'bash-2' })
    ).resolves.toBeNull();
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    record?.request.mockImplementation(async (type: string) =>
      type === 'worker.job.read'
        ? { text: 'out', from: 3, next: 6, omittedBytes: 3, lossy: false, extra: 1 }
        : {}
    );
    await expect(
      h.manager.readSessionJob({ sessionId: 's1', jobId: 'bash-2', from: 3 })
    ).resolves.toEqual({ text: 'out', from: 3, next: 6, omittedBytes: 3, lossy: false });
    expect(record?.request).toHaveBeenCalledWith('worker.job.read', {
      logicalSessionId: 's1',
      jobId: 'bash-2',
      from: 3,
    });
  });

  it('[P7B-WM-INTERRUPT] forwards an interrupt to the ready slot', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    record?.request.mockImplementation(async (type: string) =>
      type === 'worker.subagent.interrupt' ? { interrupted: true } : {}
    );
    await expect(
      h.manager.interruptSubagent({ sessionId: 's1', childId: 'kid', ownerWebContentsId: 11 })
    ).resolves.toEqual({ interrupted: true });
    expect(record?.request).toHaveBeenCalledWith('worker.subagent.interrupt', {
      logicalSessionId: 's1',
      childId: 'kid',
    });
  });
});

/**
 * P5-2-3 — `preview.requested` is answered by Main, not by a card.
 *
 * The preview surface is an Electron window, so this event is the one blocking
 * request in the protocol that never reaches the renderer. What has to hold is
 * that it is ALWAYS answered: a `browser_preview` call parks on the reply, and
 * a reply that never comes is a turn the user can only end with Stop.
 */
describe('WorkerManager preview requests', () => {
  function requestedPreview(record: FakeSlotRecord, payload: Record<string, unknown>): void {
    record.emit({
      type: 'preview.requested',
      seq: 1,
      timestamp: 0,
      sessionId: record.sessionId,
      payload,
    });
  }

  function previewAcks(record: FakeSlotRecord): Record<string, unknown>[] {
    return record.request.mock.calls
      .filter(([type]) => type === 'worker.preview.respond')
      .map(([, payload]) => payload as Record<string, unknown>);
  }

  it('opens the preview and reports success back to the worker', async () => {
    const shown: { path: string; focus: boolean }[] = [];
    const h = createHarness({
      showPreview: async (request) => {
        shown.push(request);
      },
    });
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    if (!record) throw new Error('no slot');

    requestedPreview(record, { previewId: 'p1', path: '/repo/demo.html', focus: false });
    await vi.waitFor(() => expect(previewAcks(record)).toHaveLength(1));

    expect(shown).toEqual([{ path: '/repo/demo.html', focus: false }]);
    expect(previewAcks(record)[0]).toMatchObject({
      logicalSessionId: 's1',
      previewId: 'p1',
      ok: true,
    });
  });

  it('carries the focus flag through unchanged', async () => {
    const shown: { path: string; focus: boolean }[] = [];
    const h = createHarness({
      showPreview: async (request) => {
        shown.push(request);
      },
    });
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    if (!record) throw new Error('no slot');

    requestedPreview(record, { previewId: 'p1', path: '/repo/demo.html', focus: true });
    await vi.waitFor(() => expect(previewAcks(record)).toHaveLength(1));
    expect(shown[0].focus).toBe(true);
  });

  it('reports the failure reason instead of leaving the tool call parked', async () => {
    const h = createHarness({
      showPreview: async () => {
        throw new Error('ERR_FILE_NOT_FOUND');
      },
    });
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    if (!record) throw new Error('no slot');

    requestedPreview(record, { previewId: 'p1', path: '/repo/gone.html', focus: false });
    await vi.waitFor(() => expect(previewAcks(record)).toHaveLength(1));
    expect(previewAcks(record)[0]).toMatchObject({
      previewId: 'p1',
      ok: false,
      error: 'ERR_FILE_NOT_FOUND',
    });
  });

  it('refuses by default, because a manager with no host has no window to open', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    if (!record) throw new Error('no slot');

    requestedPreview(record, { previewId: 'p1', path: '/repo/demo.html', focus: false });
    await vi.waitFor(() => expect(previewAcks(record)).toHaveLength(1));
    // Explicitly NOT `ok: true`: answering success from a manager that opened
    // nothing would tell the model a page is on screen when none is.
    expect(previewAcks(record)[0]).toMatchObject({ ok: false });
  });

  it('ignores a request with no id or no path', async () => {
    const shown: unknown[] = [];
    const h = createHarness({
      showPreview: async (request) => {
        shown.push(request);
      },
    });
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    if (!record) throw new Error('no slot');

    requestedPreview(record, { path: '/repo/demo.html', focus: false });
    requestedPreview(record, { previewId: 'p2', focus: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shown).toEqual([]);
    expect(previewAcks(record)).toHaveLength(0);
  });

  it('still forwards the event, so a session trace shows the preview happened', async () => {
    const h = createHarness({ showPreview: async () => undefined });
    await create(h.manager, 's1', 11);
    const record = h.records.find((entry) => entry.sessionId === 's1');
    if (!record) throw new Error('no slot');

    requestedPreview(record, { previewId: 'p1', path: '/repo/demo.html', focus: false });
    await vi.waitFor(() => expect(previewAcks(record)).toHaveLength(1));
    expect(h.events.some((event) => event.type === 'preview.requested')).toBe(true);
  });
});

/**
 * T066 — a retry and a refused turn become log lines here, not only events.
 *
 * Both facts already crossed this funnel and neither was written down: the
 * retry existed as a `provider_retry` note in a trace file that only exists if
 * someone exported `AICLIENT_RUNTIME_TRACE_DIR` first, and a refusal
 * (`session_size_limit`, `attachment_size_limit`) as worker stderr that the log
 * only received later, truncated, as part of the crash replay of a killed
 * worker. `console.warn` rather than the `log` sink, because production never
 * injects one — see the manager's own export.
 */
describe('WorkerManager notable-event logging (T066)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const lines = (): string[] => warn.mock.calls.map((call) => String(call[0]));

  it('writes one line per provider retry, naming the attempt and the wait', async () => {
    const h = createHarness();
    await create(h.manager, 's1');

    h.records[0].emit({
      type: 'session.status',
      sessionId: 's1',
      requestId: 'turn-1',
      payload: {
        status: 'running',
        retry: { attempt: 2, maxRetries: 3, delayMs: 3000, errorStatus: '503', error: 'upstream' },
      },
    });

    const retry = lines().filter((line) => line.includes('provider retry'));
    expect(retry).toHaveLength(1);
    expect(retry[0]).toContain('s1');
    expect(retry[0]).toContain('2/3');
    expect(retry[0]).toContain('3000ms');
    expect(retry[0]).toContain('503');
  });

  it('says how long the attempt that failed had been running (T093)', async () => {
    // decision 029 clause 8. "provider retry 1/3 in 3000ms" describes what
    // happens NEXT and nothing about what took the time — and in the 2026-09-19
    // field report the seven minutes were entirely inside the attempts, not the
    // backoff, so the log could not tell a hung gateway from a busy one.
    const h = createHarness();
    await create(h.manager, 's1');
    const startedAt = 1_758_000_000_000;

    h.records[0].emit({
      type: 'session.status',
      sessionId: 's1',
      requestId: 'turn-1',
      payload: {
        status: 'running',
        retry: {
          attempt: 1,
          maxRetries: 3,
          delayMs: 3_000,
          errorStatus: null,
          error: 'NETWORK_ERROR',
          attemptStartedAt: startedAt,
          // The runtime builds this as "the instant it failed plus the
          // backoff", so 120s of attempt + 3s of wait.
          retryAt: startedAt + 120_000 + 3_000,
          delegationId: 'deleg-7',
        },
      },
    });

    const retry = lines().filter((line) => line.includes('provider retry'))[0] ?? '';
    expect(retry).toContain('after 120000ms');
    // ...and which delegate it was, when it was not the conversation itself.
    expect(retry).toContain('deleg-7');
  });

  it('keeps the old line shape when a worker sends no timing (T093)', async () => {
    const h = createHarness();
    await create(h.manager, 's1');

    h.records[0].emit({
      type: 'session.status',
      sessionId: 's1',
      requestId: 'turn-1',
      payload: {
        status: 'running',
        retry: { attempt: 1, maxRetries: 3, delayMs: 3_000, errorStatus: null, error: 'unknown' },
      },
    });

    const retry = lines().filter((line) => line.includes('provider retry'))[0] ?? '';
    expect(retry).not.toContain('after');
    expect(retry).not.toContain('delegate=');
  });

  it('writes the refusal code the moment the turn fails, redacted', async () => {
    const h = createHarness();
    await create(h.manager, 's1');

    h.records[0].emit({
      type: 'session.failed',
      sessionId: 's1',
      requestId: 'turn-1',
      payload: {
        error: 'session_size_limit: session exceeds the configured size budget sk-ant-abc123secret',
      },
    });

    const failed = lines().filter((line) => line.includes('turn failed'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('session_size_limit');
    expect(failed[0]).not.toContain('sk-ant-abc123secret');
  });

  /**
   * T066 rework — the 2026-09-17 field pass found this line reading `turn failed:
   * session exceeds the configured size budget`: the code sits in the payload,
   * not in the sentence, for every run that ENDS in failure (the sentence is
   * the user's, so the projector does not prefix it). With nothing to grep for,
   * a refusal and a provider outage looked the same in the log.
   */
  it('puts the failure code in front of a refusal that reports it beside the text', async () => {
    const h = createHarness();
    await create(h.manager, 's1');

    h.records[0].emit({
      type: 'session.failed',
      sessionId: 's1',
      requestId: 'turn-1',
      payload: {
        error: 'session exceeds the configured size budget',
        errorCode: 'session_size_limit',
      },
    });

    const failed = lines().filter((line) => line.includes('turn failed'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('turn failed: session_size_limit: session exceeds');
  });

  it('does not repeat a code the text already leads with', async () => {
    const h = createHarness();
    await create(h.manager, 's1');

    h.records[0].emit({
      type: 'session.failed',
      sessionId: 's1',
      requestId: 'turn-1',
      payload: {
        error: 'attachment_size_limit: attachment "a.png" is 9000000 bytes',
        errorCode: 'attachment_size_limit',
      },
    });

    const failed = lines().filter((line) => line.includes('turn failed'));
    expect(failed[0]).toContain('turn failed: attachment_size_limit: attachment');
    expect(failed[0]).not.toContain('attachment_size_limit: attachment_size_limit');
  });

  it('stays quiet on an ordinary running status and a completed turn', async () => {
    const h = createHarness();
    await create(h.manager, 's1');

    h.records[0].emit({
      type: 'session.status',
      sessionId: 's1',
      requestId: 'turn-1',
      payload: { status: 'running' },
    });
    h.records[0].emit({
      type: 'session.completed',
      sessionId: 's1',
      requestId: 'turn-1',
      payload: { status: 'completed' },
    });

    expect(lines()).toEqual([]);
  });
});

/**
 * decision 046 / T144 — Stop always settles; Main mirrors the worker's view of
 * "is a turn running" and reconciles its own latch against it.
 *
 * Field report 2026-09-25 (Windows `1.0.3-test.2`): after the failure card's
 * 「继续」 the session showed "running" forever; Stop, Esc and Ctrl+Enter did
 * nothing, and ending the conversation did not clear it. The renderer only
 * leaves "running" on a terminal event, and every path below used to end in
 * none.
 */
describe('WorkerManager Stop always settles (decision 046)', () => {
  const TERMINALS = ['session.completed', 'session.failed', 'session.stopped'];

  /** `type` for terminals, `status:<x>` for statuses — the order the renderer sees. */
  function sequence(events: Array<Record<string, unknown>>): string[] {
    return events
      .filter((event) => TERMINALS.includes(String(event.type)) || event.type === 'session.status')
      .map((event) => {
        const payload = (event.payload ?? {}) as { status?: string; stopCause?: string };
        return event.type === 'session.status'
          ? `status:${payload.status}`
          : `${String(event.type)}${payload.stopCause ? `(${payload.stopCause})` : ''}`;
      });
  }

  function stopAnswers(record: FakeSlotRecord, answer: { stopped: boolean }) {
    const original = record.request.getMockImplementation() as (
      type: string,
      payload: unknown
    ) => Promise<unknown>;
    record.request.mockImplementation(async (type: string, payload: unknown) =>
      type === 'worker.stop' ? answer : original(type, payload)
    );
  }

  async function running(h: ReturnType<typeof createHarness>): Promise<string> {
    await create(h.manager, 's1', 7);
    const turnId = await h.manager.send({
      sessionId: 's1',
      attemptId: 'a1',
      text: 'resent prompt',
      ownerWebContentsId: 7,
    });
    h.records[0].emit({ type: 'session.status', sessionId: 's1', payload: { status: 'running' } });
    h.events.length = 0;
    return turnId;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('[T144-wm-01] a stop that finds no turn settles the session and drops the pinned latch', async () => {
    const h = createHarness();
    const turnId = await running(h);
    stopAnswers(h.records[0], { stopped: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await h.manager.stop('s1');
    } finally {
      warn.mockRestore();
    }

    expect(sequence(h.events)).toEqual(['session.stopped(no_active_turn)', 'status:idle']);
    expect(h.events.every((event) => event.requestId === turnId)).toBe(true);
    // The latch the worker no longer backed is gone: the next send is admitted.
    await expect(
      h.manager.send({ sessionId: 's1', attemptId: 'a2', text: 'next', ownerWebContentsId: 7 })
    ).resolves.toMatch(/^send-/);
  });

  it('[T144-wm-02] a stop with no ready worker still gets a terminal answer', async () => {
    const h = createHarness();
    await h.manager.stop('never-created');
    expect(sequence(h.events)).toEqual(['session.stopped(no_active_turn)', 'status:idle']);
    expect(h.events.every((event) => event.sessionId === 'never-created')).toBe(true);
  });

  it("[T144-wm-03] the turn's own terminal answers an accepted stop and disarms the watchdog", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    await running(h);
    await h.manager.stop('s1');
    h.records[0].emit({ type: 'session.status', sessionId: 's1', payload: { status: 'stopping' } });
    h.records[0].emit({ type: 'session.stopped', sessionId: 's1', payload: {} });
    h.records[0].emit({ type: 'session.status', sessionId: 's1', payload: { status: 'idle' } });

    await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS * 2);
    expect(sequence(h.events)).toEqual(['status:stopping', 'session.stopped', 'status:idle']);
    expect(h.createSlot).toHaveBeenCalledTimes(1);
    expect(h.records[0].dispose).not.toHaveBeenCalled();
  });

  it('[T144-wm-04] an accepted stop with no terminal is forced after the watchdog, through the crash path', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    const turnId = await running(h);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Wedged, so it misses its dispose ACK too; the slot still confirms the
    // exit, which is all the replacement needs.
    const created = (await h.createSlot.mock.results[0]?.value) as { slot: { state: string } };
    h.records[0].dispose.mockImplementation(async () => {
      created.slot.state = 'disposed';
      throw new Error('Worker request worker.dispose timed out after 3000ms');
    });
    try {
      await h.manager.stop('s1');
      h.records[0].emit({
        type: 'session.status',
        sessionId: 's1',
        payload: { status: 'stopping' },
      });
      // A second Stop keeps the first deadline instead of extending it.
      await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS / 2);
      await h.manager.stop('s1');
      await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS / 2 - 1);
      expect(sequence(h.events)).toEqual(['status:stopping']);

      await vi.advanceTimersByTimeAsync(1);
      // The settle comes first; the restart's own history refresh follows it.
      expect(sequence(h.events).slice(0, 3)).toEqual([
        'status:stopping',
        'session.stopped(forced)',
        'status:idle',
      ]);
      expect(h.events.find((event) => event.type === 'session.stopped')?.requestId).toBe(turnId);
      expect(warn.mock.calls.flat().join(' ')).toContain(
        `stop did not settle within ${STOP_WATCHDOG_MS}ms`
      );

      // The wedged worker is replaced, not waited on.
      await vi.waitFor(() => expect(h.records[0].dispose).toHaveBeenCalledWith('slot-replace'));
      await vi.waitFor(() =>
        expect(h.manager.getSlotSnapshots()[0]).toMatchObject({ state: 'ready', generation: 2 })
      );
      // A late terminal from the old generation changes nothing.
      const settled = h.events.length;
      h.records[0].emit({ type: 'session.stopped', sessionId: 's1', payload: {} });
      expect(h.events).toHaveLength(settled);
      await expect(
        h.manager.send({ sessionId: 's1', attemptId: 'a2', text: 'again', ownerWebContentsId: 7 })
      ).resolves.toMatch(/^send-/);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('[T144-wm-05] a worker that dies while stopping answers the stop as forced, not failed', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    await running(h);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await h.manager.stop('s1');
      h.records[0].crash('killed');
      expect(sequence(h.events)).toEqual(['session.stopped(forced)', 'status:idle']);
      // The watchdog went with the dead worker: nothing fires a second terminal.
      await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS * 2);
      expect(h.events.filter((event) => TERMINALS.includes(String(event.type)))).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  it('[T144-wm-06] closing a session mid-turn says stopped before disconnected', async () => {
    const h = createHarness();
    const turnId = await running(h);
    await h.manager.closeSession('s1');

    expect(h.records[0].dispose).toHaveBeenCalledWith('slot-dispose');
    expect(sequence(h.events)).toEqual(['session.stopped(forced)', 'status:disconnected']);
    expect(h.events.every((event) => event.requestId === turnId)).toBe(true);
    // Stop and interject on the ended session stay answerable.
    h.events.length = 0;
    await h.manager.stop('s1');
    await expect(h.manager.interject('s1', { attemptId: 'i1', text: 'also' })).resolves.toEqual({
      interjected: false,
    });
    expect(sequence(h.events)).toEqual(['session.stopped(no_active_turn)', 'status:idle']);
  });

  it('[T144-wm-07] closing an idle session announces nothing', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 7);
    h.events.length = 0;
    await h.manager.closeSession('s1');
    expect(h.events).toEqual([]);
  });

  it('[T144-wm-08] a re-claim does not replay a latch the worker never confirmed as running', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 7);
    await h.manager.send({ sessionId: 's1', attemptId: 'a1', text: 'hi', ownerWebContentsId: 7 });
    h.events.length = 0;

    // Nothing reported yet: no status is re-announced at all.
    await create(h.manager, 's1', 8);
    expect(sequence(h.events)).toEqual([]);

    // Once the worker says where the turn is, that is what a re-claim repeats.
    h.records[0].emit({ type: 'session.status', sessionId: 's1', payload: { status: 'running' } });
    h.records[0].emit({ type: 'session.status', sessionId: 's1', payload: { status: 'stopping' } });
    h.events.length = 0;
    await create(h.manager, 's1', 7);
    expect(sequence(h.events)).toEqual(['status:stopping']);

    // And after the turn is over, idle.
    h.records[0].emit({ type: 'session.stopped', sessionId: 's1', payload: {} });
    h.events.length = 0;
    await create(h.manager, 's1', 8);
    expect(sequence(h.events)).toEqual(['status:idle']);
  });

  it('[T144-wm-09] a crash with no turn still leaves the renderer settled', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 7);
    h.events.length = 0;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      h.records[0].crash('killed');
      expect(sequence(h.events)).toEqual(['status:disconnected']);
      await vi.waitFor(() => expect(sequence(h.events).at(-1)).toBe('status:idle'));
      expect(h.events.some((event) => TERMINALS.includes(String(event.type)))).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  it('[T144-wm-10] interject with no turn in the worker settles like a stop that found nothing', async () => {
    const h = createHarness();
    const turnId = await running(h);
    const original = h.records[0].request.getMockImplementation() as (
      type: string,
      payload: unknown
    ) => Promise<unknown>;
    let answer: Record<string, unknown> = { interjected: false, turnActive: true };
    h.records[0].request.mockImplementation(async (type: string, payload: unknown) =>
      type === 'worker.interject' ? answer : original(type, payload)
    );
    const input = { attemptId: 'i1', text: 'also this' };

    // A turn the worker still holds: nothing to settle.
    await expect(h.manager.interject('s1', input)).resolves.toEqual({
      interjected: false,
      turnActive: true,
    });
    expect(h.events).toEqual([]);

    // No turn at all: the latch goes, and the renderer's ordinary send is admitted.
    answer = { interjected: false, turnActive: false };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(h.manager.interject('s1', input)).resolves.toEqual({
        interjected: false,
        turnActive: false,
      });
    } finally {
      warn.mockRestore();
    }
    expect(sequence(h.events)).toEqual(['session.stopped(no_active_turn)', 'status:idle']);
    expect(h.events.every((event) => event.requestId === turnId)).toBe(true);
    await expect(
      h.manager.send({ sessionId: 's1', attemptId: 'a2', text: 'queued', ownerWebContentsId: 7 })
    ).resolves.toMatch(/^send-/);
  });

  it('[P1-4c1-wm-01] Ctrl+Enter carries the message to the worker and keeps the running turn', async () => {
    const h = createHarness();
    await running(h);
    const original = h.records[0].request.getMockImplementation() as (
      type: string,
      payload: unknown
    ) => Promise<unknown>;
    const payloads: unknown[] = [];
    h.records[0].request.mockImplementation(async (type: string, payload: unknown) => {
      if (type !== 'worker.interject') return original(type, payload);
      payloads.push(payload);
      return { interjected: true, turnActive: true };
    });
    h.events.length = 0;

    await expect(
      h.manager.interject('s1', { attemptId: 'i1', text: 'also check the tests' })
    ).resolves.toEqual({ interjected: true, turnActive: true });
    // decision 093: the message itself, with the renderer's attempt id.
    expect(payloads).toEqual([
      { logicalSessionId: 's1', attemptId: 'i1', text: 'also check the tests' },
    ]);
    // Nothing settles and the latch stays with the running turn: a send is still busy.
    expect(h.events).toEqual([]);
    await expect(
      h.manager.send({ sessionId: 's1', attemptId: 'a2', text: 'next', ownerWebContentsId: 7 })
    ).rejects.toMatchObject({ code: 'session_busy' });
  });

  it('[P1-4c1-wm-02] an interject the worker answers badly is an invalid acknowledgement', async () => {
    const h = createHarness();
    await running(h);
    const original = h.records[0].request.getMockImplementation() as (
      type: string,
      payload: unknown
    ) => Promise<unknown>;
    h.records[0].request.mockImplementation(async (type: string, payload: unknown) =>
      type === 'worker.interject' ? { interjected: 'yes' } : original(type, payload)
    );
    await expect(
      h.manager.interject('s1', { attemptId: 'i1', text: 'also' })
    ).rejects.toMatchObject({ code: 'worker_invalid_interject_ack' });
  });

  it('[I8-wm-01] a withdrawal goes to the worker that steered it; the running turn keeps its latch', async () => {
    const h = createHarness();
    await running(h);
    const original = h.records[0].request.getMockImplementation() as (
      type: string,
      payload: unknown
    ) => Promise<unknown>;
    const payloads: unknown[] = [];
    h.records[0].request.mockImplementation(async (type: string, payload: unknown) => {
      if (type !== 'worker.interject.withdraw') return original(type, payload);
      payloads.push(payload);
      return { outcome: 'withdrawn' };
    });
    h.events.length = 0;

    await expect(h.manager.withdrawInterjection('s1', 'i1')).resolves.toEqual({
      outcome: 'withdrawn',
    });
    // Issue #8 (decision 172 §4): the session and the interjection's attempt id.
    expect(payloads).toEqual([{ logicalSessionId: 's1', attemptId: 'i1' }]);
    expect(h.events).toEqual([]);
    await expect(
      h.manager.send({ sessionId: 's1', attemptId: 'a2', text: 'next', ownerWebContentsId: 7 })
    ).rejects.toMatchObject({ code: 'session_busy' });
  });

  it('[I8-wm-02] with no ready worker nothing can name it, and none is started', async () => {
    const h = createHarness();
    await expect(h.manager.withdrawInterjection('s1', 'i1')).resolves.toEqual({
      outcome: 'not_found',
    });
    expect(h.records).toHaveLength(0);
  });

  it('[I8-wm-03] an answer outside the three outcomes is an invalid acknowledgement', async () => {
    const h = createHarness();
    await running(h);
    const original = h.records[0].request.getMockImplementation() as (
      type: string,
      payload: unknown
    ) => Promise<unknown>;
    h.records[0].request.mockImplementation(async (type: string, payload: unknown) =>
      type === 'worker.interject.withdraw' ? { outcome: 'gone' } : original(type, payload)
    );
    await expect(h.manager.withdrawInterjection('s1', 'i1')).rejects.toMatchObject({
      code: 'worker_invalid_withdraw_ack',
    });
  });

  it('[T144-wm-11] a send the worker refused up front does not pin the latch', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 7);
    const record = h.records[0];
    const original = record.request.getMockImplementation() as (
      type: string,
      payload: unknown
    ) => Promise<unknown>;
    // What the worker does now (decision 046 rule 5): report the refusal as
    // this request's failure, settle, and reject the send instead of acking it.
    record.request.mockImplementationOnce(async (type: string, payload: unknown) => {
      if (type !== 'worker.send') return original(type, payload);
      const requestId = (payload as { requestId: string }).requestId;
      record.emit({
        type: 'session.failed',
        sessionId: 's1',
        requestId,
        payload: { error: 'runtime_busy: a run is already active in this runtime' },
      });
      record.emit({
        type: 'session.status',
        sessionId: 's1',
        requestId,
        payload: { status: 'idle' },
      });
      throw Object.assign(new Error('WORKER_SESSION_BUSY: runtime_busy'), {
        code: 'WORKER_RPC_REMOTE_ERROR',
      });
    });
    h.events.length = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        h.manager.send({ sessionId: 's1', attemptId: 'a1', text: 'hi', ownerWebContentsId: 7 })
      ).rejects.toThrow(/runtime_busy/);
    } finally {
      warn.mockRestore();
    }
    expect(sequence(h.events)).toEqual(['session.failed', 'status:idle']);
    expect(h.manager.getSlotSnapshots()[0]).toMatchObject({ active: false });
    await expect(
      h.manager.send({ sessionId: 's1', attemptId: 'a2', text: 'hi again', ownerWebContentsId: 7 })
    ).resolves.toMatch(/^send-/);
  });
});

describe('WorkerManager retry of the last turn (T135 / decision 045)', () => {
  const TERMINALS = ['session.completed', 'session.failed', 'session.stopped'];

  function sequence(events: Array<Record<string, unknown>>): string[] {
    return events
      .filter((event) => TERMINALS.includes(String(event.type)) || event.type === 'session.status')
      .map((event) => {
        const payload = (event.payload ?? {}) as { status?: string; stopCause?: string };
        return event.type === 'session.status'
          ? `status:${payload.status}`
          : `${String(event.type)}${payload.stopCause ? `(${payload.stopCause})` : ''}`;
      });
  }

  function answerSend(
    record: FakeSlotRecord,
    answer: (payload: Record<string, unknown>) => Promise<unknown>
  ) {
    const original = record.request.getMockImplementation() as (
      type: string,
      payload: unknown
    ) => Promise<unknown>;
    record.request.mockImplementationOnce(async (type: string, payload: unknown) =>
      type === 'worker.send' ? answer(payload as Record<string, unknown>) : original(type, payload)
    );
  }

  it('[T135-wm-01] asks the worker for a retry, with no prompt, and latches it like a send', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 7);
    const turnId = await h.manager.retryLastTurn({
      sessionId: 's1',
      attemptId: 'a1',
      model: 'glm/glm-5',
      effort: 'high',
      ownerWebContentsId: 7,
    });

    expect(turnId).toMatch(/^send-/);
    const sent = h.records[0].request.mock.calls.find(([type]) => type === 'worker.send');
    expect(sent?.[1]).toEqual({
      logicalSessionId: 's1',
      requestId: turnId,
      attemptId: 'a1',
      text: '',
      model: 'glm/glm-5',
      effort: 'high',
      mode: 'retry',
    });
    // One turn at a time, whichever door it came through.
    await expect(
      h.manager.send({ sessionId: 's1', attemptId: 'a2', text: 'next', ownerWebContentsId: 7 })
    ).rejects.toMatchObject({ code: 'session_busy' });
    expect(h.manager.getSlotSnapshots()[0]).toMatchObject({ active: true });
  });

  it('[T135-wm-02] nothing to re-run is `retry_unavailable`, with no latch and no event', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 7);
    answerSend(h.records[0], async () => {
      throw new WorkerSlotError(
        'WORKER_RPC_REMOTE_ERROR',
        'WORKER_RETRY_UNAVAILABLE: There is no cut-short turn to retry',
        {
          code: 'WORKER_RETRY_UNAVAILABLE',
          message: 'There is no cut-short turn to retry',
          retryable: false,
        }
      );
    });
    h.events.length = 0;

    await expect(
      h.manager.retryLastTurn({ sessionId: 's1', attemptId: 'a1', ownerWebContentsId: 7 })
    ).rejects.toMatchObject({
      name: 'WorkerManagerError',
      code: 'retry_unavailable',
      message: 'There is no cut-short turn to retry',
    });
    expect(h.events).toEqual([]);
    expect(h.manager.getSlotSnapshots()[0]).toMatchObject({ active: false });
    await expect(
      h.manager.send({ sessionId: 's1', attemptId: 'a2', text: 'hi', ownerWebContentsId: 7 })
    ).resolves.toMatch(/^send-/);
  });

  it('[T135-wm-03] a retry the worker refused up front settles and does not pin the latch', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 7);
    const record = h.records[0];
    answerSend(record, async (payload) => {
      const requestId = String(payload.requestId);
      record.emit({
        type: 'session.failed',
        sessionId: 's1',
        requestId,
        payload: { error: 'runtime_busy: a run is already active in this runtime' },
      });
      record.emit({
        type: 'session.status',
        sessionId: 's1',
        requestId,
        payload: { status: 'idle' },
      });
      throw new WorkerSlotError('WORKER_RPC_REMOTE_ERROR', 'WORKER_SESSION_BUSY: runtime_busy', {
        code: 'WORKER_SESSION_BUSY',
        message: 'runtime_busy',
        retryable: true,
      });
    });
    h.events.length = 0;

    await expect(
      h.manager.retryLastTurn({ sessionId: 's1', attemptId: 'a1', ownerWebContentsId: 7 })
    ).rejects.toThrow(/runtime_busy/);
    expect(sequence(h.events)).toEqual(['session.failed', 'status:idle']);
    expect(h.manager.getSlotSnapshots()[0]).toMatchObject({ active: false });
  });

  it('[T135-wm-04] Stop on a retried turn is armed and settled exactly as for a send', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      await create(h.manager, 's1', 7);
      const turnId = await h.manager.retryLastTurn({
        sessionId: 's1',
        attemptId: 'a1',
        ownerWebContentsId: 7,
      });
      h.records[0].emit({
        type: 'session.status',
        sessionId: 's1',
        requestId: turnId,
        payload: { status: 'running' },
      });
      h.events.length = 0;

      await h.manager.stop('s1');
      expect(h.records[0].request).toHaveBeenCalledWith('worker.stop', {
        logicalSessionId: 's1',
        reason: 'user',
      });
      h.records[0].emit({
        type: 'session.status',
        sessionId: 's1',
        payload: { status: 'stopping' },
      });
      h.records[0].emit({ type: 'session.stopped', sessionId: 's1', payload: {} });
      h.records[0].emit({ type: 'session.status', sessionId: 's1', payload: { status: 'idle' } });

      // The turn's own terminal disarmed the watchdog: no forced restart.
      await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS * 2);
      expect(sequence(h.events)).toEqual(['status:stopping', 'session.stopped', 'status:idle']);
      expect(h.createSlot).toHaveBeenCalledTimes(1);
      // And the latch went with it.
      await expect(
        h.manager.send({ sessionId: 's1', attemptId: 'a2', text: 'next', ownerWebContentsId: 7 })
      ).resolves.toMatch(/^send-/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('[T135-wm-05] a Stop that finds the retry already gone settles on its request id', async () => {
    const h = createHarness();
    await create(h.manager, 's1', 7);
    const turnId = await h.manager.retryLastTurn({
      sessionId: 's1',
      attemptId: 'a1',
      ownerWebContentsId: 7,
    });
    const original = h.records[0].request.getMockImplementation() as (
      type: string,
      payload: unknown
    ) => Promise<unknown>;
    h.records[0].request.mockImplementation(async (type: string, payload: unknown) =>
      type === 'worker.stop' ? { stopped: false } : original(type, payload)
    );
    h.events.length = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await h.manager.stop('s1');
    } finally {
      warn.mockRestore();
    }
    expect(sequence(h.events)).toEqual(['session.stopped(no_active_turn)', 'status:idle']);
    expect(h.events.every((event) => event.requestId === turnId)).toBe(true);
  });
});

/**
 * dsh-rebase P1-1 — the four paths that start a chat engine (new, resume,
 * fork target, crash restart) all go through `createSlot`, which
 * `createDshChatSlot.test.ts` pins to the DSH host. Here: each path carries
 * the DSH identity (a `.dsh.json` stub, returned on create and handed back on
 * every reopen) and binds the session to `dsh` in its events and index writes.
 */
describe('WorkerManager P1-1: every spawn path runs on DSH', () => {
  const stubFor = (sessionId: string) =>
    norm(`/dsh-home/aiclient-sessions/aiclient-${sessionId}.dsh.json`);
  /** What the bridge reports: a new session's stub, or exactly the stub it was handed. */
  const dshBootstrap = (requested: string) => {
    const created = /^\/sessions\/(.+)\.jsonl$/.exec(requested);
    return { sessionFile: created ? stubFor(created[1]) : requested };
  };
  const EMPTY_LEAF = { activeEntryId: null, fileTailEntryId: null };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('[P1-1-new] spawns without an identity, then commits and announces the DSH stub', async () => {
    const h = createHarness({ bootstrapFile: dshBootstrap });

    const requestId = await create(h.manager, 's1');

    expect(h.createSlot).toHaveBeenCalledTimes(1);
    expect(h.createSlot.mock.calls[0][0]).not.toHaveProperty('sessionFile');
    expect(h.bindRuntimeIdentity).toHaveBeenCalledWith('s1', stubFor('s1'));
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'session.created',
        sessionId: 's1',
        requestId,
        payload: expect.objectContaining({ agent: 'dsh', runtimeIdentity: stubFor('s1') }),
      })
    );
  });

  it('[P1-1-resume] reopens the stub, commits it as DSH and announces DSH, cold and warm', async () => {
    const h = createHarness({ bootstrapFile: dshBootstrap });

    await h.manager.resumeSession({
      sessionId: 's1',
      sessionFile: stubFor('s1'),
      workspacePath: '/repo',
      ownerWebContentsId: 11,
    });

    expect(h.createSlot.mock.calls[0][0]).toMatchObject({
      logicalSessionId: 's1',
      sessionFile: stubFor('s1'),
      cwd: norm('/repo'),
    });
    expect(h.commitResumed).toHaveBeenLastCalledWith({
      sessionId: 's1',
      workspacePath: norm('/repo'),
      runtimeIdentity: stubFor('s1'),
      agent: 'dsh',
      piLeaf: EMPTY_LEAF,
    });
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'session.resumed',
        payload: expect.objectContaining({ agent: 'dsh', runtimeIdentity: stubFor('s1') }),
      })
    );

    // Warm: the slot is ready, so no spawn — but the same binding.
    h.events.length = 0;
    await h.manager.resumeSession({
      sessionId: 's1',
      sessionFile: stubFor('s1'),
      workspacePath: '/repo',
      ownerWebContentsId: 11,
    });
    expect(h.createSlot).toHaveBeenCalledTimes(1);
    expect(h.commitResumed).toHaveBeenCalledTimes(2);
    expect(h.commitResumed).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeIdentity: stubFor('s1'), agent: 'dsh' })
    );
    expect(h.events[0]).toMatchObject({ type: 'session.resumed', payload: { agent: 'dsh' } });
  });

  it('[E3-4-WARM-TURN] a warm resume in the middle of a turn the worker started says it is running (P1-7e problem 4)', async () => {
    const h = createHarness({ bootstrapFile: dshBootstrap });
    const resume = () =>
      h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: stubFor('s1'),
        workspacePath: '/repo',
        ownerWebContentsId: 11,
      });
    const lastStatus = () =>
      [...h.events].reverse().find((event) => event.type === 'session.status');
    const sleepTicks = () => new Promise((resolve) => setTimeout(resolve, 20));
    await resume();

    // A goal round: the worker opens it by itself, under its own turn id; Main
    // never sent it, so it has no active request of its own.
    const turn = 'dsh-turn-aiclient-s1-2';
    h.records[0].emit({
      type: 'session.status',
      sessionId: 's1',
      requestId: turn,
      payload: { status: 'running' },
    });
    await sleepTicks();

    // The window reloads and opens the chat again: warm, and mid-round.
    h.events.length = 0;
    await resume();
    expect(h.createSlot).toHaveBeenCalledTimes(1);
    expect(h.events[0]).toMatchObject({ type: 'session.resumed' });
    expect(h.events.at(-1)).toMatchObject({ type: 'session.status' });
    expect(lastStatus()).toMatchObject({
      sessionId: 's1',
      requestId: turn,
      payload: { status: 'running' },
    });

    // The round ends: the next warm resume is idle again.
    h.records[0].emit({ type: 'session.completed', sessionId: 's1', requestId: turn, payload: {} });
    h.records[0].emit({
      type: 'session.status',
      sessionId: 's1',
      requestId: turn,
      payload: { status: 'idle' },
    });
    await sleepTicks();
    h.events.length = 0;
    await resume();
    expect(lastStatus()).toMatchObject({ payload: { status: 'idle' } });
    expect(lastStatus()?.requestId).not.toBe(turn);
  });

  it('[P1-1-fork] opens the child stub in the target slot and indexes the fork as DSH', async () => {
    const h = createHarness({ bootstrapFile: dshBootstrap });
    await create(h.manager, 'source');
    const child = stubFor('child');
    const answer = h.records[0].request.getMockImplementation();
    h.records[0].request.mockImplementation(async (type: string, payload: unknown) => {
      if (type !== 'worker.fork') return answer?.(type, payload);
      return {
        logicalSessionId: 'source',
        sourceSessionFile: stubFor('source'),
        sessionFile: child,
        piSessionId: 'aiclient-child',
        workspacePath: norm('/repo'),
        leaf: EMPTY_LEAF,
        history: {
          logicalSessionId: 'source',
          sessionFile: child,
          workspacePath: norm('/repo'),
          page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
        },
      };
    });
    h.events.length = 0;

    const forked = await h.manager.forkSession({
      sourceSessionId: 'source',
      entryId: 'e1',
      sourceTitle: 'Source',
    });

    expect(h.createSlot).toHaveBeenCalledTimes(2);
    expect(h.createSlot.mock.calls[1][0]).toMatchObject({
      logicalSessionId: forked.session.sessionId,
      sessionFile: child,
      cwd: norm('/repo'),
    });
    expect(h.createForked).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeIdentity: child, agent: 'dsh' })
    );
    expect(forked.session.agent).toBe('dsh');
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'session.created',
        sessionId: forked.session.sessionId,
        payload: expect.objectContaining({ agent: 'dsh', runtimeIdentity: child }),
      })
    );
  });

  it('[P1-4b-fork-premint] mints the fork id before asking, so the child stub is named after it', async () => {
    const h = createHarness({ bootstrapFile: dshBootstrap });
    await create(h.manager, 'source');
    const answer = h.records[0].request.getMockImplementation();
    const asked: unknown[] = [];
    h.records[0].request.mockImplementation(async (type: string, payload: unknown) => {
      if (type !== 'worker.fork') return answer?.(type, payload);
      asked.push(payload);
      // The bridge names the child DSH session and its stub after the id it is handed.
      const child = stubFor(
        String((payload as { targetLogicalSessionId?: unknown }).targetLogicalSessionId)
      );
      return {
        logicalSessionId: 'source',
        sourceSessionFile: stubFor('source'),
        sessionFile: child,
        piSessionId: 'aiclient-child',
        workspacePath: norm('/repo'),
        leaf: EMPTY_LEAF,
        history: {
          logicalSessionId: 'source',
          sessionFile: child,
          workspacePath: norm('/repo'),
          page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
        },
      };
    });

    const forked = await h.manager.forkSession({
      sourceSessionId: 'source',
      entryId: 'e1',
      sourceTitle: 'Source',
    });

    const id = forked.session.sessionId;
    expect(id).toMatch(/^session-fork-[0-9a-f-]{36}$/);
    expect(asked).toEqual([
      { logicalSessionId: 'source', entryId: 'e1', targetLogicalSessionId: id },
    ]);
    expect(forked.session.runtimeIdentity).toBe(stubFor(id));
    expect(h.createSlot.mock.calls[1][0]).toMatchObject({
      logicalSessionId: id,
      sessionFile: stubFor(id),
    });
  });

  it('[P1-1-fork-refused] surfaces the bridge refusal and never spawns a target', async () => {
    const h = createHarness({ bootstrapFile: dshBootstrap });
    await create(h.manager, 'source');
    const answer = h.records[0].request.getMockImplementation();
    h.records[0].request.mockImplementation(async (type: string, payload: unknown) => {
      if (type !== 'worker.fork') return answer?.(type, payload);
      throw new WorkerSlotError(
        'WORKER_RPC_REMOTE_ERROR',
        'WORKER_DSH_UNSUPPORTED: fork is not bridged to the DSH engine yet',
        {
          code: 'WORKER_DSH_UNSUPPORTED',
          message: 'fork is not bridged to the DSH engine yet',
        }
      );
    });

    await expect(
      h.manager.forkSession({ sourceSessionId: 'source', entryId: 'e1', sourceTitle: 'Source' })
    ).rejects.toThrow(/WORKER_DSH_UNSUPPORTED/);
    expect(h.createSlot).toHaveBeenCalledTimes(1);
    expect(h.createForked).not.toHaveBeenCalled();
  });

  it('[P1-1-restart] a crashed DSH worker is reopened from its stub and its leaf commit succeeds', async () => {
    const h = createHarness({ bootstrapFile: dshBootstrap });
    await create(h.manager, 's1');
    h.events.length = 0;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      h.records[0].crash('host exited');

      await vi.waitFor(() =>
        expect(h.manager.getSlotSnapshots()[0]).toMatchObject({ state: 'ready', generation: 2 })
      );
      expect(h.createSlot).toHaveBeenCalledTimes(2);
      expect(h.createSlot.mock.calls[1][0]).toMatchObject({
        logicalSessionId: 's1',
        sessionFile: stubFor('s1'),
        generation: 2,
      });
      expect(h.commitPiLeaf).toHaveBeenCalledWith({
        sessionId: 's1',
        runtimeIdentity: stubFor('s1'),
        piLeaf: EMPTY_LEAF,
      });
      expect(h.events).toContainEqual(
        expect.objectContaining({
          type: 'session.resumed',
          payload: expect.objectContaining({ agent: 'dsh', runtimeIdentity: stubFor('s1') }),
        })
      );
      expect(h.events).toContainEqual(
        expect.objectContaining({
          type: 'session.history',
          payload: expect.objectContaining({ mode: 'refresh', runtimeIdentity: stubFor('s1') }),
        })
      );
    } finally {
      error.mockRestore();
    }
  });

  /**
   * P1-5 WM-01, done early: no spawn path hands the slot a model catalog. Its
   * `auth` half is plaintext provider keys the DSH host never reads, and the
   * host keeps the bootstrap payload for the life of the session. The static
   * half (no catalog reader left in WorkerManager) is in chatEngineDshOnly.
   */
  it('[P1-1-no-catalog] create, cold resume and crash restart spawn without a model catalog', async () => {
    const h = createHarness({ bootstrapFile: dshBootstrap });
    await create(h.manager, 's1');
    await h.manager.resumeSession({
      sessionId: 's2',
      sessionFile: stubFor('s2'),
      workspacePath: '/repo',
      ownerWebContentsId: 11,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      h.records[0].crash('host exited');
      await vi.waitFor(() =>
        expect(
          h.manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === 's1')
        ).toMatchObject({ state: 'ready', generation: 2 })
      );
    } finally {
      error.mockRestore();
    }
    expect(h.createSlot).toHaveBeenCalledTimes(3);
    for (const [options] of h.createSlot.mock.calls) {
      expect(options).not.toHaveProperty('modelCatalog');
    }
  });

  it('[P1-1-stop-watchdog] a stop the DSH host never settles restarts it from the same stub', async () => {
    vi.useFakeTimers();
    const h = createHarness({ bootstrapFile: dshBootstrap });
    await create(h.manager, 's1', 7);
    await h.manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go', ownerWebContentsId: 7 });
    h.records[0].emit({ type: 'session.status', sessionId: 's1', payload: { status: 'running' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await h.manager.stop('s1');
      await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS);

      await vi.waitFor(() => expect(h.records[0].dispose).toHaveBeenCalledWith('slot-replace'));
      await vi.waitFor(() =>
        expect(h.manager.getSlotSnapshots()[0]).toMatchObject({ state: 'ready', generation: 2 })
      );
      expect(h.createSlot.mock.calls[1][0]).toMatchObject({
        logicalSessionId: 's1',
        sessionFile: stubFor('s1'),
        generation: 2,
      });
      expect(h.events).toContainEqual(
        expect.objectContaining({ type: 'session.stopped', payload: { stopCause: 'forced' } })
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

/**
 * dsh-rebase P1-3c — the manager on one shared DSH host (decisions 020, 021,
 * 025). Every fake slot of a harness runs on the same `FakeHost`; `hostCrash`
 * ends all of their channels at once, the way a host exit does.
 */
describe('WorkerManager on one shared DSH host (P1-3c)', () => {
  const TERMINALS = ['session.completed', 'session.failed', 'session.stopped'];

  /** What one session was told, in order: statuses (with their reason), terminals, resumes. */
  function trace(events: Array<Record<string, unknown>>, sessionId: string): string[] {
    return events
      .filter(
        (event) =>
          event.sessionId === sessionId &&
          (TERMINALS.includes(String(event.type)) ||
            event.type === 'session.status' ||
            event.type === 'session.resumed')
      )
      .map((event) => {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (event.type === 'session.status') {
          return `status:${String(payload.status)}${payload.disconnectReason ? `/${String(payload.disconnectReason)}` : ''}`;
        }
        if (event.type === 'session.failed') {
          return `failed${payload.errorCode ? `(${String(payload.errorCode)})` : ''}`;
        }
        if (event.type === 'session.stopped') {
          return `stopped${payload.stopCause ? `(${String(payload.stopCause)})` : ''}`;
        }
        return String(event.type);
      });
  }

  function snapshot(h: ReturnType<typeof createHarness>, sessionId: string) {
    return h.manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === sessionId);
  }

  async function allReady(h: ReturnType<typeof createHarness>): Promise<void> {
    await vi.waitFor(() =>
      expect(h.manager.getSlotSnapshots().map((slot) => slot.state)).toEqual(
        h.manager.getSlotSnapshots().map(() => 'ready')
      )
    );
  }

  let processKill: ReturnType<typeof installKillTripwire>;
  let attempt = 0;
  const running = async (
    h: ReturnType<typeof createHarness>,
    sessionId: string,
    owner?: number
  ): Promise<string> => {
    attempt += 1;
    const turnId = await h.manager.send({
      sessionId,
      attemptId: `attempt-${attempt}`,
      text: 'go',
      ownerWebContentsId: owner,
    });
    const record = h.records.filter((candidate) => candidate.sessionId === sessionId).at(-1);
    record?.emit({ type: 'session.status', sessionId, payload: { status: 'running' } });
    return turnId;
  };

  beforeEach(() => {
    processKill = installKillTripwire();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    expect(processKill).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('[WMH-01] a host crash reopens every session in one batch: foreground, then mid-turn, then the rest', async () => {
    const h = createHarness({ host: true });
    // Created (and so crashed) in the reverse of the order they must reopen in.
    await create(h.manager, 'idle');
    await create(h.manager, 'busy');
    await create(h.manager, 'fg', 7);
    const turn = await running(h, 'busy');
    h.events.length = 0;
    h.createSlot.mockClear();

    h.hostCrash();
    // At once, before anything is reopened: a turn in flight is failed with
    // the host's code; everyone is disconnected.
    expect(trace(h.events, 'fg')).toEqual(['status:disconnected']);
    expect(trace(h.events, 'busy')).toEqual(['status:disconnected', 'failed(dsh_host_crashed)']);
    expect(trace(h.events, 'idle')).toEqual(['status:disconnected']);
    expect(h.events.find((event) => event.type === 'session.failed')?.requestId).toBe(turn);

    await allReady(h);
    // Recency alone would put `busy` first: it was used last.
    expect(h.createSlot.mock.calls.map(([options]) => options.logicalSessionId)).toEqual([
      'fg',
      'busy',
      'idle',
    ]);
    expect(h.host?.starts).toBe(1);
    expect(
      h.manager
        .getSlotSnapshots()
        .map((slot) => [slot.logicalSessionId, slot.generation, slot.restartAttempts])
    ).toEqual([
      ['idle', 2, 0],
      ['busy', 2, 0],
      ['fg', 2, 0],
    ]);
    for (const id of ['fg', 'busy', 'idle']) {
      expect(trace(h.events, id).slice(-2), id).toEqual(['session.resumed', 'status:idle']);
    }
    expect(h.manager.getStatus().state).toBe('ready');
  });

  it('[WMH-01b] crashes inside one minute never park a session on its own budget', async () => {
    const h = createHarness({ host: true, maxRestartAttempts: 2 });
    await create(h.manager, 's1', 7);
    await create(h.manager, 's2');
    for (let crash = 1; crash <= 3; crash += 1) {
      h.hostCrash();
      await allReady(h);
    }
    expect(
      h.manager
        .getSlotSnapshots()
        .map((slot) => [slot.state, slot.generation, slot.restartAttempts])
    ).toEqual([
      ['ready', 4, 0],
      ['ready', 4, 0],
    ]);
    expect(h.host?.starts).toBe(3);
  });

  it('[WMH-02] past the host budget every session waits in one error; a user open starts the host again', async () => {
    const h = createHarness({ host: true });
    await create(h.manager, 's1', 7);
    await create(h.manager, 's2');
    for (let crash = 1; crash <= DSH_HOST_RESTART_BUDGET.restarts; crash += 1) {
      h.hostCrash();
      await allReady(h);
    }
    expect(h.host?.starts).toBe(DSH_HOST_RESTART_BUDGET.restarts);

    h.hostCrash();
    await vi.waitFor(() =>
      expect(h.manager.getSlotSnapshots().map((slot) => slot.state)).toEqual(['error', 'error'])
    );
    for (const slot of h.manager.getSlotSnapshots()) {
      expect(slot.error).toMatch(/^dsh_host_unavailable: DSH_HOST_UNAVAILABLE/);
      expect(slot.restartAttempts).toBe(0);
    }
    // Decision 156: nothing reopens them now, so both leave "Active now".
    for (const sessionId of ['s1', 's2']) {
      expect(
        h.events.filter(
          (event) =>
            event.sessionId === sessionId &&
            event.type === 'session.status' &&
            (event.payload as { disconnectReason?: string }).disconnectReason === 'released'
        ),
        sessionId
      ).toHaveLength(1);
    }
    expect(h.manager.getStatus().state).toBe('degraded');
    expect(h.host?.starts).toBe(DSH_HOST_RESTART_BUDGET.restarts);

    // Every user open or retry may bring the host up once more.
    await expect(
      h.manager.resumeSession({
        sessionId: 's1',
        sessionFile: norm('/sessions/s1.jsonl'),
        workspacePath: '/repo',
        ownerWebContentsId: 7,
      })
    ).resolves.toMatch(/^resume-/);
    expect(snapshot(h, 's1')).toMatchObject({ state: 'ready' });
    expect(h.host?.starts).toBe(DSH_HOST_RESTART_BUDGET.restarts + 1);
    expect(h.host?.ensureHost).toHaveBeenLastCalledWith({ userInitiated: true });
  });

  it('[WMH-03] a session mid-turn at two host faults in a row is left in error; the others come back', async () => {
    const h = createHarness({ host: true });
    await create(h.manager, 's1', 7);
    await create(h.manager, 's2', 8);
    await running(h, 's1', 7);
    h.hostCrash();
    await allReady(h);
    await running(h, 's1', 7);
    h.hostCrash();

    await vi.waitFor(() =>
      expect(snapshot(h, 's2')).toMatchObject({ state: 'ready', generation: 3 })
    );
    expect(snapshot(h, 's1')).toMatchObject({ state: 'error', restartAttempts: 0 });
    expect(snapshot(h, 's1')?.error).toMatch(/^dsh_session_suspect: /);
    // Decision 156: the one left in error is released; the reopened one is not.
    const released = (sessionId: string) =>
      h.events.filter(
        (event) =>
          event.sessionId === sessionId &&
          event.type === 'session.status' &&
          (event.payload as { disconnectReason?: string }).disconnectReason === 'released'
      );
    expect(released('s1')).toHaveLength(1);
    expect(released('s2')).toHaveLength(0);

    // The user's retry clears it: a fresh entry, a clean record.
    await h.manager.resumeSession({
      sessionId: 's1',
      sessionFile: norm('/sessions/s1.jsonl'),
      workspacePath: '/repo',
      ownerWebContentsId: 7,
    });
    expect(snapshot(h, 's1')).toMatchObject({ state: 'ready', generation: 1 });
    // Idle at the next fault: that presence does not count.
    h.hostCrash();
    await allReady(h);
    expect(snapshot(h, 's1')).toMatchObject({ state: 'ready', generation: 2 });
  });

  it("[WMH-04] a reopen that fails for the session's own reason spends only its own budget", async () => {
    const h = createHarness({ host: true });
    await create(h.manager, 's1', 7);
    await create(h.manager, 's2');
    h.createSlot.mockClear();
    h.createSlot.mockImplementationOnce(async () => {
      throw Object.assign(
        new Error('dsh_session_missing: DSH session aiclient-s1 is not on disk'),
        {
          remoteError: {
            code: 'dsh_session_missing',
            message: 'DSH session aiclient-s1 is not on disk',
          },
        }
      );
    });
    h.hostCrash();
    await allReady(h);
    expect(h.createSlot.mock.calls.map(([options]) => options.logicalSessionId)).toEqual([
      's1',
      's2',
      's1',
    ]);
    expect(snapshot(h, 's1')).toMatchObject({ generation: 3, restartAttempts: 1 });
    expect(snapshot(h, 's2')).toMatchObject({ generation: 2, restartAttempts: 0 });
    expect(h.host?.starts).toBe(1);
  });

  it('[WMH-05] Stop ladder A: a channel that closes is reopened alone; the host is never restarted', async () => {
    vi.useFakeTimers();
    const h = createHarness({ host: true });
    await create(h.manager, 's1', 7);
    await create(h.manager, 's2', 8);
    await running(h, 's1', 7);
    h.events.length = 0;
    await h.manager.stop('s1');
    await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS);
    expect(trace(h.events, 's1').slice(0, 2)).toEqual(['stopped(forced)', 'status:idle']);
    await vi.waitFor(() =>
      expect(snapshot(h, 's1')).toMatchObject({ state: 'ready', generation: 2 })
    );
    expect(h.records[0].dispose).toHaveBeenCalledWith('slot-replace');
    expect(h.host?.restart).not.toHaveBeenCalled();
    expect(h.host?.starts).toBe(0);
    expect(snapshot(h, 's2')).toMatchObject({ state: 'ready', generation: 1 });
    expect(h.events.filter((event) => event.sessionId === 's2')).toEqual([]);
  });

  it('[WMH-06] Stop ladder B: a channel that never closes restarts the host once; the stuck session reopens first', async () => {
    vi.useFakeTimers();
    const h = createHarness({ host: true });
    await create(h.manager, 'stuck', 7);
    // Ends before `other` does, so the batch's order is not the crash order.
    await create(h.manager, 'quiet');
    await create(h.manager, 'other');
    await running(h, 'stuck', 7);
    const otherTurn = await running(h, 'other');
    // Neither the dispose ACK nor the channel close ever comes back.
    h.records[0].dispose.mockImplementation(async () => {
      h.records[0].slot.state = 'dispose-failed';
      throw new WorkerSlotError(
        'WORKER_EXIT_TIMEOUT',
        'Worker slot stuck did not exit within 3000ms'
      );
    });
    h.events.length = 0;
    h.createSlot.mockClear();

    await h.manager.stop('stuck');
    await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS);
    // T144: settled for the user at the watchdog, whatever follows.
    expect(trace(h.events, 'stuck').slice(0, 2)).toEqual(['stopped(forced)', 'status:idle']);

    await allReady(h);
    expect(trace(h.events, 'stuck')).toEqual([
      'stopped(forced)',
      'status:idle',
      'session.resumed',
      'status:idle',
    ]);
    expect(h.host?.restart).toHaveBeenCalledTimes(1);
    expect(h.host?.restart).toHaveBeenCalledWith('stuck-session', {});
    expect(h.records[0].forceKillNow).toHaveBeenCalledTimes(1);
    expect(h.createSlot.mock.calls.map(([options]) => options.logicalSessionId)).toEqual([
      'stuck',
      'other',
      'quiet',
    ]);
    // The others were restarted on purpose, and are told so.
    expect(trace(h.events, 'other')).toEqual([
      'status:disconnected/engine_restarted',
      'failed(dsh_engine_restarted)',
      'session.resumed',
      'status:idle',
    ]);
    expect(
      h.events.find((event) => event.type === 'session.failed' && event.sessionId === 'other')
        ?.requestId
    ).toBe(otherTurn);
    expect(trace(h.events, 'quiet')).toEqual([
      'status:disconnected/engine_restarted',
      'session.resumed',
      'status:idle',
    ]);
    // Only the stuck session pays: its own restart.
    expect(
      h.manager
        .getSlotSnapshots()
        .map((slot) => [slot.logicalSessionId, slot.generation, slot.restartAttempts])
    ).toEqual([
      ['stuck', 2, 1],
      ['quiet', 2, 0],
      ['other', 2, 0],
    ]);
    expect(h.host?.starts).toBe(1);
  });

  it('[WMH-06b] a session that wedges the host twice in a row is not reopened after the second restart', async () => {
    vi.useFakeTimers();
    const h = createHarness({ host: true, maxRestartAttempts: 5 });
    await create(h.manager, 'stuck', 7);
    await create(h.manager, 'other', 8);
    const wedge = () => {
      const record = h.records.filter((candidate) => candidate.sessionId === 'stuck').at(-1);
      record?.dispose.mockImplementation(async () => {
        if (record) record.slot.state = 'dispose-failed';
        throw new WorkerSlotError('WORKER_EXIT_TIMEOUT', 'did not exit');
      });
    };
    for (let round = 1; round <= 2; round += 1) {
      await running(h, 'stuck', 7);
      wedge();
      await h.manager.stop('stuck');
      await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS);
      await vi.waitFor(() => expect(snapshot(h, 'other')?.state).toBe('ready'));
      await vi.waitFor(() => expect(snapshot(h, 'stuck')?.state).not.toBe('restarting'));
    }
    expect(h.host?.restart).toHaveBeenCalledTimes(2);
    expect(snapshot(h, 'stuck')).toMatchObject({ state: 'error' });
    expect(snapshot(h, 'stuck')?.error).toMatch(/^dsh_session_suspect: /);
    expect(snapshot(h, 'other')).toMatchObject({ state: 'ready', generation: 3 });
  });

  /**
   * Decision 155 (decision 149 rule 6): the stuck agent keeps the host's
   * graceful stop from finishing, so before ladder B restarts the host every
   * other session with work under way is closed on its own channel, where
   * DSH saves what it streamed.
   */
  describe('ladder B closes the busy sessions first (decision 155)', () => {
    const recordOf = (h: ReturnType<typeof createHarness>, sessionId: string) => {
      const record = h.records.filter((candidate) => candidate.sessionId === sessionId).at(-1);
      if (!record) throw new Error(`no slot for ${sessionId}`);
      return record;
    };
    const wedge = (h: ReturnType<typeof createHarness>, sessionId: string) => {
      const record = recordOf(h, sessionId);
      record.dispose.mockImplementation(async () => {
        record.slot.state = 'dispose-failed';
        throw new WorkerSlotError('WORKER_EXIT_TIMEOUT', `${sessionId} did not exit within 3000ms`);
      });
    };
    /** What each named session's slot was when the host was asked to restart. */
    const slotsAtRestart = (h: ReturnType<typeof createHarness>, ids: string[]) => {
      const seen: Array<Record<string, string>> = [];
      const host = h.host;
      const restart = host?.restart.getMockImplementation();
      if (!host || !restart) throw new Error('harness has no host restart');
      host.restart.mockImplementation(async (...args: [string, { userInitiated?: boolean }?]) => {
        seen.push(Object.fromEntries(ids.map((id) => [id, recordOf(h, id).slot.state])));
        return restart(...args);
      });
      return seen;
    };
    const restarted = [
      'status:disconnected/engine_restarted',
      'failed(dsh_engine_restarted)',
      'session.resumed',
      'status:idle',
    ];

    it('[WMH-06c] every other busy session is asked at once; the idle one and the stuck one are not', async () => {
      vi.useFakeTimers();
      const h = createHarness({ host: true, capacity: 6 });
      await create(h.manager, 'stuck', 7);
      await create(h.manager, 'quiet');
      await create(h.manager, 'a');
      await create(h.manager, 'b');
      // No turn Main knows of, but the host's last pong calls it busy (a job).
      await create(h.manager, 'job');
      await running(h, 'stuck', 7);
      const aTurn = await running(h, 'a');
      await running(h, 'b');
      h.host?.busy.add(recordOf(h, 'job').channelId);
      // Each answer is held until the test lets it go: all three are asked
      // before any of them answers.
      const answers: Array<() => void> = [];
      for (const id of ['a', 'b', 'job']) {
        const record = recordOf(h, id);
        record.drain.mockImplementation(
          () =>
            new Promise((resolve) => {
              answers.push(() => {
                queueMicrotask(() => record.closeChannel());
                resolve({ disposed: true });
              });
            })
        );
      }
      wedge(h, 'stuck');
      const seen = slotsAtRestart(h, ['a', 'b', 'job', 'quiet']);
      h.events.length = 0;
      h.createSlot.mockClear();

      await h.manager.stop('stuck');
      await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS);
      expect(answers).toHaveLength(3);
      expect(h.host?.restart).not.toHaveBeenCalled();
      for (const id of ['a', 'b', 'job']) {
        expect(recordOf(h, id).request).toHaveBeenCalledWith(
          'worker.dispose',
          { reason: 'slot-replace' },
          { timeoutMs: HOST_RESTART_DRAIN_MS }
        );
      }
      expect(recordOf(h, 'stuck').drain).not.toHaveBeenCalled();
      expect(recordOf(h, 'quiet').drain).not.toHaveBeenCalled();

      for (const answer of answers) answer();
      await allReady(h);
      // Their channels closed ahead of the restart; the idle one went with the host.
      expect(seen).toEqual([{ a: 'crashed', b: 'crashed', job: 'crashed', quiet: 'running' }]);
      expect(h.host?.restart).toHaveBeenCalledTimes(1);
      expect(h.host?.restart).toHaveBeenCalledWith('stuck-session', {});
      // Told as before: an engine restart cut the turn, and the session came back.
      expect(trace(h.events, 'a')).toEqual(restarted);
      expect(trace(h.events, 'b')).toEqual(restarted);
      expect(
        h.events.find((event) => event.type === 'session.failed' && event.sessionId === 'a')
          ?.requestId
      ).toBe(aTurn);
      expect(trace(h.events, 'job')).toEqual(
        restarted.filter((line) => !line.startsWith('failed'))
      );
      expect(trace(h.events, 'quiet')).toEqual([
        'status:disconnected/engine_restarted',
        'session.resumed',
        'status:idle',
      ]);
      // One batch after the stuck session, the ones that were mid-turn first;
      // closing them early costs no session anything.
      expect(h.createSlot.mock.calls.map(([options]) => options.logicalSessionId)).toEqual([
        'stuck',
        'a',
        'b',
        'job',
        'quiet',
      ]);
      expect(
        h.manager
          .getSlotSnapshots()
          .map((slot) => [slot.logicalSessionId, slot.generation, slot.restartAttempts])
      ).toEqual([
        ['stuck', 2, 1],
        ['quiet', 2, 0],
        ['a', 2, 0],
        ['b', 2, 0],
        ['job', 2, 0],
      ]);
      expect(h.host?.starts).toBe(1);
    });

    it('[WMH-06d] the restart waits 3 s in all, not per session; one that hangs or fails holds nothing up', async () => {
      vi.useFakeTimers();
      const h = createHarness({ host: true, capacity: 6 });
      await create(h.manager, 'stuck', 7);
      for (const id of ['hang1', 'hang2', 'fails', 'ok']) await create(h.manager, id);
      await running(h, 'stuck', 7);
      for (const id of ['hang1', 'hang2', 'fails', 'ok']) await running(h, id);
      recordOf(h, 'hang1').drain.mockImplementation(() => new Promise(() => undefined));
      recordOf(h, 'hang2').drain.mockImplementation(() => new Promise(() => undefined));
      recordOf(h, 'fails').drain.mockRejectedValue(
        new WorkerSlotError('WORKER_RPC_REMOTE_ERROR', 'WORKER_DISPOSED: worker is disposed')
      );
      wedge(h, 'stuck');
      const seen = slotsAtRestart(h, ['hang1', 'hang2', 'fails', 'ok']);
      h.events.length = 0;

      await h.manager.stop('stuck');
      await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS);
      for (const id of ['hang1', 'hang2', 'fails', 'ok']) {
        expect(recordOf(h, id).drain, id).toHaveBeenCalledTimes(1);
      }
      // The one that answered is closed; the restart still waits for the rest.
      expect(recordOf(h, 'ok').slot.state).toBe('crashed');
      await vi.advanceTimersByTimeAsync(HOST_RESTART_DRAIN_MS - 1);
      expect(h.host?.restart).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.host?.restart).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([
        { hang1: 'running', hang2: 'running', fails: 'running', ok: 'crashed' },
      ]);

      await allReady(h);
      // Those it did not close went with the host, and read the same.
      for (const id of ['hang1', 'hang2', 'fails', 'ok']) {
        expect(trace(h.events, id), id).toEqual(restarted);
      }
      expect(h.host?.starts).toBe(1);
    });

    it('[WMH-06e] with nothing else under way the restart does not wait', async () => {
      vi.useFakeTimers();
      const h = createHarness({ host: true });
      await create(h.manager, 'stuck', 7);
      await create(h.manager, 'quiet');
      await running(h, 'stuck', 7);
      wedge(h, 'stuck');

      await h.manager.stop('stuck');
      await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS);
      expect(h.host?.restart).toHaveBeenCalledTimes(1);
      expect(recordOf(h, 'quiet').drain).not.toHaveBeenCalled();
      await allReady(h);
    });

    it('[WMH-lock-02] "Restart engine" on a locked session closes a busy session first as well', async () => {
      const h = createHarness({ host: true });
      await create(h.manager, 'busy', 8);
      const turn = await running(h, 'busy', 8);
      const seen = slotsAtRestart(h, ['busy']);
      h.events.length = 0;

      await h.manager.resumeSession({
        sessionId: 'locked',
        sessionFile: norm('/sessions/locked.jsonl'),
        workspacePath: '/repo',
        ownerWebContentsId: 7,
        forceTakeover: true,
      });

      expect(seen).toEqual([{ busy: 'crashed' }]);
      expect(h.host?.restart).toHaveBeenCalledWith('user', { userInitiated: true });
      await vi.waitFor(() =>
        expect(snapshot(h, 'busy')).toMatchObject({ state: 'ready', generation: 2 })
      );
      expect(trace(h.events, 'busy')).toEqual(restarted);
      expect(
        h.events.find((event) => event.type === 'session.failed' && event.sessionId === 'busy')
          ?.requestId
      ).toBe(turn);
    });
  });

  it('[WMH-07] app quit stops the host once instead of disposing each channel', async () => {
    const h = createHarness({ host: true });
    await create(h.manager, 's1', 7);
    await create(h.manager, 's2');
    const turn = await running(h, 's1', 7);
    h.events.length = 0;

    await h.manager.disposeAll('app-shutdown');

    expect(h.host?.shutdown).toHaveBeenCalledTimes(1);
    expect(h.host?.shutdown).toHaveBeenCalledWith('app-quit');
    for (const record of h.records) {
      expect(record.dispose).not.toHaveBeenCalled();
      expect(record.forceKillNow).toHaveBeenCalledTimes(1);
    }
    // The turn in flight is told first; nothing is reopened.
    expect(trace(h.events, 's1')).toEqual(['stopped(forced)', 'status:disconnected']);
    expect(h.events.every((event) => event.requestId === turn)).toBe(true);
    expect(h.createSlot).toHaveBeenCalledTimes(2);
    expect(h.manager.getSlotSnapshots()).toEqual([]);
    expect(h.manager.getStatus().state).toBe('stopped');

    // The deadline path SIGKILLs the host through its supervisor, after the slots.
    h.manager.forceKillAllNow();
    expect(h.host?.forceKillNow).toHaveBeenCalledTimes(1);
    for (const record of h.records) expect(record.forceKillNow).toHaveBeenCalledTimes(1);
  });

  it('[E6-37] invalidation tells every session it went (`released`), the one mid-turn after its forced stop', async () => {
    // P1-7e e6 (problem 37, decision 145): nothing reopens these sessions, and
    // an idle one used to go silently, so the renderer kept it in "Active now".
    const h = createHarness({ host: true });
    await create(h.manager, 'idle', 7);
    await create(h.manager, 'busy');
    const turn = await running(h, 'busy', 7);
    h.events.length = 0;

    await h.manager.invalidateAll();

    expect(trace(h.events, 'idle')).toEqual(['status:disconnected/released']);
    expect(trace(h.events, 'busy')).toEqual(['stopped(forced)', 'status:disconnected/released']);
    expect(
      h.events.filter((event) => event.sessionId === 'busy').every((e) => e.requestId === turn)
    ).toBe(true);
    // Never the capacity sentence or the engine-restart one: neither is true.
    expect(
      h.events.some((event) =>
        ['capacity_reclaimed', 'engine_restarted'].includes(
          String((event.payload as { disconnectReason?: string }).disconnectReason)
        )
      )
    ).toBe(false);
    expect(h.manager.getSlotSnapshots()).toEqual([]);
  });

  it('[E6-37] ending a conversation does not say `released`: the renderer unbinds it itself', async () => {
    const h = createHarness({ host: true });
    await create(h.manager, 's1', 7);
    h.events.length = 0;
    await h.manager.closeSession('s1');
    expect(trace(h.events, 's1')).not.toContain('status:disconnected/released');
  });

  it('[WMH-08] invalidation disposes every session, then stops the host', async () => {
    const h = createHarness({ host: true });
    await create(h.manager, 's1', 7);
    await create(h.manager, 's2');

    await h.manager.invalidateAll();

    expect(h.records[0].dispose).toHaveBeenCalledWith('slot-replace');
    expect(h.records[1].dispose).toHaveBeenCalledWith('slot-replace');
    expect(h.host?.shutdown).toHaveBeenCalledTimes(1);
    expect(h.host?.shutdown).toHaveBeenCalledWith('invalidate');
    const lastDispose = Math.max(
      ...h.records.map((record) => record.dispose.mock.invocationCallOrder[0])
    );
    expect(h.host?.shutdown.mock.invocationCallOrder[0]).toBeGreaterThan(lastDispose);
    expect(h.manager.getSlotSnapshots()).toEqual([]);

    // The next session brings up a fresh host.
    await create(h.manager, 's3', 7);
    expect(h.host?.starts).toBe(1);
    expect(snapshot(h, 's3')).toMatchObject({ state: 'ready' });
  });

  it('[WMH-09] a host that dies again mid-batch ends that batch; one more batch reopens the rest', async () => {
    const h = createHarness({ host: true });
    await create(h.manager, 's1', 7);
    await create(h.manager, 's2');
    await create(h.manager, 's3');
    const normal = h.createSlot.getMockImplementation();
    if (!normal) throw new Error('harness createSlot has no implementation');
    h.createSlot.mockClear();
    h.createSlot.mockImplementationOnce(normal).mockImplementationOnce(async () => {
      // The replacement dies while the second session bootstraps on it.
      h.hostCrash();
      throw new WorkerSlotError('WORKER_EXITED', 'Worker exited (code=null signal=SIGKILL)');
    });

    h.hostCrash();
    await allReady(h);

    // One host per exit, and no session reopened twice on the same host.
    expect(h.host?.starts).toBe(2);
    const reopened = h.createSlot.mock.calls.map(([options]) => String(options.logicalSessionId));
    expect(reopened).toHaveLength(5);
    expect(reopened.filter((id) => id === 's1')).toHaveLength(2);
    expect(new Set(reopened.slice(2))).toEqual(new Set(['s1', 's2', 's3']));
    for (const slot of h.manager.getSlotSnapshots()) expect(slot.restartAttempts).toBe(0);
  });

  it('[WMH-lock-01] "Restart engine" on a locked session restarts the host before reopening it', async () => {
    const h = createHarness({ host: true });
    await create(h.manager, 'other', 8);
    h.events.length = 0;
    h.createSlot.mockClear();

    await h.manager.resumeSession({
      sessionId: 'locked',
      sessionFile: norm('/sessions/locked.jsonl'),
      workspacePath: '/repo',
      ownerWebContentsId: 7,
      forceTakeover: true,
    });

    expect(h.host?.restart).toHaveBeenCalledTimes(1);
    expect(h.host?.restart).toHaveBeenCalledWith('user', { userInitiated: true });
    expect(h.host?.restart.mock.invocationCallOrder[0]).toBeLessThan(
      h.createSlot.mock.invocationCallOrder[0]
    );
    expect(trace(h.events, 'other')[0]).toBe('status:disconnected/engine_restarted');
    await vi.waitFor(() =>
      expect(snapshot(h, 'other')).toMatchObject({ state: 'ready', generation: 2 })
    );
    expect(h.createSlot.mock.calls.map(([options]) => options.logicalSessionId)).toEqual([
      'locked',
      'other',
    ]);
    expect(snapshot(h, 'locked')).toMatchObject({ state: 'ready' });
    // A user's restart spends none of the host budget.
    expect(h.host?.faults).toEqual([]);
  });

  it('[WMH-11] a user open the host cannot serve fails with dsh_host_unavailable', async () => {
    const h = createHarness({ host: true });
    h.host?.ensureHost.mockRejectedValueOnce(
      new DshHostSupervisorError('DSH_HOST_START_FAILED', 'the DSH host refused to start: boom')
    );
    await expect(create(h.manager, 's1', 7)).rejects.toMatchObject({
      code: 'dsh_host_unavailable',
      message: expect.stringContaining('DSH_HOST_START_FAILED'),
    });
    expect(h.manager.getSlotSnapshots()).toEqual([]);
    // Nothing is left behind: the next open works.
    await expect(create(h.manager, 's1', 7)).resolves.toMatch(/^create-/);
  });

  it('[WMH-12] a crash of one channel on a live host stays that session’s own restart', async () => {
    const h = createHarness({ host: true });
    await create(h.manager, 's1', 7);
    await create(h.manager, 's2');
    h.events.length = 0;
    h.records[0].crash('Worker exited (code=0 signal=null)', {
      code: 0,
      signal: null,
      cause: 'channel-closed',
    });
    expect(trace(h.events, 's1')).toEqual(['status:disconnected']);
    await vi.waitFor(() =>
      expect(snapshot(h, 's1')).toMatchObject({ state: 'ready', generation: 2 })
    );
    expect(snapshot(h, 's1')?.restartAttempts).toBe(1);
    expect(snapshot(h, 's2')).toMatchObject({ state: 'ready', generation: 1 });
    expect(h.host?.starts).toBe(0);
  });
});

/**
 * dsh-rebase P1-3d — the shared host's housekeeping as WorkerManager drives
 * it: sessions the host reports busy are never reclaimed (decision 025), one
 * orphan collection per run (decision 024, GC-03), and a channel that will
 * not close on close / eviction releases its lock by a host restart when
 * nothing else is running (decision 074's leftover).
 */
describe('WorkerManager on one shared DSH host: housekeeping (P1-3d)', () => {
  let processKill: ReturnType<typeof installKillTripwire>;
  let warn: ReturnType<typeof vi.spyOn>;
  let attempt = 0;

  beforeEach(() => {
    processKill = installKillTripwire();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    expect(processKill).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Statuses (with their reason) and resumes one session was told. */
  function said(h: ReturnType<typeof createHarness>, sessionId: string): string[] {
    return h.events
      .filter((event) => event.sessionId === sessionId)
      .filter((event) => event.type === 'session.status' || event.type === 'session.resumed')
      .map((event) => {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        return event.type === 'session.status'
          ? `status:${String(payload.status)}${payload.disconnectReason ? `/${String(payload.disconnectReason)}` : ''}`
          : String(event.type);
      });
  }

  async function running(h: ReturnType<typeof createHarness>, sessionId: string) {
    attempt += 1;
    await h.manager.send({ sessionId, attemptId: `attempt-${attempt}`, text: 'go' });
    const record = h.records.filter((candidate) => candidate.sessionId === sessionId).at(-1);
    record?.emit({ type: 'session.status', sessionId, payload: { status: 'running' } });
  }

  /** The slot of `record` answers neither its dispose nor its close. */
  function wedge(record: FakeSlotRecord): void {
    record.dispose.mockImplementation(async () => {
      record.slot.state = 'dispose-failed';
      throw new WorkerSlotError('WORKER_EXIT_TIMEOUT', 'Worker slot did not exit within 3000ms');
    });
  }

  it('[P1-3d-busy] a session the host reports busy (a background job) is never evicted', async () => {
    const h = createHarness({ host: true, capacity: 2 });
    await create(h.manager, 'job');
    await create(h.manager, 'quiet');
    // `job` was used first, so plain recency would pick it.
    h.host?.busy.add(h.records[0].channelId);
    await create(h.manager, 'third');
    expect(said(h, 'quiet')).toContain('status:disconnected/capacity_reclaimed');
    expect(said(h, 'job')).not.toContain('status:disconnected/capacity_reclaimed');
    expect(
      h.manager
        .getSlotSnapshots()
        .map((slot) => slot.logicalSessionId)
        .sort()
    ).toEqual(['job', 'third']);
    h.host?.busy.add(h.records[2].channelId);
    await expect(create(h.manager, 'fourth')).rejects.toMatchObject({
      code: 'worker_capacity_reached',
    });
  });

  it('[GC-03] collects once per run, a delay after the first open, with what the index claims', async () => {
    vi.useFakeTimers();
    const collectSessions = vi.fn(async () => ({
      host: 'gc-result',
      id: 1,
      ok: true,
      deleted: ['aiclient-orphan'],
      stubsDeleted: 1,
      skipped: { claimed: 2, content: 1 },
      ms: 3,
    }));
    const h = createHarness({
      host: true,
      collectSessions,
      orphanCollectionDelayMs: 5_000,
      listIndexedSessions: async () =>
        [
          { sessionId: 's1', runtimeIdentity: '/dsh/aiclient-sessions/aiclient-s1.dsh.json' },
          { sessionId: 'old', runtimeIdentity: '/pi/sessions/old.jsonl' },
        ] as SessionIndexEntry[],
      readDshStub: async () => ({ dshSessionId: 'aiclient-s1', lineage: ['aiclient-s1-seed'] }),
    });
    await create(h.manager, 's1');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(collectSessions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(collectSessions).toHaveBeenCalledTimes(1);
    const [request] = collectSessions.mock.calls[0] as unknown as [
      { claimed: string[]; graceMs: number },
    ];
    expect(request.graceMs).toBe(24 * 60 * 60_000);
    expect(request.claimed.sort()).toEqual(['aiclient-old', 'aiclient-s1', 'aiclient-s1-seed']);
    await vi.advanceTimersByTimeAsync(0);
    // Deleting user data is always on record.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('deleted 1 session(s) and 1 stub(s), left claimed 2, content 1')
    );
    await create(h.manager, 's2');
    h.hostCrash();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(collectSessions).toHaveBeenCalledTimes(1);
  });

  it('[GC-03] waits while the host is not ready; the next open arms it again', async () => {
    vi.useFakeTimers();
    const collectSessions = vi.fn(async () => ({
      host: 'gc-result',
      id: 1,
      ok: true,
      deleted: [],
      stubsDeleted: 0,
      skipped: {},
      ms: 1,
    }));
    const h = createHarness({ host: true, collectSessions, orphanCollectionDelayMs: 1_000 });
    await create(h.manager, 's1');
    if (h.host) h.host.state = 'restarting';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(collectSessions).not.toHaveBeenCalled();
    if (h.host) h.host.state = 'ready';
    await create(h.manager, 's2');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(collectSessions).toHaveBeenCalledTimes(1);
  });

  it('[GC-03] a failed index read sends nothing, and the run does not try again', async () => {
    vi.useFakeTimers();
    const collectSessions = vi.fn();
    const h = createHarness({
      host: true,
      collectSessions,
      orphanCollectionDelayMs: 0,
      listIndexedSessions: async () => {
        throw new Error('index unreadable');
      },
    });
    await create(h.manager, 's1');
    await vi.advanceTimersByTimeAsync(10);
    await create(h.manager, 's2');
    await vi.advanceTimersByTimeAsync(10);
    expect(collectSessions).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('index unreadable'));
  });

  it('[P1-3d-stuck] a close whose channel never closes restarts the host when nothing else runs', async () => {
    const h = createHarness({ host: true });
    await create(h.manager, 'stuck');
    await create(h.manager, 'idle', 7);
    wedge(h.records[0]);
    h.events.length = 0;
    await h.manager.closeSession('stuck');
    expect(h.host?.restart).toHaveBeenCalledTimes(1);
    expect(h.host?.restart).toHaveBeenCalledWith('stuck-session', {});
    expect(h.records[0].forceKillNow).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(said(h, 'idle')).toEqual([
        'status:disconnected/engine_restarted',
        'session.resumed',
        'status:idle',
      ])
    );
    expect(h.manager.getSlotSnapshots().map((slot) => [slot.logicalSessionId, slot.state])).toEqual(
      [['idle', 'ready']]
    );
    expect(h.manager.getStatus().state).toBe('ready');
  });

  it('[P1-3d-stuck] with a turn elsewhere, a busy session or no budget, the lock waits for the next restart', async () => {
    for (const blocker of ['turn', 'busy', 'budget'] as const) {
      const h = createHarness({ host: true });
      await create(h.manager, 'stuck');
      await create(h.manager, 'other');
      if (blocker === 'turn') await running(h, 'other');
      if (blocker === 'busy') h.host?.busy.add(h.records[1].channelId);
      if (blocker === 'budget' && h.host) {
        h.host.faults = Array.from({ length: DSH_HOST_RESTART_BUDGET.restarts }, () => Date.now());
      }
      wedge(h.records[0]);
      await expect(h.manager.closeSession('stuck'), blocker).rejects.toMatchObject({
        code: 'WORKER_EXIT_TIMEOUT',
      });
      expect(h.host?.restart, blocker).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('stay until the next engine restart')
      );
      expect(snapshot(h, 'other'), blocker).toMatchObject({ state: 'ready', generation: 1 });
    }
  });

  it('[P1-3d-stuck] an eviction whose channel never closes restarts the host, then the new session opens', async () => {
    const h = createHarness({ host: true, capacity: 2 });
    await create(h.manager, 'stuck');
    await create(h.manager, 'fg', 7);
    wedge(h.records[0]);
    await create(h.manager, 'new', 8);
    expect(h.host?.restart).toHaveBeenCalledWith('stuck-session', {});
    expect(said(h, 'stuck')).toContain('status:disconnected/capacity_reclaimed');
    await vi.waitFor(() =>
      expect(
        h.manager
          .getSlotSnapshots()
          .map((slot) => [slot.logicalSessionId, slot.state])
          .sort()
      ).toEqual([
        ['fg', 'ready'],
        ['new', 'ready'],
      ])
    );
  });

  function snapshot(h: ReturnType<typeof createHarness>, sessionId: string) {
    return h.manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === sessionId);
  }
});

describe('WorkerManager — a host on an older model plan (dsh-rebase P1-5a, decision 033 rule 4)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[WM-plan-01] restarts an idle host whose plan revision is not Main's", async () => {
    const h = createHarness({ host: true });
    if (!h.host) throw new Error('no host');
    h.host.planRevision = 'rev-a';
    await create(h.manager, 's1', 7);
    h.manager.reconcileModelPlan('rev-a');
    await Promise.resolve();
    expect(h.host.shutdown).not.toHaveBeenCalled();
    h.manager.reconcileModelPlan('rev-b');
    await vi.waitFor(() => expect(h.host?.shutdown).toHaveBeenCalledWith('invalidate'));
    expect(h.records[0].dispose).toHaveBeenCalledWith('slot-replace');
  });

  it('[WM-plan-02] waits for the turn in flight, then restarts', async () => {
    vi.useFakeTimers();
    const h = createHarness({ host: true });
    if (!h.host) throw new Error('no host');
    h.host.planRevision = 'rev-a';
    await create(h.manager, 's1', 7);
    const turnId = await h.manager.send({
      sessionId: 's1',
      attemptId: 'a1',
      text: 'still working',
      ownerWebContentsId: 7,
    });
    h.manager.reconcileModelPlan('rev-b');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.host.shutdown).not.toHaveBeenCalled();
    h.records[0].emit({
      type: 'session.completed',
      sessionId: 's1',
      requestId: turnId,
      payload: {},
    });
    h.records[0].emit({
      type: 'session.status',
      sessionId: 's1',
      requestId: turnId,
      payload: { status: 'idle' },
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(h.host.shutdown).toHaveBeenCalledWith('invalidate');
  });

  it('[WM-plan-04] waits for the one-shot completions on the host, then restarts (P1-15)', async () => {
    vi.useFakeTimers();
    const h = createHarness({ host: true });
    if (!h.host) throw new Error('no host');
    h.host.planRevision = 'rev-a';
    await create(h.manager, 's1', 7);
    // A code review streaming on the host: no session is busy, but the host is.
    h.host.completions = 1;
    h.manager.reconcileModelPlan('rev-b');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.host.shutdown).not.toHaveBeenCalled();
    h.host.completions = 0;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(h.host.shutdown).toHaveBeenCalledWith('invalidate');
  });

  it('[WM-plan-03] leaves a host that is not running alone, and forgets a pending restart it no longer needs', async () => {
    vi.useFakeTimers();
    const h = createHarness({ host: true });
    if (!h.host) throw new Error('no host');
    h.host.state = 'idle';
    h.manager.reconcileModelPlan('rev-b');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.host.shutdown).not.toHaveBeenCalled();
    // Busy on rev-a, then Main's plan goes back to rev-a: nothing to do.
    h.host.state = 'ready';
    h.host.planRevision = 'rev-a';
    h.host.busy.add('c1-1');
    await create(h.manager, 's1', 7);
    h.manager.reconcileModelPlan('rev-b');
    h.manager.reconcileModelPlan('rev-a');
    h.host.busy.clear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.host.shutdown).not.toHaveBeenCalled();
  });
});

describe('WorkerManager — a host on another plugin selection (dsh-rebase P1-10b, decision 108 rule 7)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('[WM-plugins-01] restarts an idle host launched with another selection', async () => {
    const h = createHarness({ host: true });
    if (!h.host) throw new Error('no host');
    h.host.pluginSelection = 'default';
    await create(h.manager, 's1', 7);
    h.manager.reconcileHostPlugins('default');
    await Promise.resolve();
    expect(h.host.shutdown).not.toHaveBeenCalled();
    h.manager.reconcileHostPlugins('["dsh-a"]');
    await vi.waitFor(() => expect(h.host?.shutdown).toHaveBeenCalledWith('invalidate'));
    expect(h.records[0].dispose).toHaveBeenCalledWith('slot-replace');
  });

  it('[WM-plugins-02] waits for the turn in flight, then restarts', async () => {
    vi.useFakeTimers();
    const h = createHarness({ host: true });
    if (!h.host) throw new Error('no host');
    h.host.pluginSelection = 'default';
    await create(h.manager, 's1', 7);
    const turnId = await h.manager.send({
      sessionId: 's1',
      attemptId: 'a1',
      text: 'still working',
      ownerWebContentsId: 7,
    });
    h.manager.reconcileHostPlugins('["dsh-a"]');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.host.shutdown).not.toHaveBeenCalled();
    h.records[0].emit({
      type: 'session.completed',
      sessionId: 's1',
      requestId: turnId,
      payload: {},
    });
    h.records[0].emit({
      type: 'session.status',
      sessionId: 's1',
      requestId: turnId,
      payload: { status: 'idle' },
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(h.host.shutdown).toHaveBeenCalledWith('invalidate');
    expect(h.host.shutdown).toHaveBeenCalledTimes(1);
  });

  it('[WM-plugins-03] leaves a host that is not running alone, and forgets a change reverted before idle', async () => {
    vi.useFakeTimers();
    const h = createHarness({ host: true });
    if (!h.host) throw new Error('no host');
    h.host.state = 'idle';
    h.manager.reconcileHostPlugins('["dsh-a"]');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.host.shutdown).not.toHaveBeenCalled();
    h.host.state = 'ready';
    h.host.pluginSelection = 'default';
    h.host.busy.add('c1-1');
    await create(h.manager, 's1', 7);
    h.manager.reconcileHostPlugins('["dsh-a"]');
    h.manager.reconcileHostPlugins('default');
    h.host.busy.clear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.host.shutdown).not.toHaveBeenCalled();
  });

  /**
   * P1-7e e5 (problem 29, decision 143): "restarts on its own" is a restart,
   * not only a stop. The host comes back at once, with no session on it, so
   * its `ready` reports what the new selection loaded and the settings page
   * can show it before the next chat.
   */
  it('[WM-plugins-05] starts the host again at once, with no session on it (P1-7e e5)', async () => {
    const h = createHarness({ host: true });
    if (!h.host) throw new Error('no host');
    h.host.pluginSelection = 'default';
    await create(h.manager, 's1', 7);
    const starts = h.host.starts;
    const ensures = h.host.ensureHost.mock.calls.length;
    h.manager.reconcileHostPlugins('["dsh-a"]');
    await vi.waitFor(() => expect(h.host?.starts).toBe(starts + 1));
    expect(h.host.shutdown).toHaveBeenCalledWith('invalidate');
    expect(h.host.state).toBe('ready');
    // One start, and not as a user action: it never lifts a failed supervisor.
    expect(h.host.ensureHost.mock.calls.slice(ensures)).toEqual([[]]);
    // The session went with the old host; none was opened on the new one.
    expect(h.records[0].dispose).toHaveBeenCalledWith('slot-replace');
    expect(h.records).toHaveLength(1);
  });

  it('[WM-plugins-06] a model plan change alone still leaves the host down until a session needs it', async () => {
    const h = createHarness({ host: true });
    if (!h.host) throw new Error('no host');
    h.host.planRevision = 'rev-a';
    await create(h.manager, 's1', 7);
    const ensures = h.host.ensureHost.mock.calls.length;
    h.manager.reconcileModelPlan('rev-b');
    await vi.waitFor(() => expect(h.host?.shutdown).toHaveBeenCalledWith('invalidate'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.host.ensureHost.mock.calls.length).toBe(ensures);
    expect(h.host.state).toBe('idle');
  });

  it('[WM-plugins-07] past the restart budget the host is left down, not failed by a start nobody asked for', async () => {
    const h = createHarness({ host: true });
    if (!h.host) throw new Error('no host');
    h.host.pluginSelection = 'default';
    await create(h.manager, 's1', 7);
    const now = Date.now();
    h.host.faults = [now, now, now, now];
    const ensures = h.host.ensureHost.mock.calls.length;
    h.manager.reconcileHostPlugins('["dsh-a"]');
    await vi.waitFor(() => expect(h.host?.shutdown).toHaveBeenCalledWith('invalidate'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.host.ensureHost.mock.calls.length).toBe(ensures);
    expect(h.host.state).toBe('idle');
  });

  it('[WM-plugins-04] one restart covers a stale plan and a stale selection together', async () => {
    vi.useFakeTimers();
    const h = createHarness({ host: true });
    if (!h.host) throw new Error('no host');
    h.host.planRevision = 'rev-a';
    h.host.pluginSelection = 'default';
    h.host.busy.add('c1-1');
    await create(h.manager, 's1', 7);
    h.manager.reconcileModelPlan('rev-b');
    h.manager.reconcileHostPlugins('["dsh-a"]');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.host.shutdown).not.toHaveBeenCalled();
    h.host.busy.clear();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(h.host.shutdown).toHaveBeenCalledTimes(1);
    expect(h.host.shutdown).toHaveBeenCalledWith('invalidate');
  });
});
