/**
 * T37-b resource / longevity gate.
 *
 * Runs the real WorkerManager, real utilityProcess workers and real Pi TUI PTY
 * processes inside a real Electron main process, then measures what unit tests
 * with fake slots cannot: that bounded capacity, idle reclaim, reopen after
 * eviction, repeated session churn and app shutdown leave no live OS process
 * behind and no unbounded Main-process memory growth.
 */

import fs from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, utilityProcess } from 'electron';
import type { CreatePiWorkerSlotOptions } from '../../src/main/services/agent-host/createPiWorkerSlot.ts';
import type { WorkerManagerSlotSnapshot } from '../../src/main/services/agent-host/WorkerManager.ts';
import type { PiTuiLaunchPlan } from '../../src/shared/types/piTui.ts';
import type { RuntimeEvent } from '../../src/shared/types/runtimeEvents.ts';
import type { SessionIndexEntry } from '../../src/shared/types/sessionIndex.ts';

const workerPath = process.argv.at(-1);
const repoRoot = process.argv.at(-2);
if (!workerPath || !repoRoot) throw new Error('repo root and worker path are required');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const CAPACITY = 2;
const IDLE_TIMEOUT_MS = 2_000;
const IDLE_SWEEP_MS = 200;
/** Standing gate runs 6; raise it for a longer soak without touching the code. */
const CHURN_CYCLES = (() => {
  const configured = Number(process.env.AICLIENT_T37B_CYCLES ?? 6);
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 100) {
    throw new Error(
      `AICLIENT_T37B_CYCLES must be 1..100, received ${process.env.AICLIENT_T37B_CYCLES}`
    );
  }
  return configured;
})();
/** Generous: this asserts "bounded", not a tuned RSS budget. */
const MAX_CHURN_RSS_GROWTH_MIB = 120;
/** Confirmed worker exit still leaves a short OS teardown tail; bound it. */
const MAX_WORKER_DRAIN_MS = 2_000;

