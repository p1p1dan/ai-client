import type { DshModelPlan, DshPlanRoute } from '@shared/dshModelPlan/types';
import { WORKER_RPC_PROTOCOL_VERSION, type WorkerRpcEvent } from '@shared/types/workerRpc';
import { describe, expect, it, vi } from 'vitest';
import type {
  ClaudeSdkEngineSource,
  ClaudeSdkPlanView,
  ClaudeSdkTransportInput,
} from '../claudeSdkEngine';
import { WorkerManager, WorkerManagerError, type WorkerManagerHost } from '../WorkerManager';
import { WorkerSlotError, type WorkerSlotLifecycleEvent } from '../WorkerSlot';
import type { WorkerTransport } from '../WorkerTransport';
import { normalizeWorkerPath } from '../workerSessionKey';

/**
 * Route B, S-1 (docs/plantree/plans/claude-sdk-engine/topics/s1-engine-selection.md
 * §3, Main): WorkerManager's SDK paths, with an injected engine source and a
 * fake slot factory that, unlike `WorkerManager.test.ts`'s, runs the
 * transport factory it is handed (into a fake opener: no process starts),
 * reports the slot before bootstrap and gives only DSH slots a host channel.
 *
 * Covers: creation through the chooser (with `engine`/`engineRoute` on
 * `session.created`), reopening on the stub's engine and model, the
 * cross-route refusal before `worker.send`, a DSH host restart leaving SDK
 * chats alone, the idle and capacity guards, an SDK host exit's
 * `claude_engine_exited`, and the key-rotation release.
 */

const norm = (p: string) => normalizeWorkerPath(p);
const SDK_STUB = (id: string) => norm(`/cfg/aiclient-sessions/${id}.ccsdk.json`);
const DSH_FILE = (id: string) => norm(`/sessions/${id}.jsonl`);

function route(api: DshPlanRoute['api'], baseURL: string, apiKeyEnv: string): DshPlanRoute {
  return {
    api,
    baseURL,
    apiKeyEnv,
    defaultContextWindow: 200_000,
    defaultMaxTokens: 32_000,
    models: [],
  } as unknown as DshPlanRoute;
}

const PLAN: Pick<DshModelPlan, 'index' | 'routes' | 'refs'> = {
  index: {
    'claude/claude-opus-5': { route: 'claude', model: 'claude-opus-5', efforts: [], image: true },
    'claude/claude-sonnet-5': {
      route: 'claude',
      model: 'claude-sonnet-5',
      efforts: [],
      image: true,
    },
    'other/claude-haiku-5': { route: 'other', model: 'claude-haiku-5', efforts: [], image: true },
    // GLM on the OpenAI protocol: DSH.
    'zai/glm-5': { route: 'zai', model: 'glm-5', efforts: [], image: false },
    // GLM behind an Anthropic-compatible endpoint: the protocol decides, so the SDK engine.
    'zaia/glm-5': { route: 'zaia', model: 'glm-5', efforts: [], image: false },
  },
  routes: {
    claude: route('anthropic-messages', 'https://gw.example', 'AICLIENT_KEY_CLAUDE'),
    other: route('anthropic-messages', 'https://other.example', 'AICLIENT_KEY_OTHER'),
    zai: route('openai-completions', 'https://glm.example/v1', 'AICLIENT_KEY_ZAI'),
    zaia: route('anthropic-messages', 'https://glm.example/anthropic', 'AICLIENT_KEY_ZAIA'),
  },
  refs: {
    AICLIENT_KEY_CLAUDE: 'claude',
    AICLIENT_KEY_OTHER: 'other',
    AICLIENT_KEY_ZAI: 'zai',
    AICLIENT_KEY_ZAIA: 'zaia',
  },
};

interface Rec {
  sessionId: string;
  sdk: boolean;
  options: Record<string, unknown>;
  slot: { state: string; channelId?: string };
  request: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  emit(event: Record<string, unknown>): void;
  crash(exit: { code: number | null; signal: string | null; cause: string }): void;
  /** Methods this slot was asked, in order. */
  methods(): string[];
}

