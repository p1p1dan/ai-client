import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-3a / P1-3c — the shared DSH host for real (P1-3 plan §6, the
 * P0-6 scenarios): the real DshHostSupervisor, WorkerManager and
 * createPiWorkerSlot over a real host process and the local fake gateway.
 * Opt-in and slow:
 *
 *   AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run \
 *     src/main/services/agent-host/__tests__/dshSharedHost.integration.test.ts
 *
 * Needs out-node-runtime/node and `npm ci` in src/dsh-host. Run it alone on the
 * dev box (one host is 200-350 MB), with no Electron open.
 *
 * Only this repo's own children are ever signalled, through their ChildProcess
 * (`node:child_process` is wrapped to remember them): never a pid, never a group.
 *
 * Two phases, each with its own supervisor, because the host restart budget
 * (decision 020: 3 per 5 min) is per supervisor: the app's singleton takes
 * three SIGKILLs inside a minute, and a fresh one takes the SIGSTOP hang and
 * Stop ladder B. They never overlap: one DSH home, one host at a time.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../..');
const NODE = join(REPO, 'out-node-runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const GATEWAY = join(REPO, 'src', 'dsh-host', 'tools', 'fake-gateway.mjs');
const enabled =
  process.env.AICLIENT_DSH_INTEGRATION === '1' &&
  process.platform === 'linux' &&
  existsSync(NODE) &&
  existsSync(join(REPO, 'src', 'dsh-host', 'node_modules', '@deepseek-ai', 'dsh-app-boot'));

const shared = vi.hoisted(() => ({
  stateRoot: '',
  children: [] as ChildProcess[],
  /** Main-to-host messages to swallow, as a host that never answers them would. */
  dropToHost: null as ((message: unknown) => boolean) | null,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      shared.children.push(child);
      const send = child.send?.bind(child);
      if (
        send &&
        (args[1] as readonly string[] | undefined)?.some((arg) => arg.endsWith('host.ts'))
      ) {
        // Stop ladder B needs a channel the host never closes; the probe
        // bundle has no switch for a stuck agent yet (P1-3e), so the test
        // stands in for one at the IPC edge: what it drops never reaches DSH.
        child.send = ((message: unknown, ...rest: unknown[]) => {
          if (shared.dropToHost?.(message)) {
            const callback = rest.find((arg) => typeof arg === 'function') as
              | ((error: Error | null) => void)
              | undefined;
            if (callback) queueMicrotask(() => callback(null));
            return true;
          }
          return (send as (...all: unknown[]) => boolean)(message, ...rest);
        }) as typeof child.send;
      }
      return child;
    },
  };
});
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => REPO },
  powerMonitor: { on: () => undefined, removeListener: () => undefined },
}));
vi.mock('../../appStatePaths', () => ({ getAppStateRoot: () => shared.stateRoot }));

const { DshHostSupervisor, DSH_HOST_TIMINGS, dshHostSupervisor } = await import(
  '../DshHostSupervisor'
);
const { WorkerManager } = await import('../WorkerManager');
const { createPiWorkerSlot } = await import('../createPiWorkerSlot');
const { spawn } = await import('node:child_process');

type Event = RuntimeEvent & { payload?: Record<string, unknown> };
type Manager = InstanceType<typeof WorkerManager>;
type Supervisor = InstanceType<typeof DshHostSupervisor>;

/**
 * How long the heartbeat may take to call a SIGSTOPped host hung. The last
 * pong can land just before the stop, silence is only measured on 5 s ticks,
 * and a tick up to 1 s late is not billed to Main: 20 + 5 + 1 = 26 s, and
 * P1-3a measured 24.8 s, i.e. that bound less one pong round trip with the
 * stop right after it. The 4 s above it are Main's own scheduling on a loaded
 * 2-core box (a later tick adds its lateness one for one) plus SIGKILL to
 * exit. The plan's 25 s line (§6) had no room for either. It moves with the
 * timings, so re-tuning the heartbeat re-derives it.
 */