function writeSse(res: ServerResponse, type: string, payload: unknown): void {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = createServer((req, res) => {
  req.on('data', () => undefined);
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const id = `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    writeSse(res, 'message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: 'probe-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    writeSse(res, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    writeSse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'T37B-REPLY' },
    });
    writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeSse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    writeSse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent(
  events: RuntimeEvent[],
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs = 20_000
): Promise<RuntimeEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const event = events.find(predicate);
      if (event) return resolve(event);
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for RuntimeEvent'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function waitForCondition(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Linux process state char, or `gone`. Electron reaps an exited utilityProcess
 * on a background thread, so `kill(pid, 0)` can still succeed for a `Z`ombie
 * that holds no memory and no file descriptors.
 */
function pidState(pid: number): string {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? '?';
  } catch {
    return 'gone';
  }
}

/** Resident set of another process, in MiB, from procfs. */
function pidRssMiB(pid: number): number | null {
  try {
    const pages = Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]);
    if (!Number.isFinite(pages)) return null;
    return Math.round(((pages * 4096) / 1024 ** 2) * 10) / 10;
  } catch {
    return null;
  }
}

function isRunningProcess(pid: number): boolean {
  if (!pidExists(pid)) return false;
  const state = pidState(pid);
  return state !== 'gone' && state !== 'Z';
}

async function waitForPidGone(pid: number, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidExists(pid) && Date.now() < deadline) await delay(20);
  if (pidExists(pid)) throw new Error(`${label} pid ${pid} still exists`);
}

function rssMiB(): number {
  return Math.round((process.memoryUsage().rss / 1024 ** 2) * 10) / 10;
}

let stage = 'startup';
function step(next: string): void {
  stage = next;
  process.stderr.write(`[t37b-probe] stage: ${next}\n`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorCode(error: unknown): string {
  return (error as { code?: string })?.code ?? String(error);
}

async function main(): Promise<void> {
  await app.whenReady();
  const { createPiWorkerSlot } = await import(
    '../../src/main/services/agent-host/createPiWorkerSlot.ts'
  );
  const { resolveDefaultWorkerCapacity, WorkerManager } = await import(
    '../../src/main/services/agent-host/WorkerManager.ts'
  );
  const { createUtilityProcessWorkerTransport } = await import(
    '../../src/main/services/agent-host/WorkerTransport.ts'
  );
  const { PiTuiPtyController, resolvePiTuiLaunchPlan } = await import(
    '../../src/main/services/terminal/PiTuiPty.ts'
  );
  const nodePty = await import('node-pty');

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('probe server address unavailable');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-t37b-probe-'));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        probe: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          api: 'anthropic-messages',
          authHeader: true,
          models: [
            {
              id: 'probe-model',
              name: 'T37-b Probe',
              reasoning: false,
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    })
  );
  fs.writeFileSync(
    path.join(agentDir, 'auth.json'),
    JSON.stringify({ probe: { type: 'api_key', key: 't37b-probe-key' } })
  );

  const workerPids: { session: string; pid: number }[] = [];
  const events: RuntimeEvent[] = [];
  const index = new Map<string, SessionIndexEntry>();

  const createSlot = async (options: CreatePiWorkerSlotOptions) => {
    const created = await createPiWorkerSlot({
      ...options,
      createTransport: ({ generation }) => {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        Object.assign(env, {
          PI_CODING_AGENT_DIR: agentDir,
          AICLIENT_PI_TRUST_PROJECT_CONFIG: '0',
          AICLIENT_PI_WORKER_GENERATION: String(generation),
        });
        const child = utilityProcess.fork(workerPath, [], {
          cwd,
          env,
          stdio: 'pipe',
          serviceName: `AiClient T37b Probe ${options.logicalSessionId} g${generation}`,
        });
        child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
        return createUtilityProcessWorkerTransport(child);
      },
      requestTimeoutMs: 15_000,
      disposeTimeoutMs: 5_000,
      exitTimeoutMs: 5_000,
    });
    if (!created.slot.pid) throw new Error('probe worker has no pid');
    workerPids.push({ session: options.logicalSessionId, pid: created.slot.pid });
    return created;
  };

  const managerOptions = {
    createSlot,
    bindRuntimeIdentity: async (sessionId: string, runtimeIdentity: string) => {
      index.set(sessionId, {
        sessionId,
        agent: 'pi',
        workspacePath: cwd,
        title: sessionId,
        model: 'probe/probe-model',
        runtimeIdentity,
        updatedAt: Date.now(),
        archived: false,
      });
    },
    commitResumed: async (input: { sessionId: string; runtimeIdentity: string }) => {
      const existing = index.get(input.sessionId);
      if (!existing || existing.runtimeIdentity !== input.runtimeIdentity) {
        throw new Error(`resume index mismatch ${input.sessionId}`);
      }
    },
    capacity: CAPACITY,
    onEvent: (event: RuntimeEvent) => events.push(event),
  };

  const pool = new WorkerManager({ ...managerOptions, idleTimeoutMs: 0, idleSweepIntervalMs: 0 });
  const idlePool = new WorkerManager({
    ...managerOptions,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    idleSweepIntervalMs: IDLE_SWEEP_MS,
  });

  const ptyPids: number[] = [];
  const ptyData = new Set<string>();
  const ptyExits: string[] = [];
  const ptyStates: string[] = [];
  const controller = new PiTuiPtyController(
    1,
    {
      onData: (event) => ptyData.add(event.terminalId),
      onExit: (event) => ptyExits.push(event.terminalId),
      onState: (event) => ptyStates.push(`${event.terminalId}:${event.state}`),
    },
    (file, args, options) => {
      const pty = nodePty.spawn(file, args, options);
      ptyPids.push(pty.pid);
      return pty;
    },
    async (): Promise<PiTuiLaunchPlan> =>
      resolvePiTuiLaunchPlan({
        isPackaged: false,
        appPath: repoRoot,
        resourcesPath: process.resourcesPath,
        platform: process.platform,
        electronExecPath: process.execPath,
      }),
    2
  );

  const snapshotIds = (manager: { getSlotSnapshots(): WorkerManagerSlotSnapshot[] }): string[] =>
    manager
      .getSlotSnapshots()
      .map((slot) => slot.logicalSessionId)
      .sort();
  const lastPidOf = (session: string): number => {
    const record = [...workerPids].reverse().find((entry) => entry.session === session);
    if (!record) throw new Error(`no worker pid recorded for ${session}`);
    return record.pid;
  };
  const sessionFileOf = (
    manager: { getSlotSnapshots(): WorkerManagerSlotSnapshot[] },
    session: string
  ): string => {
    const file = manager
      .getSlotSnapshots()
      .find((slot) => slot.logicalSessionId === session)?.sessionFile;
    if (!file) throw new Error(`no durable session file for ${session}`);
    return file;
  };
  const sendAndSettle = async (
    manager: typeof pool,
    sessionId: string,
    text: string
  ): Promise<void> => {
    const requestId = await manager.send({
      sessionId,
      attemptId: `attempt-${sessionId}-${text.replace(/\s+/g, '-')}`,
      text,
      model: 'probe/probe-model',
      effort: 'low',
    });
    await waitForEvent(
      events,
      (event) => event.type === 'session.completed' && event.requestId === requestId
    );
  };
  const startSession = async (manager: typeof pool, sessionId: string): Promise<void> => {
    await manager.createSession({
      sessionId,
      workspacePath: cwd,
      model: 'probe/probe-model',
      effort: 'low',
    });
    await sendAndSettle(manager, sessionId, `seed ${sessionId}`);
  };

  let quitCleanup: (() => Promise<void>) | null = null;
  try {
    // --- Bounded pool ---------------------------------------------------
    step('pool: create pool-a');
    await startSession(pool, 'pool-a');
    const fileA = sessionFileOf(pool, 'pool-a');
    const pidA = lastPidOf('pool-a');
    step('pool: create pool-b');
    await startSession(pool, 'pool-b');
    const pidB = lastPidOf('pool-b');
    assert(snapshotIds(pool).join(',') === 'pool-a,pool-b', 'pool did not hold both sessions');

    step('pool: over-subscribe with pool-c');
    await startSession(pool, 'pool-c');
    assert(
      snapshotIds(pool).join(',') === 'pool-b,pool-c',
      `capacity ${CAPACITY} exceeded or wrong victim: ${snapshotIds(pool).join(',')}`
    );
    await waitForPidGone(pidA, 'evicted worker');

    step('pool: all-protected capacity rejection');
    const workerRssMiB = [pidExists(pidB) ? pidRssMiB(pidB) : null, pidRssMiB(lastPidOf('pool-c'))];
    pool.claimSession('pool-b', 41);
    pool.claimSession('pool-c', 42);
    let capacityError = '';
    let capacityRetryable = false;
    try {
      await pool.createSession({
        sessionId: 'pool-d',
        workspacePath: cwd,
        model: 'probe/probe-model',
        effort: 'low',
      });
    } catch (error) {
      capacityError = errorCode(error);
      capacityRetryable = (error as { retryable?: boolean }).retryable === true;
    }
    assert(
      capacityError === 'worker_capacity_reached' && capacityRetryable,
      `all-protected pool did not return a retryable capacity error: ${capacityError}`
    );
    assert(pidExists(pidB), 'protected foreground worker was killed by a refused create');

    step('pool: release then create pool-d');
    pool.releaseSession('pool-b');
    await startSession(pool, 'pool-d');
    assert(
      snapshotIds(pool).join(',') === 'pool-c,pool-d',
      `release did not free exactly one slot: ${snapshotIds(pool).join(',')}`
    );
    await waitForPidGone(pidB, 'released worker');

    // --- Reopen an evicted session --------------------------------------
    step('reopen: close live sessions');
    pool.releaseSession('pool-c');
    await pool.closeSession('pool-c');
    await pool.closeSession('pool-d');
    assert(snapshotIds(pool).length === 0, 'pool not empty after closing every session');

    step('reopen: resume evicted pool-a');
    const resumeRequestId = await pool.resumeSession({
      sessionId: 'pool-a',
      sessionFile: fileA,
      workspacePath: cwd,
      model: 'probe/probe-model',
      effort: 'low',
    });
    const resumeEvents = events.filter((event) => event.requestId === resumeRequestId);
    const resumeOrder = resumeEvents.map((event) => event.type).join(',');
    assert(
      resumeOrder === 'session.resumed,session.history,session.status',
      `reopen event order failure: ${resumeOrder}`
    );
    const hydrated = resumeEvents[1];
    assert(
      hydrated?.type === 'session.history' &&
        hydrated.payload.runtimeIdentity === fileA &&
        hydrated.payload.messages.length > 0,
      'reopened session did not hydrate the evicted durable file'
    );
    const reopenedMessages = hydrated.payload.messages.length;
    await sendAndSettle(pool, 'pool-a', 'after reopen');
    await pool.closeSession('pool-a');

    // --- Session churn: memory and process accounting --------------------
    step('churn: start');
    const runningWorkers = (): string[] =>
      workerPids
        .filter((entry) => isRunningProcess(entry.pid))
        .map((entry) => `${entry.session}:${entry.pid}:${pidState(entry.pid)}`);
    const rssSamples = [rssMiB()];
    const churnCycles: { cycle: number; runningAtClose: string[]; drainMs: number }[] = [];
    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      const sessionId = `churn-${cycle}`;
      step(`churn: cycle ${cycle}`);
      await startSession(pool, sessionId);
      await pool.closeSession(sessionId);
      await waitForCondition(() => snapshotIds(pool).length === 0, `${sessionId} close`);
      const runningAtClose = runningWorkers();
      const drainStart = Date.now();
      await waitForCondition(() => runningWorkers().length === 0, `${sessionId} process drain`);
      churnCycles.push({ cycle, runningAtClose, drainMs: Date.now() - drainStart });
      rssSamples.push(rssMiB());
    }
    const worstDrainMs = Math.max(...churnCycles.map((entry) => entry.drainMs));
    assert(
      worstDrainMs <= MAX_WORKER_DRAIN_MS,
      `a closed worker took ${worstDrainMs}ms to leave the process table`
    );
    const rssGrowth = Math.round(((rssSamples.at(-1) ?? 0) - (rssSamples[0] ?? 0)) * 10) / 10;
    assert(
      rssGrowth <= MAX_CHURN_RSS_GROWTH_MIB,
      `Main RSS grew ${rssGrowth} MiB over ${CHURN_CYCLES} churn cycles`
    );

    // --- Idle reclaim and protection -------------------------------------
    step('idle: seed idle-a/idle-b');
    await startSession(idlePool, 'idle-a');
    const idlePidA = lastPidOf('idle-a');
    await startSession(idlePool, 'idle-b');
    const idlePidB = lastPidOf('idle-b');
    idlePool.claimSession('idle-b', 77);
    // Re-arm idle-a's clock after both spawns, so the wait below can only be
    // satisfied by the background sweep — not by a reclaim that already ran
    // inside the second createSession.
    await sendAndSettle(idlePool, 'idle-a', 'rearm idle clock');
    step('idle: wait for reclaim');
    const idleStart = Date.now();
    await waitForCondition(
      () => !snapshotIds(idlePool).includes('idle-a'),
      'idle-a reclaim',
      15_000
    );
    const idleReclaimMs = Date.now() - idleStart;
    assert(
      idleReclaimMs >= IDLE_TIMEOUT_MS,
      `idle-a was reclaimed after ${idleReclaimMs}ms, before its ${IDLE_TIMEOUT_MS}ms TTL`
    );
    await waitForPidGone(idlePidA, 'idle-reclaimed worker');
    assert(
      snapshotIds(idlePool).join(',') === 'idle-b',
      `idle sweep took the protected slot: ${snapshotIds(idlePool).join(',')}`
    );
    await delay(IDLE_TIMEOUT_MS * 2);
    assert(
      snapshotIds(idlePool).join(',') === 'idle-b' && pidExists(idlePidB),
      'foreground-protected slot did not survive repeated idle sweeps'
    );
    step('idle: release protection');
    idlePool.releaseSession('idle-b');
    await waitForCondition(() => snapshotIds(idlePool).length === 0, 'idle-b reclaim', 15_000);
    await waitForPidGone(idlePidB, 'released idle worker');
    await idlePool.disposeAll('app-shutdown');

    // --- Real Pi TUI PTY capacity, suspend and eviction -------------------
    step('pty: open tui-1');
    await controller.open({ terminalId: 'tui-1', cwd, cols: 80, rows: 24 });
    const ptyPid1 = ptyPids.at(-1) as number;
    await waitForCondition(() => ptyData.has('tui-1'), 'tui-1 output', 20_000);
    await controller.open({ terminalId: 'tui-2', cwd, cols: 80, rows: 24 });
    const ptyPid2 = ptyPids.at(-1) as number;
    await waitForCondition(() => ptyData.has('tui-2'), 'tui-2 output', 20_000);

    step('pty: capacity rejection');
    const ptyRssMiB = [pidRssMiB(ptyPid1), pidRssMiB(ptyPid2)];
    let ptyCapacityError = '';
    try {
      await controller.open({ terminalId: 'tui-3', cwd, cols: 80, rows: 24 });
    } catch (error) {
      ptyCapacityError = (error as Error).message;
    }
    assert(
      /capacity reached/i.test(ptyCapacityError),
      `live PTY over-subscription was not rejected: ${ptyCapacityError}`
    );
    assert(
      ptyPids.length === 2 && pidExists(ptyPid1) && pidExists(ptyPid2),
      'refused PTY open disturbed the live terminals'
    );

    step('pty: suspend and evict tui-1');
    await controller.suspend('tui-1');
    await controller.open({ terminalId: 'tui-3', cwd, cols: 80, rows: 24 });
    const ptyPid3 = ptyPids.at(-1) as number;
    await waitForPidGone(ptyPid1, 'evicted suspended PTY');
    assert(
      controller.status().terminalIds.sort().join(',') === 'tui-2,tui-3',
      `PTY eviction left the wrong set: ${controller.status().terminalIds.join(',')}`
    );

    step('pty: long suspend then promote tui-2');
    await controller.suspend('tui-2');
    await delay(3_000);
    const promoted = await controller.open({ terminalId: 'tui-2', cwd, cols: 100, rows: 30 });
    assert(
      promoted.resumed && ptyPids.length === 3 && pidExists(ptyPid2),
      'long-suspended PTY was respawned instead of promoted'
    );

    // --- Shutdown with a live worker and live PTYs -------------------------
    step('shutdown: live worker + live PTYs');
    await startSession(pool, 'shutdown-a');
    const shutdownPid = lastPidOf('shutdown-a');
    assert(pidExists(shutdownPid) && pidExists(ptyPid2), 'shutdown fixture is not live');

    quitCleanup = async () => {
      await Promise.all([pool.disposeAll('app-shutdown'), controller.disposeAll()]);
    };
    await new Promise<void>((resolve, reject) => {
      let cleaning = false;
      app.on('will-quit', (event) => {
        if (cleaning) return;
        event.preventDefault();
        cleaning = true;
        quitCleanup?.().then(resolve, reject);
      });
      app.quit();
    });

    for (const entry of workerPids) await waitForPidGone(entry.pid, `worker ${entry.session}`);
    for (const pid of [ptyPid2, ptyPid3]) await waitForPidGone(pid, 'pty');

    console.log(
      JSON.stringify({
        ok: true,
        capacity: CAPACITY,
        pool: {
          evictedOnOverSubscribe: 'pool-a',
          capacityError,
          capacityRetryable,
          finalSnapshot: snapshotIds(pool),
        },
        reopen: { sessionFile: fileA, eventOrder: resumeOrder.split(','), reopenedMessages },
        longevity: {
          cycles: CHURN_CYCLES,
          rssSamplesMiB: rssSamples,
          rssGrowthMiB: rssGrowth,
          worstDrainMs,
          churnCycles,
        },
        idle: {
          timeoutMs: IDLE_TIMEOUT_MS,
          sweepMs: IDLE_SWEEP_MS,
          reclaimMs: idleReclaimMs,
          protectedHeldMs: IDLE_TIMEOUT_MS * 2,
        },
        pty: {
          spawns: ptyPids.length,
          capacityError: ptyCapacityError,
          evictedPid: ptyPid1,
          promotedWithoutRespawn: true,
          exits: ptyExits,
          states: ptyStates,
        },
        resource: {
          hostTotalMemMiB: Math.round(os.totalmem() / 1024 ** 2),
          hostDefaultCapacity: resolveDefaultWorkerCapacity(),
          probeCapacity: CAPACITY,
          workerRssMiB,
          ptyRssMiB,
        },
        workerPids: workerPids.map((entry) => entry.pid),
        ptyPids,
      })
    );
  } finally {
    pool.forceKillAllNow();
    idlePool.forceKillAllNow();
    controller.disposeAllSync();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
  app.exit(0);
}

void main().catch((error) => {
  console.error(`[t37b-probe] fatal at stage "${stage}":`, error);
  app.exit(1);
});