function createHarness(
  input: {
    capacity?: number;
    idleTimeoutMs?: number;
    stubs?: Record<string, unknown>;
    planRevision?: string;
  } = {}
) {
  let clock = 1_000;
  const records: Rec[] = [];
  const events: Array<Record<string, unknown>> = [];
  const keys: Record<string, string | undefined> = {
    claude: 'sk-claude-1',
    other: 'sk-other-1',
    zai: 'sk-zai-1',
    zaia: 'sk-zaia-1',
  };
  const sdk: { enabled: boolean; hostAvailable: boolean; plan: ClaudeSdkPlanView | null } = {
    enabled: true,
    hostAvailable: true,
    plan: PLAN,
  };
  const source: ClaudeSdkEngineSource = {
    enabled: () => sdk.enabled,
    plan: () => sdk.plan,
    key: (providerId) => keys[providerId],
    hostAvailable: () => sdk.hostAvailable,
  };
  const opened: ClaudeSdkTransportInput[] = [];
  const openTransport = vi.fn((launch: ClaudeSdkTransportInput) => {
    opened.push(launch);
    return { fake: 'sdk-transport' } as unknown as WorkerTransport;
  });

  const host = {
    state: 'ready' as string,
    generation: 1,
    busy: new Set<string>(),
    planRevision: input.planRevision,
  };
  const hostApi = {
    status: vi.fn(() => ({
      state: host.state,
      generation: host.generation,
      channels: 0,
      recentFaults: 0,
      lastPong: {
        at: 0,
        eldMaxMs: 0,
        rssMb: 100,
        channels: [...host.busy].map((ch) => ({ ch, busy: true })),
      },
      ...(host.state === 'ready' && host.planRevision ? { planRevision: host.planRevision } : {}),
      completions: 0,
    })),
    ensureHost: vi.fn(async () => {
      if (host.state !== 'ready') {
        host.generation += 1;
        host.state = 'ready';
      }
      return { generation: host.generation, pid: 4242 };
    }),
    restart: vi.fn(async (_reason: string) => {
      // The DSH host goes: every live channel ends with it; SDK processes do not.
      host.state = 'idle';
      for (const record of records.filter((r) => !r.sdk && r.slot.state === 'running')) {
        record.crash({ code: null, signal: 'SIGTERM', cause: 'host-exit' });
      }
      return hostApi.ensureHost();
    }),
    shutdown: vi.fn(async () => {
      host.state = 'idle';
    }),
    forceKillNow: vi.fn(() => true),
  };

  const createSlot = vi.fn(async (options: Record<string, unknown>) => {
    const generation = Number(options.generation ?? 1);
    const cwd = String(options.cwd);
    const createTransport = options.createTransport as
      | ((input: { generation: number; cwd: string }) => WorkerTransport)
      | undefined;
    const isSdk = createTransport !== undefined;
    if (isSdk) createTransport({ generation, cwd });
    else await hostApi.ensureHost();
    const sessionId = String(options.logicalSessionId);
    const sessionFile = String(
      options.sessionFile ?? (isSdk ? SDK_STUB(sessionId) : DSH_FILE(sessionId))
    );
    const onEvent = options.onEvent as (event: WorkerRpcEvent) => void;
    const onLifecycle = options.onLifecycle as (event: WorkerSlotLifecycleEvent) => void;
    const calls: string[] = [];
    const slotState: { state: string; channelId?: string } = {
      state: 'running',
      ...(isSdk ? {} : { channelId: `c-${records.length + 1}` }),
    };
    const request = vi.fn(async (type: string, payload: unknown) => {
      calls.push(type);
      if (type === 'worker.send') {
        return { accepted: true, requestId: (payload as { requestId: string }).requestId };
      }
      if (type === 'worker.history') {
        return {
          logicalSessionId: sessionId,
          sessionFile,
          workspacePath: cwd,
          page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
        };
      }
      if (type === 'worker.tree') {
        return {
          snapshot: {
            logicalSessionId: sessionId,
            sessionFile,
            workspacePath: cwd,
            leaf: { activeEntryId: null, fileTailEntryId: null },
            nodes: [],
            totalNodes: 0,
            returnedNodes: 0,
            truncated: false,
          },
        };
      }
      if (type === 'worker.dispose') {
        // A DSH channel answers, then the host closes it.
        if (!isSdk)
          queueMicrotask(() => record.crash({ code: 0, signal: null, cause: 'channel-closed' }));
        return { disposed: true };
      }
      if (type === 'worker.stop') return { stopped: true };
      if (type === 'worker.setPermissions' || type === 'worker.setPermissionGear')
        return { applied: true };
      if (type === 'worker.question.respond') return { handled: true };
      throw new Error(`unexpected request ${type}`);
    });
    const record: Rec = {
      sessionId,
      sdk: isSdk,
      options,
      slot: slotState,
      request,
      dispose: vi.fn(async () => {
        slotState.state = 'disposed';
      }),
      emit(event) {
        onEvent({
          protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
          kind: 'event',
          generation,
          type: 'runtime.event',
          payload: event,
        } as WorkerRpcEvent);
      },
      crash(exit) {
        if (slotState.state !== 'running') return;
        slotState.state = 'crashed';
        onLifecycle({
          type: 'crashed',
          slotKey: String(options.slotKey),
          generation,
          error: Object.assign(new Error('Worker exited'), { code: 'WORKER_EXITED' }),
          exit,
        } as WorkerSlotLifecycleEvent);
      },
      methods: () => [...calls],
    };
    records.push(record);
    const slot = Object.assign(slotState, {
      generation,
      pid: 5000 + records.length,
      pendingRequestCount: 0,
      remapSlotKey: vi.fn(),
      request,
      dispose: record.dispose,
      forceKillNow: vi.fn(() => {
        slotState.state = 'disposed';
        return true;
      }),
    });
    (options.onSlotCreated as ((slot: unknown) => void) | undefined)?.(slot);
    return {
      slot,
      bootstrap: {
        bootstrapped: true,
        logicalSessionId: sessionId,
        piSessionId: `pi-${sessionId}`,
        cwd,
        agentDir: '/agent',
        sessionFile,
        leaf: { activeEntryId: null, fileTailEntryId: null },
        ...(options.model ? { model: options.model } : {}),
        ...(options.sessionFile
          ? {
              initialHistory: {
                logicalSessionId: sessionId,
                sessionFile,
                workspacePath: cwd,
                page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
              },
            }
          : {}),
        projectTrusted: false,
        permissionGate: 'bundled',
      },
    };
  });

  const stubs = input.stubs ?? {};
  const commitResumed = vi.fn(async (_input: Record<string, unknown>) => undefined);
  const manager = new WorkerManager({
    createSlot: createSlot as never,
    host: hostApi as unknown as WorkerManagerHost,
    claudeSdk: source,
    openClaudeSdkTransport: openTransport,
    commitResumed: commitResumed as never,
    sessionFileExists: async () => true,
    readDshStub: async (file) => {
      if (Object.hasOwn(stubs, file)) return stubs[file];
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    },
    onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    capacity: input.capacity ?? 4,
    idleTimeoutMs: input.idleTimeoutMs ?? 0,
    idleSweepIntervalMs: 0,
    maxRestartAttempts: 2,
    orphanCollectionDelayMs: 60_000,
    now: () => clock,
    createToken: (() => {
      let token = 0;
      return () => `token-${++token}`;
    })(),
  });

  const latest = (sessionId: string) => {
    const found = records.filter((record) => record.sessionId === sessionId).at(-1);
    if (!found) throw new Error(`no slot for ${sessionId}`);
    return found;
  };
  const eventsOf = (type: string, sessionId?: string) =>
    events.filter(
      (event) => event.type === type && (sessionId === undefined || event.sessionId === sessionId)
    );
  const released = (sessionId: string) =>
    eventsOf('session.status', sessionId).filter(
      (event) => (event.payload as { disconnectReason?: string }).disconnectReason === 'released'
    );
  /** Everything queued on the lifecycle chain so far has run (a no-op serialized call). */
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await manager.reclaimIdle();
  };
  return {
    manager,
    records,
    events,
    keys,
    sdk,
    host,
    hostApi,
    opened,
    openTransport,
    createSlot,
    commitResumed,
    latest,
    eventsOf,
    released,
    settle,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function createSdk(
  h: ReturnType<typeof createHarness>,
  sessionId: string,
  model: string | undefined = 'claude/claude-opus-5'
) {
  await h.manager.createSession({
    sessionId,
    workspacePath: '/repo',
    ...(model ? { model } : {}),
  });
  const record = h.latest(sessionId);
  expect(record.sdk).toBe(true);
  return record;
}

async function createDsh(h: ReturnType<typeof createHarness>, sessionId: string) {
  await h.manager.createSession({ sessionId, workspacePath: '/repo', model: 'zai/glm-5' });
  const record = h.latest(sessionId);
  expect(record.sdk).toBe(false);
  return record;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerManagerError);
    return (error as WorkerManagerError).code;
  }
  throw new Error('expected a WorkerManagerError');
}

