import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { buildDshModelPlan, type DshModelPlan } from '@shared/dshModelPlan';
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
 * Stop ladder B. They never overlap: one DSH home, one host at a time. Later
 * phases add a close that never lands and the idle stop (P1-3d), Main's
 * read-only preview (`readPage`, P1-4a, decision 030), and rewind and fork
 * through seeded child sessions (P1-4b, decision 027).
 *
 * P1-5 (decisions 033, 034, 038): every supervisor spawns its hosts with a
 * model plan built by the product's own rules (one route to the fake gateway)
 * and answers their key requests through a real `DshCredentialBroker`. The
 * sixth phase routes turns to two models with two keys, rotates a key, signs
 * out, and runs the KEY-CANARY scan; the last loads the shipped catalog's plan
 * into a host and requires no route diagnostic (the drift gate).
 *
 * P1-10b (decisions 108, 110): a ninth supervisor runs packaged-form hosts
 * from scratch installs with a test-only fixture plugin preinstalled, enables
 * and disables it through WorkerManager's restart, and checks the rejected,
 * missing and (decision 110) ignored-home-layer cases. It needs the repo
 * root's esbuild as well. P1-10d adds the allowlisted pilot plugin
 * (dsh-office-tools): off by default, loaded when Main turns it on.
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
  /** Every host's stderr as it came, before Main's redaction (KEY-CANARY). */
  rawStderr: [] as string[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      shared.children.push(child);
      const send = child.send?.bind(child);
      if ((args[1] as readonly string[] | undefined)?.some((arg) => arg.endsWith('host.ts'))) {
        child.stderr?.on('data', (chunk: Buffer | string) => shared.rawStderr.push(String(chunk)));
      }
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
const { DshCredentialBroker } = await import('../DshCredentialBroker');
const { spawn } = await import('node:child_process');
// P1-10b: Main's environment rule, for the plugin phase's own launches.
const { buildDshHostEnvironment, dshPluginSelectionKey } = await import('../dshHostEnvironment');

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

/**
 * Decision 075: a SIGKILLed host's tools stop with its scopes, before the next
 * host starts. The supervisor waits for that at most `scopeStopWaitMs`.
 */
const SCOPE_STOP_BOUND_MS = DSH_HOST_TIMINGS.scopeStopWaitMs;

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

/** Decision 025 rule 1, shortened for the third phase. */
const IDLE_STOP_MS = 3_000;

/**
 * P1-6b part 2: every session of the phases below opens in `bypass`, as a user
 * who turned the prompts off would. The host still judges every call through
 * the app's own gate (aiclient-permissions), which then asks nothing; the
 * card round trip has a phase of its own at the end.
 */
const BYPASS = { permissions: { mode: 'agent', gear: 'bypass' } } as const;

/** P1-5: the key every phase but the sixth hands out, per request. */
const FAKE_KEY = 'p1-3-fake-key';

/**
 * P1-5: Main's model plan for these tests, by the product's own rules: the
 * probes' `aiclient-gateway` / `fake-1` on the fake gateway, plus `extra`
 * services, every one with a key; the product's retry and timeout settings.
 */
function gatewayPlan(port: number, extra: Record<string, unknown> = {}): DshModelPlan {
  const providers: Record<string, unknown> = {
    'aiclient-gateway': {
      baseUrl: `http://127.0.0.1:${port}`,
      api: 'anthropic-messages',
      models: [{ id: 'fake-1', name: 'P0 fake model', contextWindow: 200_000, maxTokens: 8192 }],
    },
    ...extra,
  };
  return buildDshModelPlan({
    models: { providers },
    keyed: Object.fromEntries(Object.keys(providers).map((id) => [id, true])),
    clientVersion: 'it-p1-5',
  });
}

/** How the fake gateway logs a key (`sha256:<8 hex>`), never the key itself. */
const digestOf = (key: string) =>
  `sha256:${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * The text of every zstd frame in `raw` (DSH appends one frame per write, and
 * the one-shot decoder stops after the first), or undefined when it holds none.
 * A split at a magic inside a frame is widened until the slice decodes.
 */
function zstdFrames(raw: Buffer): string | undefined {
  const starts: number[] = [];
  for (let at = raw.indexOf(ZSTD_MAGIC); at >= 0; at = raw.indexOf(ZSTD_MAGIC, at + 1)) {
    starts.push(at);
  }
  if (starts.length === 0) return undefined;
  let text = '';
  let from = 0;
  for (let next = 1; next <= starts.length; next += 1) {
    const end = next < starts.length ? starts[next] : raw.length;
    try {
      text += zstdDecompressSync(raw.subarray(starts[from], end)).toString('utf8');
      from = next;
    } catch {
      // Not a frame boundary; the next slice is wider.
    }
  }
  return text;
}

/**
 * Every file under `root` as text: its raw bytes, plus the decoded text of
 * every zstd frame it holds (DSH's `.jsonl.zstd` session logs), for the canary
 * scan. `decoded` counts the files that had any.
 */
function textsUnder(root: string): Array<{ file: string; text: string; decoded: boolean }> {
  const out: Array<{ file: string; text: string; decoded: boolean }> = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const bytes = readFileSync(file);
        const frames = zstdFrames(bytes);
        out.push({
          file,
          text:
            frames === undefined
              ? bytes.toString('utf8')
              : `${bytes.toString('latin1')}\n${frames}`,
          decoded: frames !== undefined && frames.length > 0,
        });
      }
    }
  };
  walk(root);
  return out;
}

/** `<DSH_HOME>/sessions/<project>/<session id>` of every session on disk, by id. */
function sessionDirs(home: string): Map<string, string> {
  const dirs = new Map<string, string>();
  const root = join(home, 'sessions');
  if (!existsSync(root)) return dirs;
  for (const project of readdirSync(root)) {
    for (const id of readdirSync(join(root, project))) dirs.set(id, join(root, project, id));
  }
  return dirs;
}
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

  async function turn(
    manager: Manager,
    sessionId: string,
    text: string,
    owner: number,
    model?: string
  ) {
    const from = events.length;
    attempt += 1;
    const requestId = await manager.send({
      sessionId,
      attemptId: `attempt-${attempt}`,
      text,
      ownerWebContentsId: owner,
      ...(model ? { model } : {}),
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

  /** P1-5: set in beforeAll, once the gateway's port is known. */
  let port = 0;
  let plan: DshModelPlan;
  /** Main's model source as production wires it: the plan, and a broker over a catalog. */
  const modelSource = (
    auth: () => Record<string, unknown> | undefined = () => ({
      'aiclient-gateway': { type: 'api_key', key: FAKE_KEY },
    })
  ) => ({
    plan: () => plan,
    credentials: new DshCredentialBroker({ readAuth: auth }),
  });

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
      // Retired by P1-5; a stale one must not matter.
      'AICLIENT_DSH_GATEWAY_URL',
      'AICLIENT_DSH_GATEWAY_KEY',
      'TMPDIR',
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
    port = await new Promise<number>((done, fail) => {
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
    // P1-5: the plan every host is configured with; the app's singleton gets the
    // model source production installs at startup (dshHostModelSource.ts).
    plan = gatewayPlan(port);
    dshHostSupervisor.setModelSource(modelSource());
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
          ...BYPASS,
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
      // P1-4d2 (decision 113): Main drops what a slot sends before it is ready,
      // so the bridge holds each session's projection baseline until its first
      // event; here it reaches the renderer's side, ahead of the turn's echo.
      for (const id of ['s1', 's2', 's3']) {
        const seen = forSession(id);
        const projected = seen.filter((e) => e.type === 'session.projection');
        expect(projected.map((e) => e.payload?.key)).toEqual(['todos', 'goal', 'subagentCatalog']);
        expect(seen.indexOf(projected[0] as Event)).toBeLessThan(
          seen.findIndex((e) => e.type === 'message.started')
        );
      }
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
        // P1-3c found a systemd scope outlives the host that opened it (the
        // tool ran on for its full 20 s). Decision 075 (P1-3d): the supervisor
        // stops the dead pid's scopes before it starts the next host, so the
        // tool is gone by the time the sessions are back.
        const gone = await until(
          () => processesWith(`sleep-tool ${sleeper}`).length === 0,
          SCOPE_STOP_BOUND_MS
        );
        console.log(
          `[p1-3] systemd scope: the killed host's tool ${gone ? 'gone' : 'STILL RUNNING'} ` +
            `${Date.now() - firstKillAt} ms after the kill`
        );
        expect(gone).toBe(true);
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
        ...BYPASS,
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

    // P1-3d (decision 024). The run's own pass (24 h grace, this manager has
    // no index) went by after the first open; this one asks for a zero grace.
    it('collects an orphaned empty session, and only that', async () => {
      expect(hostLines.some((line) => line.includes('DSH session collection: deleted 0'))).toBe(
        true
      );
      const home = join(shared.stateRoot, 'dsh-home');
      const stubs: Record<string, string> = {};
      for (const [index, id] of ['g-empty', 'g-claimed', 'g-content'].entries()) {
        await manager.createSession({
          ...BYPASS,
          sessionId: id,
          workspacePath: workspace,
          ownerWebContentsId: 20 + index,
        });
        if (id === 'g-content') {
          const done = await turn(manager, id, 'P0-STREAM: stream a paragraph back to me.', 22);
          expect(done).toMatchObject({ settled: true, completed: true });
        }
        stubs[id] = String(
          manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === id)?.sessionFile
        );
        await manager.closeSession(id);
      }
      // An empty session still open: its lock is held.
      await manager.createSession({
        ...BYPASS,
        sessionId: 'g-live',
        workspacePath: workspace,
        ownerWebContentsId: 23,
      });
      const before = sessionDirs(home);
      for (const id of ['g-empty', 'g-claimed', 'g-content'])
        expect(before.has(`aiclient-${id}`), id).toBe(true);

      const result = await dshHostSupervisor.collectSessions({
        claimed: ['aiclient-g-claimed'],
        graceMs: 0,
      });
      console.log(`[p1-3] gc: ${JSON.stringify(result)}`);
      expect(result).toMatchObject({ ok: true, deleted: ['aiclient-g-empty'], stubsDeleted: 1 });
      // s1..s4 and g-content hold turns; g-live is empty but open.
      expect(result.skipped).toMatchObject({ claimed: 1, locked: 1, content: 5 });
      const after = sessionDirs(home);
      expect(after.has('aiclient-g-empty')).toBe(false);
      expect(existsSync(stubs['g-empty'])).toBe(false);
      // The project directory stays for the sessions beside it.
      expect(existsSync(dirname(before.get('aiclient-g-empty') ?? ''))).toBe(true);
      for (const id of ['g-claimed', 'g-content', 'g-live', 's1', 's4']) {
        expect(after.has(`aiclient-${id}`), id).toBe(true);
      }
      expect(existsSync(stubs['g-claimed'])).toBe(true);

      // The deleted one reads as missing; the one with content reopens with its turn.
      await expect(
        manager.resumeSession({
          ...BYPASS,
          sessionId: 'g-empty',
          sessionFile: stubs['g-empty'],
          workspacePath: workspace,
          ownerWebContentsId: 20,
        })
      ).rejects.toThrow(/dsh_session_missing/);
      const from = events.length;
      await manager.resumeSession({
        ...BYPASS,
        sessionId: 'g-content',
        sessionFile: stubs['g-content'],
        workspacePath: workspace,
        ownerWebContentsId: 22,
      });
      const history = forSession('g-content', from).find((e) => e.type === 'session.history');
      expect((history?.payload?.messages as unknown[] | undefined)?.length).toBeGreaterThan(0);
      await manager.closeSession('g-content');
      await manager.closeSession('g-live');
      expect(dshHostSupervisor.status()).toMatchObject({ state: 'ready', channels: 3 });
    }, 180_000);
  });

  /** Phase two: a supervisor of its own, so its restart budget starts fresh. */
  describe('a fresh supervisor: a hung host, and Stop ladder B', () => {
    let supervisor: Supervisor;
    let manager: Manager;

    beforeAll(async () => {
      supervisor = new DshHostSupervisor({ modelSource: modelSource() });
      manager = newManager(supervisor, true);
      for (const [index, id] of ['b1', 'b2', 'b3'].entries()) {
        tokens[id] = `P13C${id.toUpperCase()}${Date.now() % 100_000}`;
        await manager.createSession({
          ...BYPASS,
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
  /** Phase three (P1-3d): a channel that will not close on close, then the idle stop. */
  describe('a third supervisor: a close that never lands, and the idle stop', () => {
    let supervisor: Supervisor;
    let manager: Manager;
    const channelOf = new Map<string, string>();
    let wedged: string | undefined;

    beforeAll(async () => {
      supervisor = new DshHostSupervisor({ idleStopMs: IDLE_STOP_MS, modelSource: modelSource() });
      manager = newManager(supervisor, true);
      // Remembers each session's channel; drops what the wedged one is sent to close.
      shared.dropToHost = (message) => {
        const record = message as {
          ch?: string;
          host?: string;
          rpc?: { type?: string; payload?: { logicalSessionId?: string } };
        };
        const id = record.rpc?.payload?.logicalSessionId;
        if (record.rpc?.type === 'worker.bootstrap' && record.ch && id)
          channelOf.set(id, record.ch);
        if (wedged === undefined || record.ch !== wedged) return false;
        return record.rpc?.type === 'worker.dispose' || record.host === 'close';
      };
      for (const [index, id] of ['k1', 'k2'].entries()) {
        await manager.createSession({
          ...BYPASS,
          sessionId: id,
          workspacePath: workspace,
          ownerWebContentsId: 30 + index,
        });
      }
      const done = await turn(manager, 'k2', 'P0-STREAM: stream a paragraph back to me.', 31);
      expect(done).toMatchObject({ settled: true, completed: true });
      expect(liveHosts()).toHaveLength(1);
    }, 180_000);

    afterAll(async () => {
      shared.dropToHost = null;
      await manager?.disposeAll('app-shutdown');
      expect(supervisor.status()).toMatchObject({ state: 'disposed' });
      expect(liveHosts()).toHaveLength(0);
    }, 60_000);

    it('closing a session whose channel never closes restarts the host once; the other comes back', async () => {
      wedged = channelOf.get('k1');
      expect(wedged).toBeDefined();
      const hostBefore = supervisor.status();
      const [oldHost] = liveHosts();
      const from = events.length;
      const started = Date.now();
      await manager.closeSession('k1');
      const closedMs = Date.now() - started;
      const tookMs = await recovered(['k2'], from, 60_000);
      console.log(
        `[p1-3] stuck close: closeSession returned after ${closedMs} ms (host restarted), ` +
          `k2 idle ${tookMs} ms later: ${told('k2', from).join(' ')}`
      );
      expect(tookMs).toBeGreaterThanOrEqual(0);
      expect(oldHost.exitCode !== null || oldHost.signalCode !== null).toBe(true);
      expect(liveHosts()).toHaveLength(1);
      expect(supervisor.status()).toMatchObject({
        state: 'ready',
        generation: hostBefore.generation + 1,
        channels: 1,
        lastExit: { reason: 'stuck-session' },
      });
      expect(told('k2', from)[0]).toBe('status:disconnected/engine_restarted');
      expect(manager.getSlotSnapshots().map((slot) => [slot.logicalSessionId, slot.state])).toEqual(
        [['k2', 'ready']]
      );
      wedged = undefined;
      const after = await turn(manager, 'k2', 'P0-STREAM: stream a paragraph back to me.', 31);
      expect(after).toMatchObject({ settled: true, completed: true });
    }, 120_000);

    it('stops the host gracefully once no session is left, and the next session starts a new one', async () => {
      const hostBefore = supervisor.status();
      const [host] = liveHosts();
      await manager.closeSession('k2');
      expect(supervisor.status().channels).toBe(0);
      const started = Date.now();
      expect(
        await until(() => supervisor.status().lastExit?.reason === 'idle', IDLE_STOP_MS + 15_000)
      ).toBe(true);
      const stoppedMs = Date.now() - started;
      console.log(`[p1-3] idle stop: host stopped ${stoppedMs} ms after the last close`);
      expect(stoppedMs).toBeGreaterThanOrEqual(IDLE_STOP_MS - 500);
      expect(host.signalCode).toBeNull();
      expect(host.exitCode).toBe(0);
      expect(supervisor.status()).toMatchObject({
        state: 'idle',
        recentFaults: hostBefore.recentFaults,
        lastExit: { reason: 'idle', code: 0, signal: null },
      });
      expect(liveHosts()).toHaveLength(0);
      await manager.createSession({
        ...BYPASS,
        sessionId: 'k3',
        workspacePath: workspace,
        ownerWebContentsId: 32,
      });
      const done = await turn(manager, 'k3', 'P0-STREAM: stream a paragraph back to me.', 32);
      expect(done).toMatchObject({ settled: true, completed: true });
      expect(supervisor.status()).toMatchObject({
        state: 'ready',
        generation: hostBefore.generation + 1,
      });
      expect(liveHosts()).toHaveLength(1);
    }, 120_000);
  });

  /**
   * Phase four (P1-4a, decision 030): Main's preview of a DSH session is read
   * by the host — no channel, no lock, no write — and shows what the same
   * session's resume then answers as its first page.
   */
  describe('a fourth supervisor: the read-only preview (P1-4a, decision 030)', () => {
    let supervisor: Supervisor;
    let manager: Manager;
    let successor: Supervisor | undefined;
    let successorManager: Manager | undefined;

    /** Every file of one session's log directory, and its stub: size, digest and mtime. */
    function onDisk(dshSessionId: string, stubFile: string) {
      const dir = sessionDirs(join(shared.stateRoot, 'dsh-home')).get(dshSessionId);
      expect(dir, dshSessionId).toBeDefined();
      const files = [
        ...readdirSync(dir as string).map((name) => join(dir as string, name)),
        stubFile,
      ];
      return files.sort().map((file) => {
        const stat = statSync(file);
        return {
          file: file.slice(shared.stateRoot.length),
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
        };
      });
    }

    /** The page a resume published as its first `session.history`. */
    function resumedPage(id: string, from: number) {
      const payload: Record<string, unknown> =
        forSession(id, from).find((e) => e.type === 'session.history')?.payload ?? {};
      const { messages, offset, limit, totalCount, hasMore } = payload;
      return { messages, offset, limit, totalCount, hasMore };
    }

    const stubOf = (owner: Manager, id: string) =>
      String(owner.getSlotSnapshots().find((slot) => slot.logicalSessionId === id)?.sessionFile);

    /** Epoch stamps and `settledAt` out: a closer DSH writes on resume is stamped then. */
    function stampless(value: unknown): unknown {
      if (typeof value === 'number') return value >= 1e12 && value < 1e13 ? '<ms>' : value;
      if (Array.isArray(value)) return value.map(stampless);
      if (typeof value === 'object' && value !== null)
        return Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== 'settledAt')
            .map(([key, item]) => [key, stampless(item)])
        );
      return value;
    }

    beforeAll(() => {
      supervisor = new DshHostSupervisor({ idleStopMs: 0, modelSource: modelSource() });
      manager = newManager(supervisor, true);
    });

    afterAll(async () => {
      await successorManager?.disposeAll('app-shutdown');
      await manager?.disposeAll('app-shutdown');
      expect(liveHosts()).toHaveLength(0);
    }, 60_000);

    it('reads a closed session without opening or writing it: the page its resume then answers', async () => {
      await manager.createSession({
        ...BYPASS,
        sessionId: 'r1',
        workspacePath: workspace,
        ownerWebContentsId: 40,
      });
      for (const text of [
        'P0-STREAM: stream a paragraph back to me.',
        'P0-TOOL: list the workspace.',
      ]) {
        expect(await turn(manager, 'r1', text, 40)).toMatchObject({
          settled: true,
          completed: true,
        });
      }
      const stubFile = stubOf(manager, 'r1');
      await manager.closeSession('r1');
      const before = onDisk('aiclient-r1', stubFile);
      const started = Date.now();
      const page = await supervisor.readPage({ stubFile, logicalSessionId: 'r1', limit: 80 });
      const tookMs = Date.now() - started;
      expect(onDisk('aiclient-r1', stubFile)).toEqual(before);
      expect(supervisor.status()).toMatchObject({ state: 'ready', channels: 0 });
      expect(page.messages.length).toBeGreaterThanOrEqual(4);

      const from = events.length;
      await manager.resumeSession({
        ...BYPASS,
        sessionId: 'r1',
        sessionFile: stubFile,
        workspacePath: workspace,
        ownerWebContentsId: 40,
      });
      expect(resumedPage('r1', from)).toEqual(page);
      const resumeWrote =
        JSON.stringify(onDisk('aiclient-r1', stubFile)) !== JSON.stringify(before);
      console.log(
        `[p1-4a] preview of a closed session: ${page.messages.length} of ${page.totalCount} rows ` +
          `in ${tookMs} ms, log untouched; the resume that followed ${resumeWrote ? 'did' : 'did not'} write`
      );
      await manager.closeSession('r1');
    }, 180_000);

    it('reads a session whose host died mid-call: the turn closes in memory only, as its resume shows it', async () => {
      await manager.createSession({
        ...BYPASS,
        sessionId: 'r2',
        workspacePath: workspace,
        ownerWebContentsId: 41,
      });
      const stubFile = stubOf(manager, 'r2');
      const sleeper = `P14ASLEEP${Date.now() % 100_000}`;
      const from = events.length;
      attempt += 1;
      await manager.send({
        sessionId: 'r2',
        attemptId: `attempt-${attempt}`,
        text: `P0-SLEEPTOOL {"token":"${sleeper}","seconds":8} 跑一个慢命令。`,
        ownerWebContentsId: 41,
      });
      expect(
        await until(() => forSession('r2', from).some((e) => e.type === 'tool.started'), 60_000)
      ).toBe(true);
      expect(await until(() => processesWith(`sleep-tool ${sleeper}`).length > 0, 15_000)).toBe(
        true
      );
      // Terminal for this supervisor, so nothing resumes r2 behind the preview's back.
      supervisor.forceKillNow();
      expect(await until(() => liveHosts().length === 0, 15_000)).toBe(true);

      successor = new DshHostSupervisor({ idleStopMs: 0, modelSource: modelSource() });
      successorManager = newManager(successor, true);
      const before = onDisk('aiclient-r2', stubFile);
      const page = await successor.readPage({ stubFile, logicalSessionId: 'r2', limit: 80 });
      expect(onDisk('aiclient-r2', stubFile)).toEqual(before);
      expect(successor.status()).toMatchObject({ state: 'ready', channels: 0 });
      const results = page.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'tool_result');
      expect(results.at(-1)).toMatchObject({ ok: false, outcomeUnknown: true });
      expect(page.messages.at(-1)).toMatchObject({
        role: 'system',
        blocks: [
          { notice: { key: 'This turn was interrupted when the engine stopped unexpectedly.' } },
        ],
      });

      const resumedFrom = events.length;
      await successorManager.resumeSession({
        ...BYPASS,
        sessionId: 'r2',
        sessionFile: stubFile,
        workspacePath: workspace,
        ownerWebContentsId: 41,
      });
      const resumed = resumedPage('r2', resumedFrom);
      expect(stampless(resumed)).toEqual(stampless(page));
      const resumeWrote =
        JSON.stringify(onDisk('aiclient-r2', stubFile)) !== JSON.stringify(before);
      console.log(
        `[p1-4a] preview after a SIGKILL mid-call: ${page.messages.length} rows, the interrupted ` +
          `turn closed in memory, log untouched; the resume ${resumeWrote ? 'wrote' : 'did not write'} ` +
          `its closer; pages equal ${JSON.stringify(resumed) === JSON.stringify(page) ? 'exactly' : 'but for stamps'}`
      );
      expect(resumeWrote).toBe(true);
      await successorManager.closeSession('r2');
    }, 180_000);
  });

  describe('a fifth supervisor: rewind and fork (P1-4b, decision 027)', () => {
    let supervisor: Supervisor;
    let manager: Manager;
    let sequence = 0;
    const RECALL = 'P0-RECALL {"markers":["IT-KEEP-1","IT-DROP-2"]} which markers do you see?';

    const tree = async (id: string) =>
      (
        await manager.getSessionTree({
          sessionId: id,
          requestSequence: ++sequence,
          ownerWebContentsId: 50,
        })
      ).snapshot;
    const nodeWith = (
      snapshot: { nodes: Array<{ id: string; preview?: string }> },
      text: string
    ) => {
      const index = snapshot.nodes.findIndex((node) => node.preview?.includes(text));
      expect(index, text).toBeGreaterThanOrEqual(0);
      return { node: snapshot.nodes[index], next: snapshot.nodes[index + 1] };
    };
    const stubOf = (id: string) =>
      String(manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === id)?.sessionFile);

    beforeAll(() => {
      supervisor = new DshHostSupervisor({ idleStopMs: 0, modelSource: modelSource() });
      manager = newManager(supervisor, true);
    });

    afterAll(async () => {
      await manager?.disposeAll('app-shutdown');
      expect(liveHosts()).toHaveLength(0);
    }, 60_000);

    it('rewinds: the next turn does not see what was cut off, and the tree keeps it as a branch', async () => {
      await manager.createSession({
        ...BYPASS,
        sessionId: 'w1',
        workspacePath: workspace,
        ownerWebContentsId: 50,
      });
      for (const text of ['alpha IT-KEEP-1, no scenario.', 'beta IT-DROP-2, no scenario.']) {
        expect(await turn(manager, 'w1', text, 50)).toMatchObject({
          settled: true,
          completed: true,
        });
      }
      const stubFile = stubOf('w1');
      const target = nodeWith(await tree('w1'), 'IT-DROP-2').node;

      const rewound = await manager.rewindSession({
        sessionId: 'w1',
        entryId: String(target?.id),
        confirmed: true,
        ownerWebContentsId: 50,
      });

      expect(rewound.editorText).toBe('beta IT-DROP-2, no scenario.');
      expect(rewound.leaf.fileTailEntryId).toMatch(/^aiclient-w1\.r2#\d+$/);
      // Same identity for Main: the stub path did not move, it points at the child.
      expect(stubOf('w1')).toBe(stubFile);
      const stub = JSON.parse(readFileSync(stubFile, 'utf8'));
      expect(stub).toMatchObject({ version: 2, dshSessionId: 'aiclient-w1.r2' });
      expect(stub.lineage.map((entry: { dshSessionId: string }) => entry.dshSessionId)).toEqual([
        'aiclient-w1',
        'aiclient-w1.r2',
      ]);

      const recall = await turn(manager, 'w1', RECALL, 50);
      expect(recall).toMatchObject({ settled: true, completed: true });
      expect(recall.reply).toContain('P0-RECALL present=IT-KEEP-1 missing=IT-DROP-2');
      const after = await tree('w1');
      const retired = after.nodes.filter((node) => !node.active).map((node) => node.preview);
      expect(retired).toContain('beta IT-DROP-2, no scenario.');
      expect(after.nodes.find((node) => node.leaf)?.preview).toContain(
        'P0-RECALL present=IT-KEEP-1'
      );

      // Reopened from its stub: the child, with the retired branch still in the tree.
      await manager.closeSession('w1');
      const page = await supervisor.readPage({ stubFile, logicalSessionId: 'w1', limit: 80 });
      expect(page.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      await manager.resumeSession({
        ...BYPASS,
        sessionId: 'w1',
        sessionFile: stubFile,
        workspacePath: workspace,
        ownerWebContentsId: 50,
      });
      const reopened = await tree('w1');
      expect(reopened.nodes.filter((node) => !node.active).map((node) => node.preview)).toEqual(
        retired
      );
      console.log(
        `[p1-4b] rewind: ${after.totalNodes} nodes after, ${retired.length} on the retired branch; ` +
          `the model saw ${recall.reply.trim()}`
      );
    }, 240_000);

    it('forks: the child answers from the fork point, the source goes on with its own history', async () => {
      const answer = nodeWith(await tree('w1'), 'IT-KEEP-1').next;
      const forked = await manager.forkSession({
        sourceSessionId: 'w1',
        entryId: String(answer?.id),
        sourceTitle: 'W1',
        ownerWebContentsId: 50,
      });
      const child = forked.session.sessionId;
      expect(forked.session).toMatchObject({ agent: 'dsh', title: 'W1 (fork)' });
      // Named after the id Main minted before asking (decision 027 rule 4), and adopted.
      expect(forked.session.runtimeIdentity).toMatch(
        new RegExp(`aiclient-sessions/aiclient-${child}\\.dsh\\.json$`)
      );
      expect(existsSync(`${forked.session.runtimeIdentity}.staged`)).toBe(false);

      const childRecall = await turn(manager, child, RECALL, 50);
      expect(childRecall).toMatchObject({ settled: true, completed: true });
      expect(childRecall.reply).toContain('P0-RECALL present=IT-KEEP-1 missing=IT-DROP-2');
      expect(await turn(manager, 'w1', 'gamma after the fork, no scenario.', 50)).toMatchObject({
        settled: true,
        completed: true,
      });
      expect((await tree(child)).nodes.map((node) => node.active)).not.toContain(false);
      console.log(
        `[p1-4b] fork: the child saw ${childRecall.reply.trim()}; the source took a turn after`
      );
      await manager.closeSession(child);
      await manager.closeSession('w1');
    }, 240_000);
  });

  /**
   * P1-5 (decisions 033, 034, 038; plan P1-5 shard 05 §3 IT-01..IT-06): a
   * supervisor whose plan has two routes on the fake gateway, each with its
   * own key, served by a broker over a catalog this test controls.
   */
  describe('a sixth supervisor: routes, keys and KEY-CANARY (P1-5)', () => {
    const canary = `sk-canary-${randomBytes(12).toString('hex')}`;
    const second = `sk-second-${randomBytes(12).toString('hex')}`;
    const rotated = `sk-rotated-${randomBytes(12).toString('hex')}`;
    let auth: Record<string, unknown> | undefined;
    let twoRoutes: DshModelPlan;
    let credentials: InstanceType<typeof DshCredentialBroker>;
    let supervisor: Supervisor;
    let manager: Manager;
    let tmpDir = '';
    /** What Main wrote to its own log in this phase (console, redacted host stderr). */
    const mainLines: string[] = [];
    const scanned = { environ: '', cmdline: '', toolEnv: '', rawFrom: 0, hostLinesFrom: 0 };

    /** The gateway's request log; it appears with the first request. */
    const gatewayLines = () => {
      const file = join(shared.stateRoot, 'gateway.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    };
    const failedCode = (id: string, from: number) =>
      forSession(id, from).find((e) => e.type === 'session.failed')?.payload?.errorCode;

    beforeAll(() => {
      tmpDir = join(shared.stateRoot, 'tmp-canary');
      mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      // The host (and every tool it runs) inherits it: its temp files are scanned too.
      process.env.TMPDIR = tmpDir;
      auth = {
        'aiclient-gateway': { type: 'api_key', key: canary },
        'second-gw': { type: 'api_key', key: second },
      };
      twoRoutes = gatewayPlan(port, {
        'second-gw': {
          baseUrl: `http://127.0.0.1:${port}/second`,
          api: 'anthropic-messages',
          models: [{ id: 'fake-2', name: 'Second fake', contextWindow: 100_000, maxTokens: 4096 }],
        },
      });
      credentials = new DshCredentialBroker({
        readAuth: () => auth,
        log: (...args) => mainLines.push(args.map(String).join(' ')),
      });
      supervisor = new DshHostSupervisor({
        idleStopMs: 0,
        modelSource: { plan: () => twoRoutes, credentials },
        logLine: (line) => mainLines.push(line),
      });
      manager = newManager(supervisor, true);
      scanned.rawFrom = shared.rawStderr.length;
      for (const level of ['warn', 'error'] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          mainLines.push(args.map(String).join(' '));
        });
      }
    });

    afterAll(async () => {
      await manager?.disposeAll('app-shutdown');
      delete process.env.TMPDIR;
      expect(liveHosts()).toHaveLength(0);
    }, 60_000);

    it('[IT-01, IT-04] routes each turn to the model it names, each route with its own key', async () => {
      await manager.createSession({
        ...BYPASS,
        sessionId: 'c1',
        workspacePath: workspace,
        ownerWebContentsId: 60,
      });
      const hostPid = supervisor.status().pid;
      expect(supervisor.status()).toMatchObject({
        planRevision: twoRoutes.revision,
        routeDiagnostics: [],
      });
      const seen = gatewayLines().length;
      const first = await turn(manager, 'c1', 'P0-STREAM: stream a paragraph back to me.', 60);
      expect(first).toMatchObject({ settled: true, completed: true });
      const switched = await turn(
        manager,
        'c1',
        'P0-STREAM: again, on the second model.',
        60,
        'second-gw/fake-2'
      );
      expect(switched).toMatchObject({ settled: true, completed: true });
      const lines = gatewayLines().slice(seen);
      expect(
        lines.map((line) => [line.model, line.auth, String(line.path).replace(/\?.*$/, '')])
      ).toEqual([
        ['fake-1', digestOf(canary), '/v1/messages'],
        ['fake-2', digestOf(second), '/second/v1/messages'],
      ]);
      // Decision 037's default: DSH's User-Agent, and our identity header beside it.
      expect(new Set(lines.map((line) => line.clientHeader))).toEqual(new Set(['it-p1-5']));
      const agents = [...new Set(lines.map((line) => String(line.userAgent)))];
      expect(agents.every((agent) => agent.startsWith('deepseek-harness/'))).toBe(true);
      process.stderr.write(`[p1-5] User-Agent sent: ${agents.join(', ')}\n`);
      // The model switch is a DSH notice in the log, and message.started names our id.
      const log = textsUnder(
        sessionDirs(join(shared.stateRoot, 'dsh-home')).get('aiclient-c1') ?? ''
      )
        .map((item) => item.text)
        .join('\n');
      expect(log).toContain('"kind":"model-selection"');
      const models = forSession('c1')
        .filter((e) => e.type === 'message.started' && e.payload?.role === 'assistant')
        .map((e) => e.payload?.model);
      expect(new Set(models)).toEqual(new Set(['aiclient-gateway/fake-1', 'second-gw/fake-2']));
      expect(supervisor.status().pid).toBe(hostPid);
    }, 180_000);

    it('[IT-02] a rotated key reaches the next request, without a host restart', async () => {
      const generation = supervisor.status().generation;
      auth = { ...auth, 'aiclient-gateway': { type: 'api_key', key: rotated } };
      // What the vault's change listener does in production.
      credentials.invalidate();
      const seen = gatewayLines().length;
      const done = await turn(
        manager,
        'c1',
        'P0-STREAM: after the key changed.',
        60,
        'aiclient-gateway/fake-1'
      );
      expect(done).toMatchObject({ settled: true, completed: true });
      expect(
        gatewayLines()
          .slice(seen)
          .map((line) => line.auth)
      ).toEqual([digestOf(rotated)]);
      expect(supervisor.status().generation).toBe(generation);
      auth = { ...auth, 'aiclient-gateway': { type: 'api_key', key: canary } };
      credentials.invalidate();
    }, 120_000);

    it('[IT-03] signed out: the turn fails as CREDENTIALS_UNAVAILABLE and reaches no gateway', async () => {
      const kept = auth;
      auth = undefined;
      credentials.invalidate();
      const seen = gatewayLines().length;
      const from = events.length;
      const done = await turn(manager, 'c1', 'P0-STREAM: while signed out.', 60);
      expect(done.settled).toBe(true);
      expect(failedCode('c1', from)).toBe('CREDENTIALS_UNAVAILABLE');
      expect(gatewayLines().length).toBe(seen);
      auth = kept;
      credentials.invalidate();
    }, 120_000);

    it('[IT-06] KEY-CANARY: the key is nowhere but in the requests the gateway got', async () => {
      const pid = supervisor.status().pid as number;
      const dumped = await turn(manager, 'c1', 'P1-ENVDUMP: print the tool environment.', 60);
      expect(dumped).toMatchObject({ settled: true, completed: true });
      const tools = forSession('c1').filter((e) => e.type === 'tool.completed');
      scanned.toolEnv = String(tools.at(-1)?.payload?.output ?? '');
      expect(scanned.toolEnv).toContain('PATH=');
      scanned.environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
      scanned.cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      // The provider repeats the key in its error (echo-key-error).
      const from = events.length;
      const echoed = await turn(manager, 'c1', 'P1-ECHOKEY: the upstream repeats the key.', 60);
      expect(echoed.settled).toBe(true);
      const failed = forSession('c1', from).find((e) => e.type === 'session.failed');
      expect(failed?.payload?.errorCode).toBe('PROVIDER_UNAUTHORIZED');
      expect(String(failed?.payload?.error)).toContain('P1-ECHOKEY');
      expect(String(failed?.payload?.error).includes(canary)).toBe(false);
      // Everything on disk is written once the host is gone.
      await manager.disposeAll('app-shutdown');
      expect(await until(() => liveHosts().length === 0, 15_000)).toBe(true);

      const home = join(shared.stateRoot, 'dsh-home');
      const onDisk = textsUnder(home);
      const inTmp = textsUnder(tmpDir);
      const rawStderr = shared.rawStderr.slice(scanned.rawFrom).join('');
      const gatewayLog = JSON.stringify(gatewayLines());
      const hits = (text: string) => text.includes(canary);
      const report = {
        dshHome: onDisk
          .filter((item) => hits(item.text))
          .map((item) => item.file.slice(home.length)),
        tmp: inTmp.filter((item) => hits(item.text)).map((item) => item.file.slice(tmpDir.length)),
        hostStderr: hits(rawStderr),
        mainLog: hits(mainLines.join('\n')) || hits(hostLines.join('\n')),
        hostEnviron: hits(scanned.environ) || hits(scanned.cmdline),
        toolEnv: hits(scanned.toolEnv),
        gatewayLog: hits(gatewayLog),
        renderer: hits(JSON.stringify(forSession('c1'))),
      };
      const decoded = onDisk.filter((item) => item.decoded).length;
      process.stderr.write(
        `[p1-5] KEY-CANARY scanned ${onDisk.length} files under DSH_HOME (${decoded} zstd-decoded), ` +
          `${inTmp.length} under TMPDIR, ${rawStderr.length} B of host stderr, ` +
          `${mainLines.length} Main log lines\n`
      );
      // The session logs were read as text, not as compressed bytes.
      expect(decoded).toBeGreaterThan(0);
      expect(report).toEqual({
        dshHome: [],
        tmp: [],
        hostStderr: false,
        mainLog: false,
        hostEnviron: false,
        toolEnv: false,
        gatewayLog: false,
        renderer: false,
      });
      // The echo reached the log masked, and the plain-text store was never created.
      const echoLog = onDisk.find((item) => item.text.includes('P1-ECHOKEY: invalid x-api-key'));
      expect(echoLog?.text).toContain('[redacted]');
      expect(existsSync(join(home, '.credentials.yaml'))).toBe(false);
      // No key reference name reaches a tool either.
      expect(scanned.toolEnv).not.toMatch(/^AICLIENT_KEY_/m);
    }, 240_000);
  });

  /**
   * P1-6b part 2 (decisions 042, 044): the app's own gate on the real host.
   * This phase's session opens in `ask`, Main's default, so every call raises
   * the 1.0.x card, answered through `respondPermission` as the renderer
   * answers it; DSH's sandbox is off, so nothing else asks.
   */
  describe('a seventh supervisor: the permission gate, cards round trip (P1-6b)', () => {
    let supervisor: Supervisor;
    let manager: Manager;

    beforeAll(() => {
      supervisor = new DshHostSupervisor({ idleStopMs: 0, modelSource: modelSource() });
      manager = newManager(supervisor, true);
    });

    afterAll(async () => {
      await manager?.disposeAll('app-shutdown');
      expect(liveHosts()).toHaveLength(0);
    }, 60_000);

    /** One P0-TOOL turn on `g1`, from its send to its first card. */
    async function toolTurnToCard() {
      const from = events.length;
      attempt += 1;
      const requestId = await manager.send({
        sessionId: 'g1',
        attemptId: `attempt-${attempt}`,
        text: 'P0-TOOL: list the workspace.',
        ownerWebContentsId: 70,
      });
      expect(
        await until(
          () => forSession('g1', from).some((e) => e.type === 'permission.requested'),
          60_000
        )
      ).toBe(true);
      const card = forSession('g1', from).find((e) => e.type === 'permission.requested');
      return { from, requestId, card, permissionId: String(card?.payload?.permissionId) };
    }
    const idleAfter = (from: number, requestId: string) =>
      until(
        () =>
          forSession('g1', from).some(
            (e) =>
              e.requestId === requestId &&
              e.type === 'session.status' &&
              e.payload?.status === 'idle'
          ),
        120_000
      );
    const ofType = (from: number, type: string) =>
      forSession('g1', from)
        .filter((e) => e.type === type)
        .map((e) => e.payload);

    it('allow: the card carries the call inside its turn, the answer comes back, the command runs', async () => {
      await manager.createSession({
        sessionId: 'g1',
        workspacePath: workspace,
        ownerWebContentsId: 70,
      });
      const { from, requestId, card, permissionId } = await toolTurnToCard();
      expect(card).toMatchObject({
        requestId,
        payload: {
          toolName: 'bash',
          action: 'run_command',
          kind: 'exec',
          decisions: ['allow', 'allow_session', 'deny'],
          timeoutMs: 120_000,
          queuePosition: 1,
          queueDepth: 1,
        },
      });
      expect(
        await manager.respondPermission({ sessionId: 'g1', permissionId, decision: 'allow' })
      ).toBe(true);
      expect(await idleAfter(from, requestId)).toBe(true);
      expect(ofType(from, 'permission.resolved')).toEqual([
        { permissionId, allow: true, decision: 'allow' },
      ]);
      const tools = ofType(from, 'tool.completed');
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ toolCallId: permissionId, ok: true });
      expect(String(tools[0]?.output)).toContain('bridge tool row ok');
      expect(forSession('g1', from).some((e) => e.type === 'session.completed')).toBe(true);
    }, 180_000);

    it('deny: the call is refused with the 1.0.x wording and never runs', async () => {
      const { from, requestId, permissionId } = await toolTurnToCard();
      expect(
        await manager.respondPermission({ sessionId: 'g1', permissionId, decision: 'deny' })
      ).toBe(true);
      expect(await idleAfter(from, requestId)).toBe(true);
      expect(ofType(from, 'permission.resolved')).toEqual([
        { permissionId, allow: false, decision: 'deny' },
      ]);
      const tools = ofType(from, 'tool.completed');
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ toolCallId: permissionId, ok: false });
      expect(String(tools[0]?.error)).toContain('permission denied');
      expect(String(tools[0]?.error)).not.toContain('bridge tool row ok');
    }, 180_000);

    /** P1-4d3: one P1-QUESTION turn on `g1` (DSH's ask_user_question), from its send to its card. */
    async function questionTurnToCard() {
      const from = events.length;
      attempt += 1;
      const requestId = await manager.send({
        sessionId: 'g1',
        attemptId: `attempt-${attempt}`,
        text: 'P1-QUESTION: ask me before you start.',
        ownerWebContentsId: 70,
      });
      expect(
        await until(
          () => forSession('g1', from).some((e) => e.type === 'question.requested'),
          60_000
        )
      ).toBe(true);
      const card = forSession('g1', from).find((e) => e.type === 'question.requested');
      return { from, requestId, card, questionId: String(card?.payload?.questionId) };
    }

    it('[QST-1] a question of the model reaches Main as the card, ungated, and the answer reaches the model (P1-4d3)', async () => {
      const { from, requestId, card, questionId } = await questionTurnToCard();
      expect(card).toMatchObject({
        requestId,
        payload: {
          questions: [
            { id: 'scope', header: 'Scope' },
            { id: 'checks', header: 'Checks', multiSelect: true },
          ],
        },
      });
      // Decision 098: asking is the interaction; no approval card in front of it.
      expect(ofType(from, 'permission.requested')).toEqual([]);
      const answers = { scope: 'Renderer', checks: 'tsc, smoke, then record' };
      expect(await manager.respondQuestion({ sessionId: 'g1', questionId, answers })).toBe(true);
      expect(await idleAfter(from, requestId)).toBe(true);
      expect(ofType(from, 'question.resolved')).toEqual([
        { questionId, outcome: 'answered', answers },
      ]);
      const tools = ofType(from, 'tool.completed');
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ ok: true });
      expect(JSON.parse(String(tools[0]?.output))).toEqual({
        answers: [
          { id: 'scope', selected: ['Renderer'] },
          { id: 'checks', selected: ['tsc', 'smoke, then record'] },
        ],
      });
      // Settled once: nothing waits on the id any more.
      expect(await manager.respondQuestion({ sessionId: 'g1', questionId, cancel: true })).toBe(
        false
      );
    }, 180_000);

    it('[QST-2] Stop with a question up: the card is taken down and the turn stops (P1-4d3)', async () => {
      const { from, requestId, questionId } = await questionTurnToCard();
      await manager.stop('g1');
      expect(
        await until(
          () =>
            ofType(from, 'question.resolved').length > 0 &&
            forSession('g1', from).some(
              (e) =>
                e.requestId === requestId &&
                e.type === 'session.status' &&
                e.payload?.status === 'idle'
            ),
          STOP_WATCHDOG_BOUND_MS
        )
      ).toBe(true);
      expect(ofType(from, 'question.resolved')).toEqual([{ questionId, outcome: 'cancelled' }]);
      expect(forSession('g1', from).some((e) => e.type === 'session.stopped')).toBe(true);
      expect(
        await manager.respondQuestion({
          sessionId: 'g1',
          questionId,
          answers: { scope: 'Renderer' },
        })
      ).toBe(false);
    }, 180_000);

    it('Stop with a card up: the card is taken down as aborted and the turn ends inside the Stop bound', async () => {
      const { from, requestId, permissionId } = await toolTurnToCard();
      const stoppedAt = Date.now();
      await manager.stop('g1');
      expect(
        await until(
          () =>
            ofType(from, 'permission.resolved').length > 0 &&
            forSession('g1', from).some(
              (e) =>
                e.requestId === requestId &&
                e.type === 'session.status' &&
                e.payload?.status === 'idle'
            ),
          STOP_WATCHDOG_BOUND_MS
        )
      ).toBe(true);
      const elapsed = Date.now() - stoppedAt;
      expect(ofType(from, 'permission.resolved')).toEqual([
        { permissionId, allow: false, decision: 'deny', autoReason: 'aborted' },
      ]);
      expect(forSession('g1', from).some((e) => e.type === 'session.stopped')).toBe(true);
      // Nothing is left to answer, and the command never ran.
      expect(
        await manager.respondPermission({ sessionId: 'g1', permissionId, decision: 'allow' })
      ).toBe(false);
      expect(
        ofType(from, 'tool.completed').some((tool) =>
          String(tool?.output).includes('bridge tool row ok')
        )
      ).toBe(false);
      console.log(`[p1-6b] Stop with a card up settled in ${elapsed} ms`);
      await manager.closeSession('g1');
    }, 180_000);
  });

  /**
   * P1-6c (decisions 043, 092): "allow for this session" is written beside the
   * stub and read back by the host that reopens the session; Main's setter
   * reaches the gate; the user policy layer comes from the directory Main
   * names in the host's environment.
   */
  describe('an eighth supervisor: grants outlive the host, and the posture is Main’s (P1-6c)', () => {
    let supervisor: Supervisor;
    let manager: Manager;
    const stubDir = () => join(shared.stateRoot, 'dsh-home', 'aiclient-sessions');

    beforeAll(() => {
      supervisor = new DshHostSupervisor({ idleStopMs: 0, modelSource: modelSource() });
      manager = newManager(supervisor, true);
    });

    afterAll(async () => {
      await manager?.disposeAll('app-shutdown');
      expect(liveHosts()).toHaveLength(0);
    }, 60_000);

    /** One P0-TOOL turn; every card it raises is answered `decision` (none: left alone). */
    async function toolTurn(sessionId: string, owner: number, decision?: 'allow_session' | 'deny') {
      const from = events.length;
      attempt += 1;
      const requestId = await manager.send({
        sessionId,
        attemptId: `attempt-${attempt}`,
        text: 'P0-TOOL: list the workspace.',
        ownerWebContentsId: owner,
      });
      const answered = new Set<string>();
      const settled = await until(() => {
        for (const card of forSession(sessionId, from)) {
          if (card.type !== 'permission.requested' || !decision) continue;
          const permissionId = String(card.payload?.permissionId);
          if (answered.has(permissionId)) continue;
          answered.add(permissionId);
          void manager.respondPermission({ sessionId, permissionId, decision });
        }
        return forSession(sessionId, from).some(
          (e) =>
            e.requestId === requestId && e.type === 'session.status' && e.payload?.status === 'idle'
        );
      }, 120_000);
      return {
        settled,
        cards: forSession(sessionId, from).filter((e) => e.type === 'permission.requested').length,
        tools: forSession(sessionId, from)
          .filter((e) => e.type === 'tool.completed')
          .map((e) => e.payload),
      };
    }

    it('a grant survives a SIGKILLed host; a posture change from Main then forgets it', async () => {
      await manager.createSession({
        sessionId: 'h1',
        workspacePath: workspace,
        ownerWebContentsId: 80,
      });
      const first = await toolTurn('h1', 80, 'allow_session');
      expect(first).toMatchObject({ settled: true, cards: 1 });
      expect(String(first.tools[0]?.output)).toContain('bridge tool row ok');
      const sidecar = join(stubDir(), 'aiclient-h1.dsh.grants.json');
      const written = JSON.parse(readFileSync(sidecar, 'utf8')) as {
        version: number;
        grants: Array<{ kind: string; prefix?: string }>;
      };
      expect(written.version).toBe(2);
      expect(written.grants.map((grant) => `${grant.kind} ${grant.prefix}`).sort()).toEqual([
        'command echo',
        'command ls',
        'command pwd',
      ]);

      const [host] = liveHosts();
      const killedAt = events.length;
      host.kill('SIGKILL');
      expect(await recovered(['h1'], killedAt, 60_000)).toBeGreaterThanOrEqual(0);
      // The host that reopened the session read the grant back: no card this time.
      const second = await toolTurn('h1', 80);
      expect(second).toMatchObject({ settled: true, cards: 0 });
      expect(String(second.tools[0]?.output)).toContain('bridge tool row ok');

      // Between turns, Main's setter is 1.0.x's configure: the grants go, on disk too.
      await manager.setPermissions('h1', { mode: 'agent', gear: 'ask' });
      expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toEqual({ version: 2, grants: [] });
      const third = await toolTurn('h1', 80, 'deny');
      expect(third).toMatchObject({ settled: true, cards: 1 });
      expect(String(third.tools[0]?.error)).toContain('permission denied');
      await manager.closeSession('h1');
    }, 300_000);

    it("loads the user policy layer from the app's pi-agent directory Main names", async () => {
      const agentDir = join(shared.stateRoot, 'pi-agent');
      mkdirSync(agentDir, { recursive: true });
      const policy = join(agentDir, 'pi-permissions.jsonc');
      writeFileSync(policy, '// P1-6c integration\n{"permission": {"bash": "deny"}}\n');
      try {
        await manager.createSession({
          ...BYPASS,
          sessionId: 'h2',
          workspacePath: workspace,
          ownerWebContentsId: 81,
        });
        const turn = await toolTurn('h2', 81);
        // Refused by the rule, even under bypass, and without a card.
        expect(turn).toMatchObject({ settled: true, cards: 0 });
        expect(turn.tools[0]).toMatchObject({ ok: false });
        expect(String(turn.tools[0]?.error)).toContain('access denied: bash');
        await manager.closeSession('h2');
      } finally {
        rmSync(policy, { force: true });
      }
    }, 180_000);
  });

  /** The drift gate (plan P1-5 shard 05 §3): the shipped catalog's plan, as DSH takes it. */
  describe('the drift gate: the P1-5a plan golden loads with no route diagnostic', () => {
    it('registers every route of the shipped catalog', async () => {
      const golden = JSON.parse(
        readFileSync(
          join(
            REPO,
            'src/main/services/piModelConfig/__tests__/fixtures/dshModelPlan.snapshot.json'
          ),
          'utf8'
        )
      ) as DshModelPlan;
      const supervisor = new DshHostSupervisor({
        idleStopMs: 0,
        modelSource: { plan: () => golden },
      });
      try {
        await supervisor.ensureHost({ userInitiated: true });
        expect(supervisor.status()).toMatchObject({
          state: 'ready',
          planRevision: golden.revision,
          routeDiagnostics: [],
        });
      } finally {
        await supervisor.shutdown('app-quit');
      }
      expect(liveHosts()).toHaveLength(0);
    }, 120_000);
  });

  /**
   * P1-10b (decisions 058, 059, 108, 110): plugins preinstalled the way the
   * product ships them, on scratch host installs built from this checkout
   * (tools/lib/plugin-install.ts: host.js bundled by the build's own rules,
   * node_modules linked onto src/dsh-host's, the test-only fixture plugin or
   * a bad variant of it copied in and listed in the manifest's `plugins`
   * section). A real supervisor spawns every host with Main's environment
   * rule and the plugin overrides of that moment; WorkerManager restarts the
   * host when the selection changes; the supervisor keeps each start's report.
   * PLG-5 also covers decision 110: a packaged host never reads
   * $DSH_HOME/cordis.patch.yml, so a home layer refusal no longer exists.
   * PLG-6 (P1-10d, decision 115) lists the committed allowlist's pilot,
   * dsh-office-tools, the way the build does: off by default, loaded once
   * Main's override turns it on. PLG-1 to PLG-5 list only the fixture, so the
   * pilot never appears in their reports.
   * Nothing in the shared checkout is written.
   */
  describe('a ninth supervisor: preinstalled plugins, enabled, disabled, rejected (P1-10b)', () => {
    type PluginInstall = typeof import('../../../../dsh-host/tools/lib/plugin-install.ts');
    let kit: PluginInstall;
    /** The host entry (`<install>/host.js`) of each scratch install. */
    const installs: Record<'good' | 'undeclared' | 'pilot', string> = {
      good: '',
      undeclared: '',
      pilot: '',
    };
    /** P1-10d: the committed allowlist's pilot plugin (decision 115). */
    const PILOT = 'dsh-office-tools';
    let current = '';
    let selection: Record<string, boolean> | undefined;
    let supervisor: Supervisor;
    let manager: Manager;
    const base = () => join(shared.stateRoot, 'plugins');
    const dshHome = () => join(base(), 'dsh-home');
    const MISSING = '@aiclient-test/dsh-missing-plugin';
    const isScratchHost = (child: ChildProcess) =>
      child.spawnargs.some((arg) => arg.startsWith(base()) && arg.endsWith('host.js'));
    const liveScratchHosts = () => shared.children.filter(isScratchHost).filter(alive);
    const gatewayRequests = () => {
      const file = join(shared.stateRoot, 'gateway.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    };
    /** One P0-STREAM turn on a fresh session; the tool count its model request carried. */
    async function streamTurn(sessionId: string, owner: number) {
      await manager.createSession({
        ...BYPASS,
        sessionId,
        workspacePath: workspace,
        ownerWebContentsId: owner,
      });
      const seen = gatewayRequests().length;
      const result = await turn(
        manager,
        sessionId,
        'P0-STREAM: stream a paragraph back to me.',
        owner
      );
      const tools = gatewayRequests()
        .slice(seen)
        .map((request) => request.tools);
      await manager.closeSession(sessionId);
      return { ...result, tools };
    }
    const profileBundles = () =>
      (
        JSON.parse(
          readFileSync(join(dshHome(), 'profiles', 'aiclient', 'package.json'), 'utf8')
        ) as {
          dsh?: { profile?: { bundles?: string[] } };
        }
      ).dsh?.profile?.bundles;
    /** Main's side of a selection change: store it, reconcile, wait for the old host to go. */
    async function select(next: Record<string, boolean> | undefined) {
      selection = next;
      manager.reconcileHostPlugins(dshPluginSelectionKey(next));
      expect(await until(() => supervisor.status().state !== 'ready', 30_000)).toBe(true);
      expect(await until(() => liveScratchHosts().length === 0, 30_000)).toBe(true);
    }

    beforeAll(async () => {
      kit = await import('../../../../dsh-host/tools/lib/plugin-install.ts');
      const root = base();
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const missing = kit.fixtureManifestEntry({ name: MISSING, rows: ['missing-row'] });
      installs.good = (
        await kit.assembleInstall({
          into: join(root, 'install-good'),
          base: 'source',
          plugins: [{ dir: kit.fixtureVariant(root, 'good'), entry: kit.fixtureManifestEntry() }],
          listOnly: [missing],
        })
      ).entry;
      installs.undeclared = (
        await kit.assembleInstall({
          into: join(root, 'install-undeclared'),
          base: 'source',
          plugins: [
            { dir: kit.fixtureVariant(root, 'undeclared-row'), entry: kit.fixtureManifestEntry() },
          ],
        })
      ).entry;
      // P1-10d: the pilot as the build lists it — the committed allowlist's
      // entry in the manifest, the package itself the one src/dsh-host installed
      // (the scratch node_modules links onto it), so nothing is copied.
      const committed = (
        JSON.parse(
          readFileSync(join(REPO, 'src', 'dsh-host', 'plugins', 'allowlist.json'), 'utf8')
        ) as { plugins: Array<Record<string, unknown>> }
      ).plugins.find((entry) => entry.name === PILOT);
      if (!committed) throw new Error(`${PILOT} is not on the committed allowlist`);
      installs.pilot = (
        await kit.assembleInstall({
          into: join(root, 'install-pilot'),
          base: 'source',
          plugins: [],
          listOnly: [
            {
              name: PILOT,
              version: String(committed.version),
              kind: committed.kind,
              defaultEnabled: committed.defaultEnabled === true,
              rows: committed.rows as string[],
              tools: committed.tools,
              replaces: [],
            },
          ],
        })
      ).entry;
      current = installs.good;
      const hostCwd = join(root, 'host-cwd');
      const nativeCache = join(root, 'native-cache');
      const home = join(root, 'home');
      mkdirSync(home, { recursive: true, mode: 0o700 });
      supervisor = new DshHostSupervisor({
        idleStopMs: 0,
        modelSource: modelSource(),
        resolveLaunch: () => ({
          command: NODE,
          args: ['--expose-internals', current],
          cwd: hostCwd,
          // Main's rule; a scratch HOME keeps the host off this user's own skills.
          env: buildDshHostEnvironment({
            dshHome: dshHome(),
            nativeCacheDir: nativeCache,
            isPackaged: true,
            pluginOverrides: selection,
            env: { ...process.env, HOME: home },
          }),
          privateDirs: [dshHome(), hostCwd, nativeCache],
        }),
      });
      manager = newManager(supervisor, true);
    }, 120_000);

    afterAll(async () => {
      await manager?.disposeAll('app-shutdown');
      expect(await until(() => liveScratchHosts().length === 0, 15_000)).toBe(true);
    }, 60_000);

    it('[PLG-1, PLG-2] an enabled plugin loads from the install directory and its tool reaches the model; switching it off restarts the host without it', async () => {
      selection = { [kit.FIXTURE_PLUGIN]: true };
      const enabled = await streamTurn('pl1', 90);
      expect(enabled).toMatchObject({ settled: true, completed: true });
      expect(supervisor.status()).toMatchObject({
        state: 'ready',
        pluginSelection: dshPluginSelectionKey({ [kit.FIXTURE_PLUGIN]: true }),
      });
      expect(supervisor.pluginReport()).toEqual({
        enabledFrom: 'main',
        plugins: [
          {
            name: kit.FIXTURE_PLUGIN,
            version: kit.FIXTURE_VERSION,
            defaultEnabled: false,
            state: 'loaded',
          },
          { name: MISSING, version: kit.FIXTURE_VERSION, defaultEnabled: false, state: 'disabled' },
        ],
        dropped: [],
      });
      expect(profileBundles()).toEqual([
        '@deepseek-ai/dsh-base',
        '@aiclient/dsh-app',
        kit.FIXTURE_PLUGIN,
      ]);

      // Main's side of the switch (decision 059 rule 4): the running host is
      // on another selection, nothing is in flight, so it goes at once. An
      // explicit `false` override (decision 110), not just an untouched
      // plugin, so the test still exercises the override path even though
      // the fixture's own defaultEnabled is already false.
      await select({ [kit.FIXTURE_PLUGIN]: false });
      const disabled = await streamTurn('pl2', 91);
      expect(disabled).toMatchObject({ settled: true, completed: true });
      expect(supervisor.status().pluginSelection).toBe(
        dshPluginSelectionKey({ [kit.FIXTURE_PLUGIN]: false })
      );
      expect(supervisor.pluginReport()?.plugins[0]).toMatchObject({
        name: kit.FIXTURE_PLUGIN,
        state: 'disabled',
      });
      expect(supervisor.pluginReport()?.dropped).toEqual([
        { name: kit.FIXTURE_PLUGIN, reason: 'not enabled' },
      ]);
      expect(profileBundles()).toEqual(['@deepseek-ai/dsh-base', '@aiclient/dsh-app']);
      // The fixture's one tool, `fixture_ping`, is in the first request only.
      expect(enabled.tools[0]).toBe(Number(disabled.tools[0]) + 1);
    }, 240_000);

    it('[PLG-3] a plugin whose patch inserts an undeclared row is rejected; the host serves without it', async () => {
      current = installs.undeclared;
      await select({ [kit.FIXTURE_PLUGIN]: true });
      const result = await streamTurn('pl3', 92);
      expect(result).toMatchObject({ settled: true, completed: true });
      expect(supervisor.pluginReport()?.plugins).toEqual([
        {
          name: kit.FIXTURE_PLUGIN,
          version: kit.FIXTURE_VERSION,
          defaultEnabled: false,
          state: 'rejected',
          reason: 'bundle patch: patch 1.insert[1]: inserts undeclared row fixture-undeclared',
        },
      ]);
    }, 180_000);

    it('[PLG-4] a plugin enabled but not installed is missing, and a stray bundle the profile lists is dropped', async () => {
      current = installs.good;
      await select({ [kit.FIXTURE_PLUGIN]: true, [MISSING]: true });
      const manifest = join(dshHome(), 'profiles', 'aiclient', 'package.json');
      const tampered = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
      writeFileSync(
        manifest,
        `${JSON.stringify({ ...tampered, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@aiclient/dsh-app', '@evil/bundle'] } } }, null, 2)}\n`
      );
      const result = await streamTurn('pl4', 93);
      expect(result).toMatchObject({ settled: true, completed: true });
      expect(supervisor.pluginReport()).toEqual({
        enabledFrom: 'main',
        plugins: [
          {
            name: kit.FIXTURE_PLUGIN,
            version: kit.FIXTURE_VERSION,
            defaultEnabled: false,
            state: 'loaded',
          },
          {
            name: MISSING,
            version: kit.FIXTURE_VERSION,
            defaultEnabled: false,
            state: 'missing',
            reason: 'not in the install directory',
          },
        ],
        dropped: [{ name: '@evil/bundle', reason: 'not on the allowlist' }],
      });
      expect(profileBundles()).toEqual([
        '@deepseek-ai/dsh-base',
        '@aiclient/dsh-app',
        kit.FIXTURE_PLUGIN,
      ]);
    }, 180_000);

    it('[PLG-5] a packaged host ignores the home layer entirely — a new row and a !!js expression on an existing one both have no effect (decision 110)', async () => {
      await manager.invalidateAll();
      const homePatch = join(dshHome(), 'cordis.patch.yml');
      writeFileSync(
        homePatch,
        [
          // Overrides an existing, always-active product row's config with a
          // !!js expression that throws when evaluated. Decision 108's open
          // question 3: home layer edits can't add rows, but they could still
          // reach into an existing row's config and have DSH evaluate
          // arbitrary JS at composition time. If this file were read at all,
          // boot would fail resolving sandbox-policy's config.
          '- id: sandbox-policy',
          '  config:',
          '    mode: danger-full-access',
          "    workspaceRoot: !!js (() => { throw new Error('home layer !!js was evaluated'); })()",
          // Also inserts a brand-new row naming a package that cannot
          // resolve. If this were composed, boot would fail resolving it.
          '- insert:',
          '    - id: home-undeclared',
          "      name: '@aiclient-test/this-package-does-not-exist'",
          '',
        ].join('\n')
      );
      try {
        // Reaching ready is itself the proof: a packaged host never reads
        // $DSH_HOME/cordis.patch.yml, so neither the new row nor the !!js
        // expression in it ever reaches the composition, let alone runs.
        await supervisor.ensureHost({ userInitiated: true });
        expect(supervisor.status().state).toBe('ready');
        const result = await streamTurn('pl5', 94);
        expect(result).toMatchObject({ settled: true, completed: true });
      } finally {
        rmSync(homePatch, { force: true });
      }
    }, 180_000);

    it('[PLG-6] the allowlisted pilot is off by default, and an override on loads it with its eight tools (P1-10d)', async () => {
      current = installs.pilot;
      await select(undefined);
      const off = await streamTurn('pl6', 95);
      expect(off).toMatchObject({ settled: true, completed: true });
      expect(supervisor.status().pluginSelection).toBe(dshPluginSelectionKey(undefined));
      expect(supervisor.pluginReport()).toEqual({
        enabledFrom: 'default',
        plugins: [{ name: PILOT, version: '1.0.4', defaultEnabled: false, state: 'disabled' }],
        // The shared DSH home's profile still listed PLG-4's fixture, which
        // this install's allowlist does not carry.
        dropped: [{ name: kit.FIXTURE_PLUGIN, reason: 'not on the allowlist' }],
      });
      expect(profileBundles()).toEqual(['@deepseek-ai/dsh-base', '@aiclient/dsh-app']);

      await select({ [PILOT]: true });
      const on = await streamTurn('pl7', 96);
      expect(on).toMatchObject({ settled: true, completed: true });
      expect(supervisor.pluginReport()).toEqual({
        enabledFrom: 'main',
        plugins: [{ name: PILOT, version: '1.0.4', defaultEnabled: false, state: 'loaded' }],
        dropped: [],
      });
      expect(profileBundles()).toEqual(['@deepseek-ai/dsh-base', '@aiclient/dsh-app', PILOT]);
      // word_*, excel_* and ppt_*: three reads and five writes (reviews/dsh-office-tools-1.0.4.md).
      expect(on.tools[0]).toBe(Number(off.tools[0]) + 8);
    }, 240_000);
  });
});