const HUNG_DETECTION_BOUND_MS =
  DSH_HOST_TIMINGS.hungAfterMs +
  DSH_HOST_TIMINGS.heartbeatIntervalMs +
  DSH_HOST_TIMINGS.timerLateToleranceMs +
  4_000;

/** Stop's T144 promise: the UI settles at the 10 s watchdog; 2 s more absorb this box. */
const STOP_WATCHDOG_BOUND_MS = 12_000;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const isHost = (child: ChildProcess) => child.spawnargs.some((arg) => arg.endsWith('host.ts'));

/** Processes whose command line carries `needle` (Linux). */
function processesWith(needle: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ');
      if (cmd.includes(needle)) found.push(`${entry} ${cmd.slice(0, 120)}`);
    } catch {
      // Gone between readdir and read.
    }
  }
  return found;
}

/** The cgroup a process runs in (Linux), or '' once it is gone. */
function cgroupOf(line: string): string {
  try {
    return readFileSync(`/proc/${line.split(' ')[0]}/cgroup`, 'utf8').trim();
  } catch {
    return '';
  }
}

describe.skipIf(!enabled)('shared DSH host, real process (P1-3a, P1-3c)', () => {
  const events: Event[] = [];
  const saved: Record<string, string | undefined> = {};
  let gateway: ChildProcess | undefined;
  let workspace = '';
  let attempt = 0;
  const tokens: Record<string, string> = {};
  const hostLines: string[] = [];

  const hostChildren = () => shared.children.filter(isHost);
  const liveHosts = () => hostChildren().filter(alive);
  const forSession = (id: string, from = 0) => events.slice(from).filter((e) => e.sessionId === id);
  /** What one session was told after `from`: statuses with their reason, terminals with their code. */
  const told = (id: string, from: number) =>
    forSession(id, from)
      .filter((e) =>
        ['session.status', 'session.failed', 'session.stopped', 'session.resumed'].includes(e.type)
      )
      .map((e) =>
        e.type === 'session.status'
          ? `status:${String(e.payload?.status)}${e.payload?.disconnectReason ? `/${String(e.payload.disconnectReason)}` : ''}`
          : e.type === 'session.failed'
            ? `failed(${String(e.payload?.errorCode ?? '')})`
            : e.type === 'session.stopped'
              ? `stopped(${String(e.payload?.stopCause ?? '')})`
              : e.type
      );

  async function turn(manager: Manager, sessionId: string, text: string, owner: number) {
    const from = events.length;
    attempt += 1;
    const requestId = await manager.send({
      sessionId,
      attemptId: `attempt-${attempt}`,
      text,
      ownerWebContentsId: owner,
    });
    const settled = await until(
      () =>
        forSession(sessionId, from).some(
          (e) =>
            e.requestId === requestId && e.type === 'session.status' && e.payload?.status === 'idle'
        ),
      120_000
    );
    const turnEvents = forSession(sessionId, from);
    const assistant = new Set(
      turnEvents
        .filter((e) => e.type === 'message.started' && e.payload?.role === 'assistant')
        .map((e) => e.payload?.messageId)
    );
    return {
      settled,
      completed: turnEvents.some((e) => e.type === 'session.completed'),
      reply: turnEvents
        .filter((e) => e.type === 'message.delta' && assistant.has(e.payload?.messageId))
        .map((e) => String(e.payload?.text))
        .join(''),
    };
  }

  /** Every session reported resumed and idle after `from`; returns when, or -1. */
  async function recovered(ids: string[], from: number, timeoutMs: number): Promise<number> {
    const started = Date.now();
    const ok = await until(
      () =>
        ids.every((id) => {
          const list = forSession(id, from);
          const resumed = list.findIndex((e) => e.type === 'session.resumed');
          return (
            resumed >= 0 &&
            list
              .slice(resumed)
              .some((e) => e.type === 'session.status' && e.payload?.status === 'idle')
          );
        }),
      timeoutMs
    );
    return ok ? Date.now() - started : -1;
  }

  function newManager(supervisor: Supervisor, own: boolean): Manager {
    return new WorkerManager({
      host: supervisor,
      // The app's singleton is what createPiWorkerSlot opens channels on by
      // default; a second supervisor needs its channels opened on it.
      ...(own
        ? {
            createSlot: (options) =>
              createPiWorkerSlot({
                ...options,
                createTransport: () =>
                  supervisor.openChannel({ userInitiated: options.userInitiated === true }),
              }),
          }
        : {}),
      onEvent: (event) => events.push(event as Event),
      capacity: 6,
      idleTimeoutMs: 0,
      idleSweepIntervalMs: 0,
    });
  }

  beforeAll(async () => {
    shared.stateRoot = mkdtempSync(join('/var/tmp', 'aiclient-p1-3-it-'));
    workspace = join(shared.stateRoot, 'workspace');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    for (const name of [
      'AICLIENT_DSH_HOME',
      'AICLIENT_DSH_NODE',
      'AICLIENT_DSH_GATEWAY_URL',
      'AICLIENT_DSH_GATEWAY_KEY',
    ]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    gateway = spawn(
      process.execPath,
      [
        GATEWAY,
        '--port',
        '0',
        '--plan',
        'dsh-p0-2',
        '--reset',
        '--state',
        join(shared.stateRoot, 'gateway.state.json'),
        '--log',
        join(shared.stateRoot, 'gateway.jsonl'),
        '--model-id',
        'fake-1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const port = await new Promise<number>((done, fail) => {
      let text = '';
      gateway?.stdout?.setEncoding('utf8');
      gateway?.stdout?.on('data', (chunk: string) => {
        text += chunk;
        const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) done(Number(match[1]));
      });
      setTimeout(() => fail(new Error('fake gateway did not start')), 15_000);
    });
    gateway.stderr?.resume();
    // Main's dev route (DshHostProcess adds these back unpackaged, decision 022).
    process.env.AICLIENT_DSH_GATEWAY_URL = `http://127.0.0.1:${port}`;
    process.env.AICLIENT_DSH_GATEWAY_KEY = 'p1-3-fake-key';
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      hostLines.push(args.map(String).join(' '));
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await dshHostSupervisor.shutdown('app-quit');
    } finally {
      shared.dropToHost = null;
      // Backstop: this suite's own children only, SIGCONT-free (SIGKILL ends a stopped one too).
      for (const child of shared.children) if (alive(child)) child.kill('SIGKILL');
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      vi.restoreAllMocks();
      rmSync(shared.stateRoot, { recursive: true, force: true });
    }
  }, 60_000);

  /** Phase one: the app's own singleton supervisor, as WorkerManager's production wiring has it. */
  describe('the app supervisor: three SIGKILLs inside a minute', () => {
    let manager: Manager;
    let firstKillAt = 0;

    beforeAll(() => {
      manager = newManager(dshHostSupervisor, false);
    });

    afterAll(async () => {
      // App quit (decision 025): one host-level shutdown, no per-channel RPC.
      await manager?.disposeAll('app-shutdown');
      expect(dshHostSupervisor.status()).toMatchObject({
        state: 'disposed',
        lastExit: { reason: 'app-quit' },
      });
      expect(liveHosts()).toHaveLength(0);
    }, 60_000);

    it('serves several sessions from one host process', async () => {
      for (const [index, id] of ['s1', 's2', 's3'].entries()) {
        tokens[id] = `P13A${id.toUpperCase()}${Date.now() % 100_000}`;
        await manager.createSession({
          sessionId: id,
          workspacePath: workspace,
          ownerWebContentsId: index + 1,
        });
      }
      const results = await Promise.all(
        ['s1', 's2', 's3'].map((id, index) =>
          turn(manager, id, `P0-CRASH {"token":"${tokens[id]}"} 列一下目录。`, index + 1)
        )
      );
      for (const result of results)
        expect(result).toMatchObject({ settled: true, completed: true });
      expect(hostChildren()).toHaveLength(1);
      expect(dshHostSupervisor.status()).toMatchObject({
        state: 'ready',
        generation: 1,
        channels: 3,
        pid: hostChildren()[0].pid,
      });
      expect(manager.getSlotSnapshots().map((slot) => [slot.logicalSessionId, slot.state])).toEqual(
        [
          ['s1', 'ready'],
          ['s2', 'ready'],
          ['s3', 'ready'],
        ]
      );
    }, 180_000);

    it('recovers every session after the host is SIGKILLed, a tool call in flight', async () => {
      const sleeper = `P13ASLEEP${Date.now() % 100_000}`;
      const from = events.length;
      attempt += 1;
      const inFlight = await manager.send({
        sessionId: 's3',
        attemptId: `attempt-${attempt}`,
        text: `P0-SLEEPTOOL {"token":"${sleeper}","seconds":20} 跑一个慢命令。`,
        ownerWebContentsId: 3,
      });
      expect(
        await until(() => forSession('s3', from).some((e) => e.type === 'tool.started'), 60_000)
      ).toBe(true);
      expect(await until(() => processesWith(`sleep-tool ${sleeper}`).length > 0, 15_000)).toBe(
        true
      );
      const [host] = liveHosts();
      // DSH runs a tool in a systemd user scope of the host's own when a user
      // bus is there (the desktop case), and in a process group otherwise.
      const scope = `dsh-subprocess-${host.pid}-`;
      const scoped = processesWith(`sleep-tool ${sleeper}`).every((line) =>
        cgroupOf(line).includes(scope)
      );
      const killedAt = events.length;
      firstKillAt = Date.now();
      host.kill('SIGKILL');
      const tookMs = await recovered(['s1', 's2', 's3'], killedAt, 60_000);
      console.log(
        `[p1-3] SIGKILL 1: all three sessions resumed and idle ${tookMs} ms after the kill`
      );
      expect(tookMs).toBeGreaterThanOrEqual(0);
      for (const id of ['s1', 's2', 's3']) {
        const said = told(id, killedAt);
        const disconnected = said.indexOf('status:disconnected');
        expect(disconnected, id).toBeGreaterThanOrEqual(0);
        expect(said.indexOf('session.resumed'), id).toBeGreaterThan(disconnected);
        expect(said.includes('failed(dsh_host_crashed)'), id).toBe(id === 's3');
      }
      // The turn cut short is reported as failed, under its own request id.
      expect(
        forSession('s3', killedAt).some(
          (e) => e.type === 'session.failed' && e.requestId === inFlight
        )
      ).toBe(true);
      expect(
        manager
          .getSlotSnapshots()
          .map((slot) => [slot.logicalSessionId, slot.state, slot.generation, slot.restartAttempts])
      ).toEqual([
        ['s1', 'ready', 2, 0],
        ['s2', 'ready', 2, 0],
        ['s3', 'ready', 2, 0],
      ]);
      expect(manager.getStatus().state).toBe('ready');
      // One restart, one live host; the dead host's tool is below.
      expect(hostChildren()).toHaveLength(2);
      expect(liveHosts()).toHaveLength(1);
      expect(dshHostSupervisor.status()).toMatchObject({
        state: 'ready',
        generation: 2,
        channels: 3,
        recentFaults: 1,
        lastExit: { reason: 'crashed', signal: 'SIGKILL', generation: 1 },
      });
      if (scoped) {
        // Found here (P1-3c): a systemd scope is not tied to the host that
        // opened it, so a SIGKILLed host leaves its tool running until the tool
        // ends by itself (20 s here). Only the fallback containment takes it
        // down with the host, which is what P1-3a measured. Left to P1-3e /
        // P1-8 (who stops a dead host's scopes); pinned here so a change shows.
        const leftovers = processesWith(`sleep-tool ${sleeper}`);
        console.log(
          `[p1-3] systemd scope: ${leftovers.length} tool process(es) of the killed host still running`
        );
        for (const line of leftovers) expect(cgroupOf(line)).toContain(scope);
      } else {
        expect(await until(() => processesWith(`sleep-tool ${sleeper}`).length === 0, 2_000)).toBe(
          true
        );
      }

      // Each session runs again, with its earlier turn in the model's context.
      const recalls = await Promise.all(
        ['s1', 's2', 's3'].map((id, index) =>
          turn(
            manager,
            id,
            `P0-RECALL ${JSON.stringify({ markers: [`crash-probe ${tokens[id]}`, `P0-CRASH ${tokens[id]} finished`] })}`,
            index + 1
          )
        )
      );
      for (const recall of recalls) {
        expect(recall).toMatchObject({ settled: true, completed: true });
        expect(recall.reply).toContain('missing=-');
      }
    }, 240_000);

    // P1-3a left each host crash billing every session one of its own two
    // restarts a minute, so the third crash in a minute parked them all in
    // error. Decision 020 bills the host instead.
    it('two more SIGKILLs in the same minute: every session comes back each time, on no budget of its own', async () => {
      for (const round of [2, 3]) {
        const [host] = liveHosts();
        const killedAt = events.length;
        host.kill('SIGKILL');
        const tookMs = await recovered(['s1', 's2', 's3'], killedAt, 30_000);
        console.log(
          `[p1-3] SIGKILL ${round}: all three sessions resumed and idle ${tookMs} ms after the kill, ` +
            `${Date.now() - firstKillAt} ms after the first`
        );
        // P1-3 plan §6: resumed and idle within 5 s of the kill.
        expect(tookMs).toBeGreaterThanOrEqual(0);
        expect(tookMs).toBeLessThan(5_000);
        expect(
          manager
            .getSlotSnapshots()
            .map((slot) => [slot.state, slot.generation, slot.restartAttempts, slot.error])
        ).toEqual([
          ['ready', round + 1, 0, null],
          ['ready', round + 1, 0, null],
          ['ready', round + 1, 0, null],
        ]);
        expect(manager.getStatus().state).toBe('ready');
        expect(liveHosts()).toHaveLength(1);
        expect(dshHostSupervisor.status()).toMatchObject({
          state: 'ready',
          generation: round + 1,
          recentFaults: round,
          lastExit: { reason: 'crashed', signal: 'SIGKILL' },
        });
      }
      expect(Date.now() - firstKillAt).toBeLessThan(60_000);
      const after = await turn(manager, 's2', 'P0-STREAM: stream a paragraph back to me.', 2);
      expect(after).toMatchObject({ settled: true, completed: true });
    }, 180_000);

    it('closing a session right after its turn leaves the host and the others alone', async () => {
      await manager.createSession({
        sessionId: 's4',
        workspacePath: workspace,
        ownerWebContentsId: 4,
      });
      const done = await turn(manager, 's4', 'P0-TOOL: list the workspace.', 4);
      expect(done).toMatchObject({ settled: true, completed: true });
      const linesBefore = hostLines.length;
      await manager.closeSession('s4');
      await sleep(1_500);
      const warnings = hostLines.slice(linesBefore).filter((line) => /closed handle/.test(line));
      console.log(
        `[p1-3] dispose right after a turn: ${warnings.length} projection-cache warning(s)`
      );
      for (const line of warnings) console.log(`[p1-3]   ${line.slice(0, 300)}`);
      expect(dshHostSupervisor.status()).toMatchObject({
        state: 'ready',
        generation: 4,
        channels: 3,
      });
      const other = await turn(manager, 's2', 'P0-STREAM: stream a paragraph back to me.', 2);
      expect(other).toMatchObject({ settled: true, completed: true });
    }, 180_000);
  });

  /** Phase two: a supervisor of its own, so its restart budget starts fresh. */
  describe('a fresh supervisor: a hung host, and Stop ladder B', () => {
    let supervisor: Supervisor;
    let manager: Manager;

    beforeAll(async () => {
      supervisor = new DshHostSupervisor();
      manager = newManager(supervisor, true);
      for (const [index, id] of ['b1', 'b2', 'b3'].entries()) {
        tokens[id] = `P13C${id.toUpperCase()}${Date.now() % 100_000}`;
        await manager.createSession({
          sessionId: id,
          workspacePath: workspace,
          ownerWebContentsId: 10 + index,
        });
      }
      const results = await Promise.all(
        ['b1', 'b2', 'b3'].map((id, index) =>
          turn(manager, id, `P0-CRASH {"token":"${tokens[id]}"} 列一下目录。`, 10 + index)
        )
      );
      for (const result of results)
        expect(result).toMatchObject({ settled: true, completed: true });
      expect(liveHosts()).toHaveLength(1);
    }, 180_000);

    afterAll(async () => {
      shared.dropToHost = null;
      await manager?.disposeAll('app-shutdown');
      expect(supervisor.status()).toMatchObject({ state: 'disposed' });
    }, 60_000);

    it('kills a SIGSTOPped host on its heartbeat and recovers every session', async () => {
      const [host] = liveHosts();
      const stoppedAt = events.length;
      const started = Date.now();
      host.kill('SIGSTOP');
      expect(
        await until(
          () => supervisor.status().lastExit?.reason === 'hung',
          HUNG_DETECTION_BOUND_MS + 10_000
        )
      ).toBe(true);
      const detectedMs = Date.now() - started;
      const tookMs = await recovered(['b1', 'b2', 'b3'], stoppedAt, 60_000);
      console.log(
        `[p1-3] SIGSTOP: judged hung and killed after ${detectedMs} ms ` +
          `(bound ${HUNG_DETECTION_BOUND_MS} ms); every session idle ${tookMs} ms later`
      );
      // Not judged early (silence must reach 20 s), and within the bound.
      expect(detectedMs).toBeGreaterThanOrEqual(DSH_HOST_TIMINGS.hungAfterMs - 1_000);
      expect(detectedMs).toBeLessThan(HUNG_DETECTION_BOUND_MS);
      expect(tookMs).toBeGreaterThanOrEqual(0);
      expect(host.signalCode).toBe('SIGKILL');
      expect(
        manager
          .getSlotSnapshots()
          .map((slot) => [slot.state, slot.generation, slot.restartAttempts])
      ).toEqual([
        ['ready', 2, 0],
        ['ready', 2, 0],
        ['ready', 2, 0],
      ]);
      expect(liveHosts()).toHaveLength(1);
      expect(supervisor.status()).toMatchObject({ state: 'ready', generation: 2, recentFaults: 1 });
      const after = await turn(manager, 'b1', 'P0-STREAM: stream a paragraph back to me.', 10);
      expect(after).toMatchObject({ settled: true, completed: true });
    }, 180_000);

    it('Stop ladder B: a channel that never closes gets the host restarted once, and every session comes back', async () => {
      const sleeper = `P13CSLEEP${Date.now() % 100_000}`;
      const from = events.length;
      // b1 runs a long tool; b2 streams a long answer; b3 is idle.
      attempt += 1;
      await manager.send({
        sessionId: 'b1',
        attemptId: `attempt-${attempt}`,
        text: `P0-SLEEPTOOL {"token":"${sleeper}","seconds":60} 跑一个慢命令。`,
        ownerWebContentsId: 10,
      });
      attempt += 1;
      const streaming = await manager.send({
        sessionId: 'b2',
        attemptId: `attempt-${attempt}`,
        text: `P0-PACED {"token":"P13CPACED","chunks":400,"chunkMs":150}`,
        ownerWebContentsId: 11,
      });
      expect(await until(() => processesWith(`sleep-tool ${sleeper}`).length > 0, 60_000)).toBe(
        true
      );
      expect(
        await until(() => forSession('b2', from).some((e) => e.type === 'message.delta'), 30_000)
      ).toBe(true);

      // b1's channel: the host never hears its Stop, its dispose or its close.
      let stuck: string | undefined;
      shared.dropToHost = (message) => {
        const record = message as { ch?: string; host?: string; rpc?: Record<string, unknown> };
        const rpc = record.rpc;
        const payload = rpc?.payload as { logicalSessionId?: string } | undefined;
        if (rpc?.type === 'worker.stop' && payload?.logicalSessionId === 'b1') {
          stuck = record.ch;
          return true;
        }
        if (stuck === undefined || record.ch !== stuck) return false;
        return rpc?.type === 'worker.dispose' || record.host === 'close';
      };
      const hostBefore = supervisor.status();
      const [oldHost] = liveHosts();
      const stopAt = events.length;
      const started = Date.now();
      const stopping = manager.stop('b1').catch((error: unknown) => error);

      // T144: the UI is settled at the watchdog, whatever the host does.
      expect(
        await until(() => told('b1', stopAt).includes('stopped(forced)'), STOP_WATCHDOG_BOUND_MS)
      ).toBe(true);
      const settledMs = Date.now() - started;
      expect(told('b1', stopAt).slice(0, 2)).toEqual(['stopped(forced)', 'status:idle']);

      // 3 s for the dispose ACK, 3 s for the close, then one graceful restart.
      expect(
        await until(() => supervisor.status().lastExit?.reason === 'stuck-session', 30_000)
      ).toBe(true);
      const escalatedMs = Date.now() - started;
      const tookMs = await recovered(['b1', 'b2', 'b3'], stopAt, 60_000);
      console.log(
        `[p1-3] Stop ladder B: settled for the UI at ${settledMs} ms, host restarted at ` +
          `${escalatedMs} ms, every session idle ${tookMs} ms later`
      );
      for (const id of ['b1', 'b2', 'b3'])
        console.log(`[p1-3]   ${id}: ${told(id, stopAt).join(' ')}`);
      expect(settledMs).toBeLessThan(11_000);
      expect(tookMs).toBeGreaterThanOrEqual(0);
      await stopping;

      // One new host, no second one, nobody's own budget spent but b1's restart.
      expect(oldHost.exitCode !== null || oldHost.signalCode !== null).toBe(true);
      expect(liveHosts()).toHaveLength(1);
      expect(supervisor.status()).toMatchObject({
        state: 'ready',
        generation: hostBefore.generation + 1,
        recentFaults: hostBefore.recentFaults + 1,
        channels: 3,
      });
      expect(
        manager
          .getSlotSnapshots()
          .map((slot) => [slot.logicalSessionId, slot.state, slot.restartAttempts])
      ).toEqual([
        ['b1', 'ready', 1],
        ['b2', 'ready', 0],
        ['b3', 'ready', 0],
      ]);
      // The others were restarted on purpose, and were told so.
      expect(told('b2', stopAt).slice(0, 2)).toEqual([
        'status:disconnected/engine_restarted',
        'failed(dsh_engine_restarted)',
      ]);
      expect(
        forSession('b2', stopAt).some(
          (e) => e.type === 'session.failed' && e.requestId === streaming
        )
      ).toBe(true);
      expect(told('b3', stopAt)[0]).toBe('status:disconnected/engine_restarted');
      // The stuck agent's tool went with the old host.
      expect(await until(() => processesWith(`sleep-tool ${sleeper}`).length === 0, 5_000)).toBe(
        true
      );

      shared.dropToHost = null;
      const results = await Promise.all(
        ['b1', 'b2', 'b3'].map((id, index) =>
          turn(manager, id, 'P0-STREAM: stream a paragraph back to me.', 10 + index)
        )
      );
      for (const result of results)
        expect(result).toMatchObject({ settled: true, completed: true });
    }, 240_000);
  });
});