describe('WorkerManager on the Claude Agent SDK engine (route B, S-1)', () => {
  describe('creating a chat (decisions 1, 3, 9)', () => {
    it('runs a Claude model on its own SDK host with the plan’s gateway and the broker’s key', async () => {
      const h = createHarness();
      const record = await createSdk(h, 's1');
      expect(record.options).toMatchObject({ model: 'claude/claude-opus-5', userInitiated: true });
      expect(h.opened).toEqual([
        { generation: 1, cwd: norm('/repo'), baseURL: 'https://gw.example', apiKey: 'sk-claude-1' },
      ]);
      expect(h.hostApi.ensureHost).not.toHaveBeenCalled();
      const [created] = h.eventsOf('session.created', 's1');
      expect(created?.payload).toMatchObject({
        agent: 'dsh',
        runtimeIdentity: SDK_STUB('s1'),
        engine: 'claude-sdk',
        engineRoute: 'claude',
      });
    });

    it('a warm create of the same chat says the same', async () => {
      const h = createHarness();
      await createSdk(h, 's1');
      await h.manager.createSession({ sessionId: 's1', workspacePath: '/repo' });
      const created = h.eventsOf('session.created', 's1');
      expect(created).toHaveLength(2);
      expect(created[1]?.payload).toMatchObject({ engine: 'claude-sdk', engineRoute: 'claude' });
      expect(h.createSlot).toHaveBeenCalledTimes(1);
    });

    it('"automatic" starts the SDK host on the plan’s first model, named explicitly', async () => {
      const h = createHarness();
      const record = await createSdk(h, 's1', undefined);
      expect(record.options.model).toBe('claude/claude-opus-5');
    });

    it('a GLM on the Anthropic protocol runs on the SDK engine too', async () => {
      const h = createHarness();
      const record = await createSdk(h, 'glma', 'zaia/glm-5');
      expect(record.options.model).toBe('zaia/glm-5');
      expect(h.opened.at(-1)).toMatchObject({
        baseURL: 'https://glm.example/anthropic',
        apiKey: 'sk-zaia-1',
      });
      const payload = h.eventsOf('session.created', 'glma')[0]?.payload as Record<string, unknown>;
      expect(payload).toMatchObject({ engine: 'claude-sdk', engineRoute: 'zaia' });
    });

    it('GLM on the OpenAI protocol, the switch off, or no host in the build: a DSH chat that says nothing of engines', async () => {
      const h = createHarness();
      await createDsh(h, 'glm');
      h.sdk.enabled = false;
      await h.manager.createSession({
        sessionId: 'off',
        workspacePath: '/repo',
        model: 'claude/claude-opus-5',
      });
      h.sdk.enabled = true;
      h.sdk.hostAvailable = false;
      await h.manager.createSession({
        sessionId: 'nohost',
        workspacePath: '/repo',
        model: 'claude/claude-opus-5',
      });
      for (const id of ['glm', 'off', 'nohost']) {
        expect(h.latest(id).sdk, id).toBe(false);
        expect(h.latest(id).options).not.toHaveProperty('createTransport');
        const payload = h.eventsOf('session.created', id)[0]?.payload as Record<string, unknown>;
        expect(payload).not.toHaveProperty('engine');
        expect(payload).not.toHaveProperty('engineRoute');
      }
      expect(h.opened).toEqual([]);
    });

    it('no key for the route: claude_sdk_credentials_unavailable, and nothing started or kept', async () => {
      const h = createHarness();
      h.keys.claude = undefined;
      const code = await codeOf(
        h.manager.createSession({
          sessionId: 's1',
          workspacePath: '/repo',
          model: 'claude/claude-opus-5',
        })
      );
      expect(code).toBe('claude_sdk_credentials_unavailable');
      expect(h.createSlot).not.toHaveBeenCalled();
      expect(h.manager.getStatus().slots).toBe(0);
    });

    it('an SDK host that will not start sends the new chat to DSH (user ruling 2026-10-16)', async () => {
      const h = createHarness();
      h.createSlot.mockImplementationOnce(async (options: Record<string, unknown>) => {
        (options.createTransport as (input: unknown) => unknown)({ generation: 1, cwd: '/repo' });
        throw Object.assign(new Error('Worker exited before bootstrap'), { code: 'WORKER_EXITED' });
      });
      await h.manager.createSession({
        sessionId: 's1',
        workspacePath: '/repo',
        model: 'claude/claude-opus-5',
        effort: 'high',
      });
      expect(h.createSlot).toHaveBeenCalledTimes(2);
      const record = h.latest('s1');
      expect(record.sdk).toBe(false);
      expect(record.options).toMatchObject({ model: 'claude/claude-opus-5', effort: 'high' });
      expect(record.options).not.toHaveProperty('createTransport');
      const payload = h.eventsOf('session.created', 's1')[0]?.payload as Record<string, unknown>;
      expect(payload).not.toHaveProperty('engine');
      expect(h.manager.getStatus().slots).toBe(1);
      // A DSH chat now: a model of another route is no longer refused.
      await h.manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go', model: 'zai/glm-5' });
      expect(record.methods()).toEqual(['worker.send']);
    });

    it('a failed SDK slot that did not exit is force-killed before the DSH spawn', async () => {
      const h = createHarness();
      const forceKillNow = vi.fn(() => true);
      h.createSlot.mockImplementationOnce(async (options: Record<string, unknown>) => {
        (options.onSlotCreated as (slot: unknown) => void)({
          state: 'dispose-failed',
          generation: 1,
          forceKillNow,
        });
        throw Object.assign(new Error('Worker exited before bootstrap'), { code: 'WORKER_EXITED' });
      });
      await h.manager.createSession({
        sessionId: 's1',
        workspacePath: '/repo',
        model: 'claude/claude-opus-5',
      });
      expect(forceKillNow).toHaveBeenCalledTimes(1);
      expect(h.latest('s1').sdk).toBe(false);
      // The DSH slot runs on a generation of its own.
      expect(h.latest('s1').options.generation).toBe(2);
    });

    it('an SDK host that crashes during bootstrap: no disconnect, no restart, no crash left on the DSH chat', async () => {
      const h = createHarness();
      h.createSlot.mockImplementationOnce(async (options: Record<string, unknown>) => {
        (options.createTransport as (input: unknown) => unknown)({ generation: 1, cwd: '/repo' });
        // The order a real WorkerSlot reports a bootstrap crash in: the slot,
        // then `crashed`, then the rejection once it is disposed.
        const slot = { state: 'running', generation: 1, forceKillNow: vi.fn(() => true) };
        (options.onSlotCreated as (slot: unknown) => void)(slot);
        slot.state = 'crashed';
        (options.onLifecycle as (event: WorkerSlotLifecycleEvent) => void)({
          type: 'crashed',
          slotKey: String(options.slotKey),
          generation: 1,
          error: Object.assign(new Error('Worker exited (code=1 signal=null)'), {
            code: 'WORKER_EXITED',
          }),
          exit: { code: 1, signal: null },
        } as WorkerSlotLifecycleEvent);
        slot.state = 'disposed';
        throw Object.assign(new Error('Worker exited (code=1 signal=null)'), {
          code: 'WORKER_EXITED',
        });
      });
      await h.manager.createSession({
        sessionId: 's1',
        workspacePath: '/repo',
        model: 'claude/claude-opus-5',
      });
      await h.settle();
      expect(h.createSlot).toHaveBeenCalledTimes(2);
      expect(h.latest('s1').sdk).toBe(false);
      const statuses = h
        .eventsOf('session.status', 's1')
        .map((event) => (event.payload as { status: string }).status);
      expect(statuses).toEqual(['idle']);
      expect(h.manager.getStatus().state).toBe('ready');
      expect(h.manager.getSlotSnapshots()).toEqual([
        expect.objectContaining({ logicalSessionId: 's1', state: 'ready', error: null }),
      ]);
    });

    it('a reopened SDK chat whose host will not start still fails: its history is the CLI’s', async () => {
      const file = SDK_STUB('r1');
      const h = createHarness({ stubs: { [file]: { model: 'claude/claude-opus-5' } } });
      h.createSlot.mockImplementationOnce(async (options: Record<string, unknown>) => {
        (options.createTransport as (input: unknown) => unknown)({ generation: 1, cwd: '/repo' });
        throw Object.assign(new Error('Worker exited before bootstrap'), { code: 'WORKER_EXITED' });
      });
      const code = await codeOf(
        h.manager.resumeSession({ sessionId: 'r1', sessionFile: file, workspacePath: '/repo' })
      );
      expect(code).toBe('claude_sdk_host_unavailable');
      expect(h.createSlot).toHaveBeenCalledTimes(1);
    });
  });

  describe('reopening a chat (decision 2)', () => {
    it('reopens an SDK stub on the SDK engine with the stub’s model, whatever the switch says', async () => {
      const file = SDK_STUB('r1');
      const h = createHarness({ stubs: { [file]: { model: 'other/claude-haiku-5' } } });
      h.sdk.enabled = false;
      await h.manager.resumeSession({
        sessionId: 'r1',
        sessionFile: file,
        workspacePath: '/repo',
        // A DSH model the renderer still held: not one the SDK serves, so skipped.
        model: 'zai/glm-5',
      });
      const record = h.latest('r1');
      expect(record.sdk).toBe(true);
      expect(record.options).toMatchObject({ model: 'other/claude-haiku-5', sessionFile: file });
      expect(h.opened.at(-1)).toMatchObject({
        baseURL: 'https://other.example',
        apiKey: 'sk-other-1',
      });
      expect(h.eventsOf('session.resumed', 'r1')[0]?.payload).toMatchObject({
        engine: 'claude-sdk',
        engineRoute: 'other',
      });
      expect(h.commitResumed).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'r1', model: 'other/claude-haiku-5' })
      );
    });

    it('a DSH session file reopens on DSH, with no engine on its payload', async () => {
      const h = createHarness();
      await h.manager.resumeSession({
        sessionId: 'd1',
        sessionFile: DSH_FILE('d1'),
        workspacePath: '/repo',
        model: 'claude/claude-opus-5',
      });
      expect(h.latest('d1').sdk).toBe(false);
      expect(h.eventsOf('session.resumed', 'd1')[0]?.payload).not.toHaveProperty('engine');
    });

    it('nothing the SDK serves: claude_sdk_credentials_unavailable before anything starts', async () => {
      const h = createHarness();
      h.sdk.plan = {
        ...PLAN,
        index: { 'zai/glm-5': PLAN.index['zai/glm-5'] } as ClaudeSdkPlanView['index'],
      };
      const code = await codeOf(
        h.manager.resumeSession({
          sessionId: 'r1',
          sessionFile: SDK_STUB('r1'),
          workspacePath: '/repo',
        })
      );
      expect(code).toBe('claude_sdk_credentials_unavailable');
      expect(h.createSlot).not.toHaveBeenCalled();
    });

    it('a forced takeover of an SDK chat restarts no DSH host (decision 8)', async () => {
      const h = createHarness();
      await h.manager.resumeSession({
        sessionId: 'r1',
        sessionFile: SDK_STUB('r1'),
        workspacePath: '/repo',
        model: 'claude/claude-opus-5',
        forceTakeover: true,
      });
      expect(h.latest('r1').sdk).toBe(true);
      expect(h.hostApi.restart).not.toHaveBeenCalled();
    });
  });

  describe('switching models in a running SDK chat (decision 5)', () => {
    it('refuses a model of another engine or route before anything is sent or latched', async () => {
      const h = createHarness();
      const record = await createSdk(h, 's1');
      for (const model of ['zai/glm-5', 'other/claude-haiku-5', 'gone/claude-old']) {
        const code = await codeOf(
          h.manager.send({ sessionId: 's1', attemptId: `a-${model}`, text: 'hi', model })
        );
        expect(code, model).toBe('model_engine_mismatch');
      }
      expect(
        await codeOf(
          h.manager.retryLastTurn({ sessionId: 's1', attemptId: 'retry', model: 'zai/glm-5' })
        )
      ).toBe('model_engine_mismatch');
      expect(record.methods()).not.toContain('worker.send');
      // Nothing latched: the next send goes through.
      await h.manager.send({ sessionId: 's1', attemptId: 'ok', text: 'hi' });
      expect(record.methods()).toEqual(['worker.send']);
    });

    it('accepts a Claude model of its own route, and its own model without a plan', async () => {
      const h = createHarness();
      const record = await createSdk(h, 's1');
      const first = await h.manager.send({
        sessionId: 's1',
        attemptId: 'a1',
        text: 'hi',
        model: 'claude/claude-sonnet-5',
      });
      expect(record.request).toHaveBeenLastCalledWith(
        'worker.send',
        expect.objectContaining({ model: 'claude/claude-sonnet-5' })
      );
      record.emit({ type: 'session.completed', sessionId: 's1', requestId: first, payload: {} });
      h.sdk.plan = null;
      await h.manager.send({
        sessionId: 's1',
        attemptId: 'a2',
        text: 'hi',
        model: 'claude/claude-sonnet-5',
      });
      expect(record.methods().filter((method) => method === 'worker.send')).toHaveLength(2);
    });

    it('never limits a DSH chat', async () => {
      const h = createHarness();
      const record = await createDsh(h, 'd1');
      await h.manager.send({
        sessionId: 'd1',
        attemptId: 'a1',
        text: 'hi',
        model: 'claude/claude-opus-5',
      });
      expect(record.methods()).toEqual(['worker.send']);
    });
  });

  describe('cross-engine faults (decision 8)', () => {
    it('a DSH host restart closes the busy DSH channels first and leaves a busy SDK chat alone', async () => {
      const h = createHarness();
      const sdkRecord = await createSdk(h, 's1');
      const dshRecord = await createDsh(h, 'd1');
      const sdkTurn = await h.manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go' });
      await h.manager.send({ sessionId: 'd1', attemptId: 'a2', text: 'go' });
      // The session_locked card's "Restart engine" on another DSH chat.
      await h.manager.resumeSession({
        sessionId: 'd2',
        sessionFile: DSH_FILE('d2'),
        workspacePath: '/repo',
        forceTakeover: true,
      });
      expect(h.hostApi.restart).toHaveBeenCalledTimes(1);
      expect(dshRecord.methods()).toContain('worker.dispose');
      expect(sdkRecord.methods()).toEqual(['worker.send']);
      expect(sdkRecord.dispose).not.toHaveBeenCalled();
      expect(sdkRecord.slot.state).toBe('running');
      // Its turn is still Main's to finish.
      sdkRecord.emit({
        type: 'session.completed',
        sessionId: 's1',
        requestId: sdkTurn,
        payload: {},
      });
      expect(h.eventsOf('session.completed', 's1')).toHaveLength(1);
    });

    it('a busy SDK chat does not hold back the restart that frees a stuck DSH channel', async () => {
      const h = createHarness({ idleTimeoutMs: 1_000 });
      const sdkRecord = await createSdk(h, 's1');
      const dshRecord = await createDsh(h, 'd1');
      await h.manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go' });
      // The idle DSH chat is reclaimed, and its channel will not close.
      dshRecord.dispose.mockImplementation(async () => {
        dshRecord.slot.state = 'dispose-failed';
        throw new WorkerSlotError('WORKER_EXIT_TIMEOUT', 'd1 did not exit within 3000ms');
      });
      h.advance(5_000);
      await h.manager.reclaimIdle();
      // The restart only touches the DSH host, so the SDK turn is no reason to wait.
      expect(h.hostApi.restart).toHaveBeenCalledWith('stuck-session', {});
      expect(sdkRecord.dispose).not.toHaveBeenCalled();
      expect(sdkRecord.slot.state).toBe('running');
    });

    it('a DSH plan restart neither waits for nor releases a busy SDK chat', async () => {
      const h = createHarness({ planRevision: 'rev-1' });
      const sdkRecord = await createSdk(h, 's1');
      const dshRecord = await createDsh(h, 'd1');
      await h.manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go' });
      h.manager.reconcileModelPlan('rev-2');
      await h.settle();
      expect(h.hostApi.shutdown).toHaveBeenCalledWith('invalidate');
      expect(dshRecord.dispose).toHaveBeenCalled();
      expect(h.released('d1')).toHaveLength(1);
      expect(sdkRecord.dispose).not.toHaveBeenCalled();
      expect(h.released('s1')).toEqual([]);
    });

    it('the idle sweep keeps an SDK chat with a CLI-started turn or background tasks', async () => {
      const h = createHarness({ idleTimeoutMs: 1_000 });
      const record = await createSdk(h, 's1');
      // A turn the CLI started itself (a subagent's notification wakes it).
      record.emit({
        type: 'session.status',
        sessionId: 's1',
        requestId: 'engine-1',
        payload: { status: 'running' },
      });
      h.advance(5_000);
      await h.manager.reclaimIdle();
      expect(record.dispose).not.toHaveBeenCalled();
      // The turn ends, a background shell keeps running.
      record.emit({
        type: 'session.status',
        sessionId: 's1',
        requestId: 'engine-1',
        payload: { status: 'idle', backgroundTasks: 2 },
      });
      h.advance(5_000);
      await h.manager.reclaimIdle();
      expect(record.dispose).not.toHaveBeenCalled();
      // A status without a count leaves the last one standing.
      record.emit({ type: 'session.status', sessionId: 's1', payload: { status: 'idle' } });
      await h.manager.reclaimIdle();
      expect(record.dispose).not.toHaveBeenCalled();
      record.emit({
        type: 'session.status',
        sessionId: 's1',
        payload: { status: 'idle', backgroundTasks: 0 },
      });
      await h.manager.reclaimIdle();
      expect(record.dispose).toHaveBeenCalled();
      expect(h.released('s1')).toHaveLength(1);
    });

    it('capacity eviction skips an SDK chat with background tasks', async () => {
      const h = createHarness({ capacity: 1 });
      const record = await createSdk(h, 's1');
      record.emit({
        type: 'session.status',
        sessionId: 's1',
        payload: { status: 'idle', backgroundTasks: 1 },
      });
      expect(
        await codeOf(
          h.manager.createSession({ sessionId: 's2', workspacePath: '/repo', model: 'zai/glm-5' })
        )
      ).toBe('worker_capacity_reached');
      record.emit({
        type: 'session.status',
        sessionId: 's1',
        payload: { status: 'idle', backgroundTasks: 0 },
      });
      await h.manager.createSession({
        sessionId: 's2',
        workspacePath: '/repo',
        model: 'zai/glm-5',
      });
      expect(record.dispose).toHaveBeenCalled();
    });

    it('an SDK host exit mid-turn fails it as claude_engine_exited, not as a DSH host fault', async () => {
      const file = SDK_STUB('s1');
      const h = createHarness({ stubs: { [file]: { model: 'claude/claude-opus-5' } } });
      const record = await createSdk(h, 's1');
      const turn = await h.manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go' });
      record.crash({ code: 1, signal: null, cause: 'host-exit' });
      const [failed] = h.eventsOf('session.failed', 's1');
      expect(failed).toMatchObject({
        requestId: turn,
        payload: { errorCode: 'claude_engine_exited' },
      });
      expect(h.eventsOf('session.status', 's1').at(-1)?.payload).toEqual({
        status: 'disconnected',
      });
      await h.settle();
      // Reopened on its own, on a fresh SDK host with the key as of now.
      const reopened = h.latest('s1');
      expect(reopened).not.toBe(record);
      expect(reopened.sdk).toBe(true);
      expect(reopened.options).toMatchObject({ model: 'claude/claude-opus-5', sessionFile: file });
      expect(h.opened).toHaveLength(2);
      expect(h.hostApi.ensureHost).not.toHaveBeenCalled();
      expect(h.hostApi.restart).not.toHaveBeenCalled();
      expect(h.eventsOf('session.resumed', 's1').at(-1)?.payload).toMatchObject({
        engine: 'claude-sdk',
        engineRoute: 'claude',
      });
    });
  });

  describe('key and gateway rotation (decision 4)', () => {
    it('releases an idle SDK chat whose key changed, and keeps one whose did not', async () => {
      const h = createHarness();
      const s1 = await createSdk(h, 's1');
      const s2 = await createSdk(h, 's2', 'other/claude-haiku-5');
      h.manager.reconcileModelPlan('rev-1');
      await h.settle();
      expect(h.released('s1')).toEqual([]);
      h.keys.claude = 'sk-claude-2';
      h.manager.reconcileModelPlan('rev-1');
      await h.settle();
      expect(h.released('s1')).toHaveLength(1);
      expect(s1.dispose).toHaveBeenCalled();
      expect(h.released('s2')).toEqual([]);
      expect(s2.dispose).not.toHaveBeenCalled();
      // The renderer's next send reopens it (`session_not_found`).
      expect(await codeOf(h.manager.send({ sessionId: 's1', attemptId: 'a', text: 'x' }))).toBe(
        'session_not_found'
      );
    });

    it('a busy SDK chat is compared again at the next plan build', async () => {
      const h = createHarness();
      const record = await createSdk(h, 's1');
      const turn = await h.manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go' });
      h.keys.claude = 'sk-claude-2';
      h.manager.reconcileModelPlan('rev-1');
      await h.settle();
      expect(h.released('s1')).toEqual([]);
      expect(record.dispose).not.toHaveBeenCalled();
      record.emit({ type: 'session.completed', sessionId: 's1', requestId: turn, payload: {} });
      record.emit({
        type: 'session.status',
        sessionId: 's1',
        payload: { status: 'idle', backgroundTasks: 1 },
      });
      h.manager.reconcileModelPlan('rev-1');
      await h.settle();
      expect(h.released('s1')).toEqual([]);
      record.emit({
        type: 'session.status',
        sessionId: 's1',
        payload: { status: 'idle', backgroundTasks: 0 },
      });
      h.manager.reconcileModelPlan('rev-1');
      await h.settle();
      expect(h.released('s1')).toHaveLength(1);
    });

    it('a plan built while the only SDK chat is still spawning is checked once it is ready', async () => {
      const h = createHarness();
      h.openTransport.mockImplementationOnce((launch: ClaudeSdkTransportInput) => {
        h.opened.push(launch);
        // Mid-spawn, with the old key already read: a sync replaces the key and announces a plan.
        h.keys.claude = 'sk-claude-2';
        h.manager.reconcileModelPlan('rev-1');
        return { fake: 'sdk-transport' } as unknown as WorkerTransport;
      });
      await createSdk(h, 's1');
      await h.settle();
      expect(h.released('s1')).toHaveLength(1);
    });

    it('a route that left the plan or moved its gateway releases the chat too', async () => {
      const h = createHarness();
      await createSdk(h, 's1');
      await createSdk(h, 's2', 'other/claude-haiku-5');
      h.sdk.plan = {
        ...PLAN,
        routes: {
          ...PLAN.routes,
          claude: route('anthropic-messages', 'https://gw2.example', 'AICLIENT_KEY_CLAUDE'),
          other: route('openai-completions', 'https://other.example', 'AICLIENT_KEY_OTHER'),
        },
      };
      h.manager.reconcileModelPlan('rev-2');
      await h.settle();
      expect(h.released('s1')).toHaveLength(1);
      expect(h.released('s2')).toHaveLength(1);
    });
  });
});

describe('WorkerManager on the Claude Agent SDK engine: permission modes (route B, S-2)', () => {
  const posture = (record: Rec) => record.options.permissions;

  it('an SDK chat switches mode mid-turn, plan mode included, through the full setter (A-4)', async () => {
    const h = createHarness();
    const record = await createSdk(h, 's1');
    await h.manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go' });
    await h.manager.setPermissions('s1', { mode: 'plan', gear: 'auto' });
    expect(record.methods()).toEqual(['worker.send', 'worker.setPermissions']);
    expect(record.request).toHaveBeenLastCalledWith('worker.setPermissions', {
      logicalSessionId: 's1',
      permissions: { mode: 'plan', gear: 'auto' },
    });
  });

  it('a DSH chat keeps the mid-turn lock', async () => {
    const h = createHarness();
    await createDsh(h, 'd1');
    await h.manager.send({ sessionId: 'd1', attemptId: 'a1', text: 'go' });
    expect(await codeOf(h.manager.setPermissions('d1', { mode: 'plan', gear: 'auto' }))).toBe(
      'session_busy'
    );
  });

  it('a mode the engine refused reaches the caller with its code, and is not recorded (A-5)', async () => {
    const h = createHarness();
    const record = await createSdk(h, 's1');
    record.request.mockImplementationOnce(async () => {
      throw Object.assign(new Error('WORKER_PERMISSION_MODE_REFUSED: auto_mode_model'), {
        code: 'WORKER_RPC_REMOTE_ERROR',
      });
    });
    await expect(h.manager.setPermissions('s1', { mode: 'agent', gear: 'auto' })).rejects.toThrow(
      'WORKER_PERMISSION_MODE_REFUSED: auto_mode_model'
    );
    // A crash restart comes back on the mode the engine was last confirmed on, not the refused one.
    record.crash({ code: 1, signal: null, cause: 'exit' });
    await h.settle();
    expect(posture(h.latest('s1'))).toBeUndefined();
  });

  it('takes a mode change the engine made itself, from an SDK chat, and forwards it (A-6)', async () => {
    const h = createHarness();
    const record = await createSdk(h, 's1');
    record.emit({
      type: 'session.permissions',
      payload: { permissions: { mode: 'plan', gear: 'auto' }, cause: 'engine' },
    });
    expect(h.eventsOf('session.permissions', 's1').map((e) => e.payload)).toEqual([
      { permissions: { mode: 'plan', gear: 'auto' }, cause: 'engine' },
    ]);
    // It is what a crash restart re-applies.
    record.crash({ code: 1, signal: null, cause: 'exit' });
    await h.settle();
    expect(posture(h.latest('s1'))).toEqual({ mode: 'plan', gear: 'auto' });
  });

  it('drops an `engine` change from a DSH chat', async () => {
    const h = createHarness();
    const record = await createDsh(h, 'd1');
    record.emit({
      type: 'session.permissions',
      payload: { permissions: { mode: 'agent', gear: 'bypass' }, cause: 'engine' },
    });
    expect(h.eventsOf('session.permissions', 'd1')).toEqual([]);
  });

  it('answers a plan review only with a choice the card offered (A-7)', async () => {
    const h = createHarness();
    const record = await createSdk(h, 's1');
    record.emit({
      type: 'question.requested',
      payload: {
        questionId: 'q1',
        questions: [{ id: 'plan-review', header: 'Plan review', question: 'Plan', options: [] }],
        review: {
          kind: 'plan',
          source: 'exit_plan_mode',
          goalObjective: 'Plan',
          choices: ['run:accept-edits', 'run:ask', 'run:auto', 'run:bypass', 'keep-planning'],
        },
      },
    });
    // The worker reports the posture of the answer while it handles it (decision 169).
    const report = (permissions: Record<string, string>) =>
      record.request.mockImplementationOnce(async () => {
        record.emit({
          type: 'session.permissions',
          payload: { permissions, cause: 'plan-approved', questionId: 'q1' },
        });
        return { handled: true };
      });
    // A goal choice is not this card's: no posture is taken for it.
    report({ mode: 'agent', gear: 'auto' });
    await h.manager.respondQuestion({
      sessionId: 's1',
      questionId: 'q1',
      answers: { 'plan-review': 'goal:auto' },
    });
    expect(h.eventsOf('session.permissions', 's1')).toEqual([]);
    report({ mode: 'agent', gear: 'accept-edits' });
    await h.manager.respondQuestion({
      sessionId: 's1',
      questionId: 'q1',
      answers: { 'plan-review': 'run:accept-edits' },
    });
    expect(h.eventsOf('session.permissions', 's1').map((e) => e.payload)).toEqual([
      {
        permissions: { mode: 'agent', gear: 'accept-edits' },
        cause: 'plan-approved',
        questionId: 'q1',
      },
    ]);
  });

  it('a new chat that falls back to DSH leaves Auto for Manual, and says so (A-11)', async () => {
    const h = createHarness();
    h.createSlot.mockImplementationOnce(async (options: Record<string, unknown>) => {
      (options.createTransport as (input: unknown) => unknown)({ generation: 1, cwd: '/repo' });
      throw Object.assign(new Error('Worker exited before bootstrap'), { code: 'WORKER_EXITED' });
    });
    await h.manager.createSession({
      sessionId: 's1',
      workspacePath: '/repo',
      model: 'claude/claude-opus-5',
      permissions: { mode: 'agent', gear: 'auto' },
    });
    expect(h.latest('s1').sdk).toBe(false);
    expect(posture(h.latest('s1'))).toEqual({ mode: 'agent', gear: 'ask' });
    const order = h.events
      .filter((e) => e.sessionId === 's1')
      .map(
        (e) =>
          `${e.type}${e.type === 'session.permissions' ? `:${(e.payload as { cause: string }).cause}` : ''}`
      );
    expect(order).toContain('session.permissions:sync');
    expect(order.indexOf('session.permissions:sync')).toBeGreaterThan(
      order.indexOf('session.created')
    );
  });

  it('a fallback leaves Bypass permissions for Manual too (user ruling 2026-10-16)', async () => {
    // A new chat can start on bypass now (picked on the start screen); DSH's asks
    // for nothing at all, the SDK's still asks for a few dangerous calls.
    const h = createHarness();
    h.createSlot.mockImplementationOnce(async (options: Record<string, unknown>) => {
      (options.createTransport as (input: unknown) => unknown)({ generation: 1, cwd: '/repo' });
      throw Object.assign(new Error('Worker exited before bootstrap'), { code: 'WORKER_EXITED' });
    });
    await h.manager.createSession({
      sessionId: 's1',
      workspacePath: '/repo',
      model: 'claude/claude-opus-5',
      permissions: { mode: 'agent', gear: 'bypass' },
    });
    expect(h.latest('s1').sdk).toBe(false);
    expect(posture(h.latest('s1'))).toEqual({ mode: 'agent', gear: 'ask' });
    expect(
      h.eventsOf('session.permissions', 's1').map((e) => (e.payload as { cause: string }).cause)
    ).toEqual(['sync']);
  });

  it('a fallback keeps Manual and Plan as they were', async () => {
    for (const permissions of [
      { mode: 'agent', gear: 'ask' },
      { mode: 'plan', gear: 'auto' },
    ] as const) {
      const h = createHarness();
      h.createSlot.mockImplementationOnce(async (options: Record<string, unknown>) => {
        (options.createTransport as (input: unknown) => unknown)({ generation: 1, cwd: '/repo' });
        throw Object.assign(new Error('Worker exited before bootstrap'), { code: 'WORKER_EXITED' });
      });
      await h.manager.createSession({
        sessionId: 's1',
        workspacePath: '/repo',
        model: 'claude/claude-opus-5',
        permissions: { ...permissions },
      });
      expect(posture(h.latest('s1'))).toEqual(permissions);
      expect(h.eventsOf('session.permissions', 's1')).toEqual([]);
    }
  });
});

describe('WorkerManager on the Claude Agent SDK engine: review fixes (route B, S-2)', () => {
  const refusal = () =>
    new WorkerSlotError(
      'WORKER_RPC_REMOTE_ERROR',
      'WORKER_PERMISSION_MODE_REFUSED: auto_mode_model',
      { code: 'WORKER_PERMISSION_MODE_REFUSED', message: 'auto_mode_model', retryable: false }
    );
  const causes = (h: ReturnType<typeof createHarness>, id: string) =>
    h.eventsOf('session.permissions', id).map((e) => (e.payload as { cause: string }).cause);

  it('a warm open hands back the mode the engine changed to, not the window copy', async () => {
    const h = createHarness();
    const record = await createSdk(h, 's1');
    record.emit({
      type: 'session.permissions',
      payload: { permissions: { mode: 'plan', gear: 'ask' }, cause: 'engine' },
    });
    const before = record.methods().length;
    await h.manager.createSession({
      sessionId: 's1',
      workspacePath: '/repo',
      model: 'claude/claude-opus-5',
      permissions: { mode: 'agent', gear: 'ask' },
    });
    expect(record.methods().slice(before)).toEqual([]);
    expect(causes(h, 's1')).toEqual(['engine', 'sync']);
    expect(h.eventsOf('session.permissions', 's1').at(-1)?.payload).toMatchObject({
      permissions: { mode: 'plan', gear: 'ask' },
    });
  });

  it('a warm open whose stored mode the engine refuses opens anyway, on the mode the chat is in', async () => {
    const h = createHarness();
    const record = await createSdk(h, 's1');
    record.emit({
      type: 'session.permissions',
      payload: { permissions: { mode: 'agent', gear: 'ask' }, cause: 'engine' },
    });
    // A later choice of the user's clears the engine's claim...
    await h.manager.setPermissions('s1', { mode: 'agent', gear: 'accept-edits' });
    // ...and the window's copy is applied again on the next open, which the engine refuses.
    record.request.mockImplementationOnce(async () => {
      throw refusal();
    });
    await h.manager.createSession({
      sessionId: 's1',
      workspacePath: '/repo',
      model: 'claude/claude-opus-5',
      permissions: { mode: 'agent', gear: 'auto' },
    });
    expect(record.methods().at(-1)).toBe('worker.setPermissions');
    expect(h.eventsOf('session.permissions', 's1').at(-1)?.payload).toMatchObject({
      cause: 'sync',
      permissions: { mode: 'agent', gear: 'accept-edits' },
    });
    expect(h.eventsOf('session.created', 's1')).toHaveLength(2);
  });

  it('no mode switch while the conversation is being compacted', async () => {
    const h = createHarness();
    const record = await createSdk(h, 's1');
    let finish: (value: unknown) => void = () => undefined;
    record.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const compacting = h.manager.compactSession({ sessionId: 's1' }).catch(() => undefined);
    await h.settle();
    expect(await codeOf(h.manager.setPermissions('s1', { mode: 'agent', gear: 'auto' }))).toBe(
      'session_busy'
    );
    expect(record.methods()).not.toContain('worker.setPermissions');
    finish({ compacted: true });
    await compacting;
  });

  it('a fallback to DSH also leaves Edit automatically for Manual (A-11)', async () => {
    const h = createHarness();
    h.createSlot.mockImplementationOnce(async (options: Record<string, unknown>) => {
      (options.createTransport as (input: unknown) => unknown)({ generation: 1, cwd: '/repo' });
      throw Object.assign(new Error('Worker exited before bootstrap'), { code: 'WORKER_EXITED' });
    });
    await h.manager.createSession({
      sessionId: 's1',
      workspacePath: '/repo',
      model: 'claude/claude-opus-5',
      permissions: { mode: 'agent', gear: 'accept-edits' },
    });
    expect(h.latest('s1').options.permissions).toEqual({ mode: 'agent', gear: 'ask' });
    expect(causes(h, 's1')).toEqual(['sync']);
  });
});
