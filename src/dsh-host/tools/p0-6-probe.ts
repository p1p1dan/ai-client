/**
 * P0-6 driver: shared-host follow-up checks (dsh-rebase decision 002, rule 3).
 *
 * One DSH host serves every session through the product `aiclient-bridge`
 * row: one channel per session over one IPC link, each with its own
 * BridgeRpcServer + DshSessionRuntime (P1-3a, src/shared/types/
 * dshHostProtocol.ts). This driver plays Main: it spawns the host, opens a
 * channel per slot, sends turns, kills the host, restarts it and resumes the
 * sessions.
 *
 *   (run from src/dsh-host; every DSH_HOME gets the test-only bundle
 *   tools/probe-bundle for its compaction switch and the measurement row,
 *   dsh-rebase decision 015)
 *   node tools/p0-6-probe.ts crash        [--runs 3] [--out f.json]
 *   node tools/p0-6-probe.ts latency      [--runs 3] [--levels 1,2,4,8] [--out f.json]
 *   node tools/p0-6-probe.ts history-gen  [--turns 500] [--checkpoints 25,125,500] [--dir d]
 *   node tools/p0-6-probe.ts history      [--runs 3] [--dir d] [--out f.json]
 *   node tools/p0-6-probe.ts history-multi-gen [--sessions 4] [--turns 500] [--dir d]
 *   node tools/p0-6-probe.ts history-multi [--runs 3] [--dir d] [--out f.json]
 *   node tools/p0-6-probe.ts worker-history-gen   (after history-gen; same --dir)
 *   node tools/p0-6-probe.ts worker-history [--runs 3] [--dir d] [--out f.json]
 *
 * crash    Kill 1: three sessions each finished one turn with a bash call, host
 *          idle. Kill 2 (same run, on the restarted host): the three recovered
 *          sessions idle again, a fourth streaming a paced answer, a fifth
 *          inside a `sleep 30` bash call. After each SIGKILL: exit, orphaned
 *          tool processes, session.lock state (flock -n), restart to ready,
 *          stored log before / after resume, per-session resume time, what
 *          the bridge emitted, and one more turn per session (P0-RECALL checks
 *          the history the model sees). Run 1 adds a wedged-host check: a
 *          SIGSTOPped host still owns its sessions.
 * latency  1 / 2 / 4 / 8 sessions run one P0-LOAD turn at once (paced deltas
 *          every 30 ms, stamped with their send time, around bash / read
 *          calls). Host-side monitorEventLoopDelay, stamp latency at the
 *          bridge's stream listener (host) and at RuntimeEvent receipt
 *          (parent = Main), turn wall time, host CPU and RSS.
 * history-gen  One session grows through real P0-HIST turns (read or bash,
 *          then ~1 KB of prose): four messages per turn. DSH_HOME is copied at
 *          each checkpoint (25 / 125 / 500 turns = 100 / 500 / 2000 messages).
 * history  For each checkpoint: fresh host on a fresh copy, baseline memory,
 *          resume through the bridge, memory again (after a forced GC), then
 *          one P0-RECALL turn that checks the first and last turn are both in
 *          the request the model receives, and the peak RSS of that turn.
 * history-multi-gen / history-multi  Is the per-session cost additive? Four
 *          distinct sessions grow to 2000 messages each in one host; then each
 *          run resumes them one by one in a fresh host (memory after each),
 *          and finally all four send one P0-RECALL request at once (event-loop
 *          delay and peak RSS while four 2.4 MB requests are built together).
 * worker-history-gen / worker-history  The same comparison for our native
 *          worker (out-agent-host/worker.js, one process per session): the
 *          same P0-HIST script grows a pi session in the same workspace, and
 *          each checkpoint is resumed in a fresh worker (bootstrap with
 *          sessionFile, which also projects initialHistory for Main).
 *
 * Safety: every model request goes to the local fake gateway (plan dsh-p0-2);
 * the probe hooks drop any non-loopback connect. A host is only ever signalled
 * through its own ChildProcess; orphaned tool processes go through `killPid`,
 * which refuses anything but a positive pid other than our own (never -1,
 * never a group). At most two hosts are alive at a time.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { BYPASS_PERMISSIONS, fakeGatewayPlan, serveModelPlan } from './lib/hostClient.ts';
import {
  baseEnv,
  captureStderr,
  descendants,
  exitOf,
  launch,
  median,
  procCmdline,
  procTable,
  readHookLog,
  round,
  type Sandbox,
  sampleMem,
  sandbox,
  sleep,
  stopWithin,
  summarizeHooks,
  waitMessage,
  waitQuiet,
} from './lib/kit.ts';
import { installProbeBundle } from './lib/probe-bundle.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const hostEntry = join(hostDir, 'host.ts');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const bundledNode = join(repoRoot, 'out-node-runtime', 'node');
const workerEntry = join(repoRoot, 'out-agent-host', 'worker.js');

const argv = process.argv.slice(2);
const mode = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'crash';
const option = (name: string, fallback: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const nodeBin = option('node', existsSync(bundledNode) ? bundledNode : process.execPath);
const runs = Number(option('runs', '3'));
const outFile = option('out', '');
const keep = argv.includes('--keep');
const histDir = option('dir', '/var/tmp/aiclient-dsh-p0-6-hist');
// --systemd-scope hands the host the two variables `systemd-run --user` needs,
// so DSH's subprocess-local takes its transient-scope path instead of the
// weaker fallback (the allowlisted probe env, like Main's, leaves them out).
const systemdScope = argv.includes('--systemd-scope');
const hostExtraEnv: Record<string, string> = systemdScope
  ? Object.fromEntries(
      ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key] as string])
    )
  : {};
const scratchRoot = join('/var/tmp', `aiclient-dsh-p0-6-${mode}-${Date.now()}`);
const log = (message: string) => process.stderr.write(`[p0-6] ${message}\n`);
const nowUs = () => process.hrtime.bigint() / 1000n;
const STAMP = /‹t(\d+)›/g;

type Message = Record<string, unknown>;

// ---- safety: kill one exact pid ----------------------------------------------

function killPid(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 1 || pid === process.pid) {
    throw new Error(`refusing to signal pid ${String(pid)}`);
  }
  process.kill(pid as number, signal);
}

// ---- machine state -----------------------------------------------------------

function machine() {
  const info = readFileSync('/proc/meminfo', 'utf8');
  const kb = (field: string) => Number(info.match(new RegExp(`^${field}:\\s+(\\d+)`, 'm'))?.[1]);
  return {
    at: new Date().toISOString(),
    memAvailableMb: round(kb('MemAvailable') / 1024, 0),
    memFreeMb: round(kb('MemFree') / 1024, 0),
    swapUsedMb: round((kb('SwapTotal') - kb('SwapFree')) / 1024, 0),
    load1: os.loadavg()[0],
  };
}

function stats(values: number[]) {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    p50: round(pick(0.5), 2),
    p90: round(pick(0.9), 2),
    p99: round(pick(0.99), 2),
    max: round(sorted[sorted.length - 1], 2),
  };
}

// ---- fake gateway ------------------------------------------------------------

interface Gateway {
  port: number;
  child: ChildProcess;
  logFile: string;
}

async function startGateway(root: string): Promise<Gateway> {
  const logFile = join(root, 'gateway.jsonl');
  const child = spawn(
    nodeBin,
    [
      gatewayEntry,
      '--port',
      '0',
      '--plan',
      'dsh-p0-2',
      '--reset',
      '--state',
      join(root, 'gateway.state.json'),
      '--log',
      logFile,
      '--model-id',
      'fake-1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const port = await new Promise<number>((done, fail) => {
    let text = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      text += chunk;
      const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) done(Number(match[1]));
    });
    child.once('exit', (code) => fail(new Error(`fake gateway exited early (${code})`)));
    setTimeout(() => fail(new Error('fake gateway did not start')), 15_000);
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return { port, child, logFile };
}

function readJsonl(file: string): Message[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Message);
}

// ---- the shared host ---------------------------------------------------------

/**
 * What `turn` / `bootstrap` need: the shared host (one channel per slot) or one
 * native worker.
 */
interface RpcTarget {
  request(slot: string, type: string, payload: Message, timeoutMs?: number): Promise<Message>;
  until(
    slot: string,
    predicate: (events: Message[]) => boolean,
    timeoutMs: number
  ): Promise<boolean>;
  events(slot: string): Message[];
  eventCount(slot: string): number;
}

interface SlotState {
  events: Array<{ atUs: bigint; event: Message }>;
  pending: Map<string, { done: (m: Message) => void; fail: (e: Error) => void }>;
  waiters: Set<() => void>;
}

class SharedHost implements RpcTarget {
  readonly label: string;
  readonly child: ChildProcess;
  readonly pid: number;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  readonly stderr: () => string;
  readonly spawnedAt: number;
  readyMs = 0;
  ready: Message = {};
  exitedAtMs: number | null = null;
  private seq = 0;
  private channelSeq = 0;
  private readonly slots = new Map<string, SlotState>();
  /** The slot's open channel; a new one after each worker.dispose (ids are never reused). */
  private readonly channelOfSlot = new Map<string, string>();
  private readonly slotOfChannel = new Map<string, string>();
  private readonly p06Pending = new Map<string, (m: Message) => void>();
  /** Parent-side stamp latency (ms) of message.delta events, while armed. */
  parentLatency: number[] | null = null;

  constructor(label: string, box: Sandbox, gatewayPort: number, extraEnv: Record<string, string>) {
    this.label = label;
    const hostCwd = join(box.root, 'host-cwd');
    mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
    const env = {
      ...baseEnv(box),
      DSH_HOME: box.dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      // The probe bundle's auto-approving row would answer the bridge sessions' approvals.
      AICLIENT_DSH_PROBE_ROW: '0',
      ...hostExtraEnv,
      ...extraEnv,
    };
    installProbeBundle(box.dshHome);
    this.spawnedAt = performance.now();
    this.child = launch(
      [nodeBin, '--expose-internals', '--expose-gc', '--import', hooksEntry, hostEntry],
      env,
      hostCwd
    );
    // P1-5: Main's model source, played — one route to the gateway, a fake key per request.
    serveModelPlan(
      this.child,
      fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${gatewayPort}` }),
      'p0-6-fake-key'
    );
    this.pid = this.child.pid as number;
    this.stderr = captureStderr(this.child);
    this.exited = exitOf(this.child).then((exit) => {
      this.exitedAtMs = performance.now();
      const error = new Error(`${label} exited (${JSON.stringify(exit)})`);
      for (const slot of this.slots.values()) {
        for (const pending of slot.pending.values()) pending.fail(error);
        slot.pending.clear();
        // Waiters re-check and give up once the host is gone.
        for (const wake of [...slot.waiters]) wake();
      }
      return exit;
    });
    this.child.on('message', (raw: unknown) => this.onMessage(raw as Message));
  }

  async waitReady(): Promise<void> {
    this.ready = await waitMessage(
      this.child,
      (m) => m.type === 'ready',
      180_000,
      `${this.label} ready`
    );
    this.readyMs = round(performance.now() - this.spawnedAt, 0);
    if (this.ready.pid !== this.pid)
      throw new Error(`ready pid ${String(this.ready.pid)} != ${this.pid}`);
  }

  private slotState(slot: string): SlotState {
    let state = this.slots.get(slot);
    if (!state) {
      state = { events: [], pending: new Map(), waiters: new Set() };
      this.slots.set(slot, state);
    }
    return state;
  }

  /** The slot's channel; a bootstrap without an open one mints the next id. */
  private channelFor(slot: string, type: string): string {
    const open = this.channelOfSlot.get(slot);
    if (open !== undefined) return open;
    const ch = `c1-${++this.channelSeq}`;
    this.slotOfChannel.set(ch, slot);
    if (type === 'worker.bootstrap') this.channelOfSlot.set(slot, ch);
    return ch;
  }

  /** Signals this host's own ChildProcess, never a pid. */
  signal(signal: NodeJS.Signals): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
  }

  private onMessage(message: Message): void {
    if (typeof message?.p06Reply === 'string') {
      this.p06Pending.get(String(message.requestId))?.(message);
      this.p06Pending.delete(String(message.requestId));
      return;
    }
    if (message?.host === 'closed' && typeof message.ch === 'string') {
      const slot = this.slotOfChannel.get(message.ch);
      if (slot !== undefined && this.channelOfSlot.get(slot) === message.ch) {
        this.channelOfSlot.delete(slot);
      }
      return;
    }
    if (typeof message?.ch !== 'string' || typeof message.rpc !== 'object') return;
    const slot = this.slotOfChannel.get(message.ch);
    if (slot === undefined) return;
    const state = this.slotState(slot);
    const rpc = message.rpc as Message;
    if (rpc.kind === 'response') {
      const pending = state.pending.get(String(rpc.requestId));
      if (!pending) return;
      state.pending.delete(String(rpc.requestId));
      if (rpc.ok) pending.done((rpc.result ?? {}) as Message);
      else pending.fail(new Error(`${String(rpc.type ?? 'rpc')}: ${JSON.stringify(rpc.error)}`));
      return;
    }
    if (rpc.kind === 'event' && rpc.type === 'runtime.event') {
      const atUs = nowUs();
      const event = rpc.payload as Message;
      state.events.push({ atUs, event });
      if (this.parentLatency && event.type === 'message.delta') {
        const text = String((event.payload as Message | undefined)?.text ?? '');
        for (const match of text.matchAll(STAMP)) {
          this.parentLatency.push(Number(atUs - BigInt(match[1])) / 1000);
        }
      }
      for (const wake of [...state.waiters]) wake();
    }
  }

  request(slot: string, type: string, payload: Message, timeoutMs = 120_000): Promise<Message> {
    const state = this.slotState(slot);
    const requestId = `${this.label}-${++this.seq}`;
    if (!this.child.connected) return Promise.reject(new Error(`${this.label} is not connected`));
    const ch = this.channelFor(slot, type);
    // Its answer still routes through `slotOfChannel`; the next bootstrap gets a new channel.
    if (type === 'worker.dispose') this.channelOfSlot.delete(slot);
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        state.pending.delete(requestId);
        fail(new Error(`${this.label} ${slot} ${type} timed out`));
      }, timeoutMs);
      state.pending.set(requestId, {
        done: (m) => {
          clearTimeout(timer);
          done(m);
        },
        fail: (e) => {
          clearTimeout(timer);
          fail(e);
        },
      });
      this.child.send({
        ch,
        rpc: { protocolVersion: 1, kind: 'request', generation: 1, requestId, type, payload },
      });
    });
  }

  p06(op: string, payload: Message = {}, timeoutMs = 120_000): Promise<Message> {
    const requestId = `${this.label}-p06-${++this.seq}`;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.p06Pending.delete(requestId);
        fail(new Error(`${this.label} p06 ${op} timed out`));
      }, timeoutMs);
      this.p06Pending.set(requestId, (m) => {
        clearTimeout(timer);
        if (m.error) fail(new Error(`p06 ${op}: ${String(m.error)}`));
        else done(m);
      });
      this.child.send({ p06: op, requestId, ...payload });
    });
  }

  events(slot: string): Message[] {
    return this.slotState(slot).events.map((entry) => entry.event);
  }

  eventCount(slot: string): number {
    return this.slotState(slot).events.length;
  }

  until(
    slot: string,
    predicate: (events: Message[]) => boolean,
    timeoutMs: number
  ): Promise<boolean> {
    const state = this.slotState(slot);
    const check = () => predicate(state.events.map((entry) => entry.event));
    if (check()) return Promise.resolve(true);
    if (this.exitedAtMs !== null) return Promise.resolve(false);
    return new Promise((done) => {
      const wake = () => {
        const held = check();
        if (!held && this.exitedAtMs === null) return;
        clearTimeout(timer);
        state.waiters.delete(wake);
        done(held);
      };
      const timer = setTimeout(() => {
        state.waiters.delete(wake);
        done(false);
      }, timeoutMs);
      state.waiters.add(wake);
    });
  }

  async shutdown(): Promise<Message> {
    const started = performance.now();
    if (this.child.connected) this.child.send({ type: 'shutdown' });
    const graceful = await stopWithin(this.exited, 15_000);
    if (!graceful) this.signal('SIGKILL');
    return { graceful, stopMs: round(performance.now() - started, 0), exit: await this.exited };
  }
}

const payloadOf = (event: Message) => (event.payload ?? {}) as Message;

async function bootstrap(
  host: RpcTarget,
  slot: string,
  cwd: string,
  sessionFile?: string,
  extra: Message = {}
) {
  const started = performance.now();
  const result = await host.request(slot, 'worker.bootstrap', {
    logicalSessionId: slot,
    cwd,
    ...(sessionFile ? { sessionFile } : {}),
    // P1-6b: the probe measures the host, not the approval cards.
    permissions: BYPASS_PERMISSIONS,
    ...extra,
  });
  return { ms: round(performance.now() - started, 1), result };
}

/** One worker.send, resolved when the bridge reports idle for its requestId. */
async function turn(
  host: RpcTarget,
  slot: string,
  label: string,
  text: string,
  timeoutMs = 120_000
) {
  const requestId = `turn-${label}`;
  const from = host.eventCount(slot);
  const started = performance.now();
  await host.request(slot, 'worker.send', {
    logicalSessionId: slot,
    requestId,
    attemptId: `attempt-${label}`,
    text,
  });
  const idle = await host.until(
    slot,
    (events) =>
      events
        .slice(from)
        .some(
          (e) =>
            e.type === 'session.status' &&
            payloadOf(e).status === 'idle' &&
            e.requestId === requestId
        ),
    timeoutMs
  );
  const events = host.events(slot).slice(from);
  const end = events.find(
    (e) =>
      e.requestId === requestId &&
      ['session.completed', 'session.stopped', 'session.failed'].includes(String(e.type))
  );
  return {
    requestId,
    idle,
    ms: round(performance.now() - started, 0),
    end: end ? String(end.type) : null,
    endPayload: end && end.type === 'session.failed' ? payloadOf(end) : undefined,
    deltas: events.filter((e) => e.type === 'message.delta').length,
    toolsCompleted: events
      .filter((e) => e.type === 'tool.completed')
      .map((e) => ({ ok: payloadOf(e).ok })),
  };
}

// ---- sessions on disk ----------------------------------------------------------

function sessionDir(dshHome: string, dshSessionId: string): string | null {
  const root = join(dshHome, 'sessions');
  if (!existsSync(root)) return null;
  for (const project of readdirSync(root)) {
    const candidate = join(root, project, dshSessionId);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sessionFiles(dshHome: string, dshSessionId: string) {
  const dir = sessionDir(dshHome, dshSessionId);
  if (!dir) return null;
  return Object.fromEntries(readdirSync(dir).map((name) => [name, statSync(join(dir, name)).size]));
}

/** 'held' when another descriptor holds the session's flock, 'free' when not. */
function lockState(dshHome: string, dshSessionId: string): string {
  const dir = sessionDir(dshHome, dshSessionId);
  const lock = dir ? join(dir, 'session.lock') : null;
  if (!lock || !existsSync(lock)) return 'no-lock-file';
  const result = spawnSync('flock', ['-n', '-E', '99', lock, 'true']);
  if (result.status === 0) return 'free';
  if (result.status === 99) return 'held';
  return `flock-status-${String(result.status)}`;
}

interface ProcRecord {
  pid: number;
  start: number;
  cmd: string;
}

function treeOf(pid: number): ProcRecord[] {
  const table = procTable();
  return descendants(pid, table).map((child) => ({
    pid: child,
    start: table.get(child)?.start ?? -1,
    cmd: procCmdline(child).slice(0, 200),
  }));
}

function stillAlive(records: ProcRecord[]): ProcRecord[] {
  const table = procTable();
  return records.filter((record) => table.get(record.pid)?.start === record.start);
}

/** Kill tool processes a dead host left behind, each by its exact pid. */
function reapOrphans(records: ProcRecord[]) {
  for (const record of stillAlive(records)) {
    try {
      killPid(record.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

// ---- workspace -------------------------------------------------------------------

function seedWorkspace(dir: string, files = 12) {
  const paths: string[] = [];
  for (let i = 0; i < files; i += 1) {
    const lines: string[] = [`// module ${i}: generated for the P0-6 probe`];
    let n = 0;
    while (lines.join('\n').length < 2600 + (i % 5) * 300) {
      n += 1;
      lines.push(
        `export function step${i}_${n}(input: Record<string, number>): number {`,
        `  const total = Object.values(input).reduce((sum, value) => sum + value * ${n}, 0);`,
        `  return total > ${n * 100} ? total - ${n} : total + ${i};`,
        '}'
      );
    }
    const path = join(dir, `module-${String(i).padStart(2, '0')}.ts`);
    writeFileSync(path, `${lines.join('\n')}\n`);
    paths.push(path);
  }
  writeFileSync(
    join(dir, 'data.txt'),
    Array.from({ length: 400 }, (_, i) => `line ${i} of the data file`).join('\n')
  );
  writeFileSync(join(dir, 'notes.txt'), 'P0-6 workspace notes\n');
  return paths;
}

// ---- crash ---------------------------------------------------------------------------

interface CrashSession {
  slot: string;
  kind: 'idle' | 'mid-stream' | 'mid-tool';
  dshSessionId: string;
  sessionFile: string;
  token: string;
  recallMarkers: string[];
}

async function inspectAfterKill(
  host: SharedHost,
  box: Sandbox,
  sessions: CrashSession[],
  preKill: Record<string, Message>,
  gateway: Gateway,
  runLabel: string
) {
  // Stored log after the crash, before anything resumes it.
  const beforeResume: Record<string, Message> = {};
  for (const s of sessions) {
    const pre = preKill[s.slot] as Message | undefined;
    beforeResume[s.slot] = await host.p06('read-session', {
      sessionId: s.dshSessionId,
      prefix: Number(pre?.count ?? 0),
      find: [`STREAMED-${s.token}`, `sleep-tool ${s.token} started`],
    });
  }
  // Resume each session through the bridge, one after another.
  const resumed: Record<string, Message> = {};
  const resumeStarted = performance.now();
  for (const s of sessions) {
    const from = host.eventCount(s.slot);
    try {
      const boot = await bootstrap(host, s.slot, box.workspace, s.sessionFile);
      await sleep(300);
      resumed[s.slot] = {
        ms: boot.ms,
        piSessionId: boot.result.piSessionId,
        hasInitialHistory: boot.result.initialHistory !== undefined,
        leaf: boot.result.leaf,
        eventsEmittedOnResume: host
          .events(s.slot)
          .slice(from)
          .map(
            (e) =>
              `${String(e.type)}${e.type === 'session.status' ? `:${String(payloadOf(e).status)}` : ''}`
          ),
      };
    } catch (error) {
      resumed[s.slot] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const allResumedMs = round(performance.now() - resumeStarted, 0);
  const afterResume: Record<string, Message> = {};
  const history: Record<string, Message> = {};
  for (const s of sessions) {
    afterResume[s.slot] = await host.p06('read-session', {
      sessionId: s.dshSessionId,
      find: [`STREAMED-${s.token}`],
    });
    const page = await host
      .request(s.slot, 'worker.history', { logicalSessionId: s.slot })
      .catch((error: Error) => ({ error: error.message }));
    history[s.slot] = {
      totalCount: ((page as Message).page as Message | undefined)?.totalCount ?? null,
      error: (page as Message).error,
    };
  }
  const locksWhileLive = Object.fromEntries(
    sessions.map((s) => [s.slot, lockState(box.dshHome, s.dshSessionId)])
  );
  // One more turn per session: does the model get the earlier history?
  const gatewayBefore = readJsonl(gateway.logFile).length;
  const continued: Record<string, Message> = {};
  await Promise.all(
    sessions.map(async (s) => {
      const text = `P0-RECALL ${JSON.stringify({ markers: s.recallMarkers })} 继续：刚才的内容还在吗？`;
      continued[s.slot] = await turn(host, s.slot, `${runLabel}-${s.slot}-recall`, text).catch(
        (error: Error) => ({ error: error.message })
      );
    })
  );
  const recallLines = readJsonl(gateway.logFile)
    .slice(gatewayBefore)
    .filter((line) => String(line.decision ?? '').startsWith('RECALL'));
  for (const s of sessions) {
    const line = recallLines.find(
      (l) =>
        JSON.stringify(l.probe ?? '').includes(s.recallMarkers[0]) ||
        String(l.decision).includes(s.recallMarkers[0])
    );
    (continued[s.slot] as Message).gateway = line
      ? { decision: line.decision, probe: line.probe }
      : recallLines.map((l) => l.decision);
  }
  const afterContinue: Record<string, Message> = {};
  for (const s of sessions) {
    const summary = await host.p06('read-session', { sessionId: s.dshSessionId });
    afterContinue[s.slot] = {
      count: summary.count,
      turnEnds: summary.turnEnds,
      messages: summary.messages,
    };
  }
  return {
    beforeResume,
    resumed,
    allResumedMs,
    afterResume,
    history,
    locksWhileLive,
    continued,
    afterContinue,
  };
}

async function crashRun(r: number, gateway: Gateway) {
  const box = sandbox(scratchRoot, `crash-${r}`);
  seedWorkspace(box.workspace, 4);
  const run: Message = { run: r, machine: machine() };
  const tokens = (slot: string) => `R${r}${slot.toUpperCase()}`;

  // ---- host A: three sessions, one finished turn each --------------------------
  let host = new SharedHost(`r${r}-A`, box, gateway.port, {});
  await host.waitReady();
  run.hostAReadyMs = host.readyMs;
  const sessions: CrashSession[] = [];
  for (const slot of ['s1', 's2', 's3']) {
    const boot = await bootstrap(host, slot, box.workspace);
    sessions.push({
      slot,
      kind: 'idle',
      dshSessionId: String(boot.result.piSessionId),
      sessionFile: String(boot.result.sessionFile),
      token: tokens(slot),
      recallMarkers: [`crash-probe ${tokens(slot)}`, `P0-CRASH ${tokens(slot)} finished`],
    });
  }
  run.firstTurns = Object.fromEntries(
    await Promise.all(
      sessions.map(async (s) => [
        s.slot,
        await turn(
          host,
          s.slot,
          `r${r}-${s.slot}-crash`,
          `P0-CRASH {"token":"${s.token}"} 列一下目录。`
        ),
      ])
    )
  );
  await sleep(1000);

  const kill = async (label: string, active: CrashSession[]) => {
    const preKill: Record<string, Message> = {};
    for (const s of active) {
      preKill[s.slot] = await host.p06('read-session', {
        sessionId: s.dshSessionId,
        find: [`STREAMED-${s.token}`, `sleep-tool ${s.token} started`],
      });
    }
    const locksBefore = Object.fromEntries(
      active.map((s) => [s.slot, lockState(box.dshHome, s.dshSessionId)])
    );
    const filesBefore = Object.fromEntries(
      active.map((s) => [s.slot, sessionFiles(box.dshHome, s.dshSessionId)])
    );
    const tree = treeOf(host.pid);
    const killedAt = performance.now();
    host.signal('SIGKILL');
    const exit = await host.exited;
    const exitObservedMs = round((host.exitedAtMs ?? performance.now()) - killedAt, 1);
    await sleep(1000);
    const orphans = stillAlive(tree);
    reapOrphans(tree);
    const locksAfter = Object.fromEntries(
      active.map((s) => [s.slot, lockState(box.dshHome, s.dshSessionId)])
    );
    const filesAfter = Object.fromEntries(
      active.map((s) => [s.slot, sessionFiles(box.dshHome, s.dshSessionId)])
    );
    // Main-side restart.
    const next = new SharedHost(`r${r}-${label}-restart`, box, gateway.port, {});
    await next.waitReady();
    const restartToReadyMs = next.readyMs;
    host = next;
    const inspected = await inspectAfterKill(host, box, active, preKill, gateway, `r${r}-${label}`);
    return {
      exit,
      exitObservedMs,
      treeBeforeKill: tree.map((p) => p.cmd),
      orphansAfter1s: orphans.map((p) => p.cmd),
      locksBefore,
      locksAfter,
      filesBefore,
      filesAfter,
      preKill,
      restartToReadyMs,
      killToInspectedMs: round(performance.now() - killedAt, 0),
      ...inspected,
    };
  };

  run.kill1 = await kill('k1', sessions);
  log(`run ${r}: kill 1 done`);

  // ---- kill 2 on the restarted host: idle + mid-stream + mid-tool ---------------
  const s4: CrashSession = {
    slot: 's4',
    kind: 'mid-stream',
    dshSessionId: '',
    sessionFile: '',
    token: tokens('s4'),
    recallMarkers: [tokens('s4'), `STREAMED-${tokens('s4')}`],
  };
  const s5: CrashSession = {
    slot: 's5',
    kind: 'mid-tool',
    dshSessionId: '',
    sessionFile: '',
    token: tokens('s5'),
    recallMarkers: [tokens('s5'), `sleep-tool ${tokens('s5')} started`],
  };
  for (const s of [s4, s5]) {
    const boot = await bootstrap(host, s.slot, box.workspace);
    s.dshSessionId = String(boot.result.piSessionId);
    s.sessionFile = String(boot.result.sessionFile);
  }
  const s4From = host.eventCount('s4');
  const s5From = host.eventCount('s5');
  const pending4 = turn(
    host,
    's4',
    `r${r}-s4-paced`,
    `P0-PACED {"token":"${s4.token}","chunks":60,"chunkMs":150} 写一段长一点的说明。`
  ).catch((error: Error) => ({ error: error.message }));
  const pending5 = turn(
    host,
    's5',
    `r${r}-s5-sleep`,
    `P0-SLEEPTOOL {"token":"${s5.token}","seconds":30} 跑一个慢命令。`
  ).catch((error: Error) => ({ error: error.message }));
  const toolRunning = await host.until(
    's5',
    (events) => events.slice(s5From).some((e) => e.type === 'tool.updated'),
    30_000
  );
  const streaming = await host.until(
    's4',
    (events) => events.slice(s4From).filter((e) => e.type === 'message.delta').length >= 12,
    30_000
  );
  await sleep(1200);
  const guiBeforeKill = {
    s4Deltas: host
      .events('s4')
      .slice(s4From)
      .filter((e) => e.type === 'message.delta').length,
    s4Text: host
      .events('s4')
      .slice(s4From)
      .filter((e) => e.type === 'message.delta')
      .map((e) => String(payloadOf(e).text))
      .join('')
      .slice(0, 120),
    s5Tool: host
      .events('s5')
      .slice(s5From)
      .map((e) => String(e.type))
      .filter((type) => type.startsWith('tool.')),
    toolRunning,
    streaming,
  };
  const kill2 = await kill('k2', [...sessions, s4, s5]);
  run.kill2 = { guiBeforeKill, ...kill2 };
  run.interruptedTurnsAtParent = { s4: await pending4, s5: await pending5 };
  log(`run ${r}: kill 2 done`);

  // ---- kill 3: the Main-side critical path alone ---------------------------------
  // No checks between the steps: SIGKILL, spawn on exit, resume all five in
  // parallel. This is the "crash to every session usable again" figure.
  {
    const all = [...sessions, s4, s5];
    const killedAt = performance.now();
    host.signal('SIGKILL');
    await host.exited;
    const exitObservedMs = round((host.exitedAtMs ?? performance.now()) - killedAt, 1);
    const next = new SharedHost(`r${r}-k3-restart`, box, gateway.port, {});
    await next.waitReady();
    const readyAt = performance.now();
    const resumes = await Promise.all(
      all.map((s) =>
        bootstrap(next, s.slot, box.workspace, s.sessionFile)
          .then((b) => b.ms)
          .catch((error: Error) => ({ error: error.message }))
      )
    );
    run.kill3 = {
      exitObservedMs,
      restartToReadyMs: next.readyMs,
      parallelResumeMs: resumes,
      allResumedAfterReadyMs: round(performance.now() - readyAt, 1),
      killToAllResumedMs: round(performance.now() - killedAt, 0),
    };
    host = next;
    log(`run ${r}: kill 3 done`);
  }

  // ---- run 1 only: a wedged (SIGSTOPped) host keeps its sessions ------------------
  if (r === 1) {
    const stopped = host;
    stopped.signal('SIGSTOP');
    const second = new SharedHost(`r${r}-wedge-second`, box, gateway.port, {});
    await second.waitReady();
    const target = sessions[0];
    const lockWhileStopped = lockState(box.dshHome, target.dshSessionId);
    const attempt = await bootstrap(second, 'wedge-probe', box.workspace, target.sessionFile)
      .then((b) => ({ ok: true, ms: b.ms }))
      .catch((error: Error) => ({ ok: false, error: error.message.slice(0, 400) }));
    const stoppedTree = treeOf(stopped.pid);
    stopped.signal('SIGKILL');
    await stopped.exited;
    await sleep(500);
    reapOrphans(stoppedTree);
    const retry = await bootstrap(second, 'wedge-probe-2', box.workspace, target.sessionFile)
      .then((b) => ({ ok: true, ms: b.ms }))
      .catch((error: Error) => ({ ok: false, error: error.message.slice(0, 400) }));
    run.wedge = { lockWhileStopped, whileStopped: attempt, afterKill: retry };
    host = second;
  }

  run.shutdown = await host.shutdown();
  await sleep(500);
  run.leftoverProcesses = readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .map((pid) => procCmdline(Number(pid)))
    .filter((cmd) => cmd.includes(box.root));
  run.hooks = summarizeHooks(readHookLog(box.hookLog));
  run.hostStderrTail = host.stderr().slice(-3000);
  return run;
}

async function crashMode() {
  const gatewayRoot = join(scratchRoot, 'gateway');
  mkdirSync(gatewayRoot, { recursive: true, mode: 0o700 });
  const gateway = await startGateway(gatewayRoot);
  const report: Message = {
    mode: 'crash',
    node: nodeBin,
    systemdScope,
    startedAt: new Date().toISOString(),
  };
  const results: Message[] = [];
  try {
    for (let r = 1; r <= runs; r += 1) {
      await waitQuiet();
      results.push(await crashRun(r, gateway));
    }
  } finally {
    gateway.child.kill('SIGTERM');
  }
  report.runs = results;
  const pick = (key: string, path: (k: Message) => number) =>
    results.map((run) => path(run[key] as Message));
  report.summary = {
    restartToReadyMs: {
      kill1: pick('kill1', (k) => Number(k.restartToReadyMs)),
      kill2: pick('kill2', (k) => Number(k.restartToReadyMs)),
    },
    exitObservedMs: {
      kill1: pick('kill1', (k) => Number(k.exitObservedMs)),
      kill2: pick('kill2', (k) => Number(k.exitObservedMs)),
    },
    resumeMsPerSession: results.flatMap((run) =>
      ['kill1', 'kill2'].flatMap((key) =>
        Object.entries(((run[key] as Message).resumed ?? {}) as Record<string, Message>).map(
          ([slot, value]) => ({ run: run.run, kill: key, slot, ms: value.ms, error: value.error })
        )
      )
    ),
    fastPath: results.map((run) => run.kill3),
  };
  report.finishedAt = new Date().toISOString();
  return report;
}

// ---- latency ---------------------------------------------------------------------

async function latencyMode() {
  const levels = option('levels', '1,2,4,8').split(',').map(Number);
  // Session i starts i * stagger ms after the first, so one session's tool
  // phase overlaps the others' streaming (0 = all in lockstep).
  const stagger = Number(option('stagger', '0'));
  const gatewayRoot = join(scratchRoot, 'gateway');
  mkdirSync(gatewayRoot, { recursive: true, mode: 0o700 });
  const gateway = await startGateway(gatewayRoot);
  const report: Message = {
    mode: 'latency',
    node: nodeBin,
    levels,
    staggerMs: stagger,
    workload:
      'P0-LOAD: 4 model steps (40 + 40 + 40 + 80 stamped text deltas, 30 ms apart) with bash (ls + cat of the source files, ~25 KB out), read, bash calls between them',
    startedAt: new Date().toISOString(),
  };
  const results: Message[] = [];
  try {
    for (let r = 1; r <= runs; r += 1) {
      await waitQuiet();
      const box = sandbox(scratchRoot, `latency-${r}`);
      const files = seedWorkspace(box.workspace, 8);
      const run: Message = { run: r, machine: machine() };
      const host = new SharedHost(`lat-${r}`, box, gateway.port, {});
      await host.waitReady();
      run.readyMs = host.readyMs;
      await sleep(3000);
      await host.p06('eld-start', { resolutionMs: 10 });
      await sleep(5000);
      const idle = await host.p06('eld-stop');
      run.idle = { eld: idle.eld, cpuMs: idle.cpuMs, wallMs: idle.wallMs };
      const rounds: Message[] = [];
      // Round 0 warms the host up (first bash / read in a fresh host pays
      // one-time module loads and sandbox probes) and is not reported.
      for (const n of [0, ...levels]) {
        const warmup = n === 0;
        const width = warmup ? 1 : n;
        const slots = Array.from({ length: width }, (_, i) => `r${r}-n${n}-s${i + 1}`);
        for (const slot of slots) await bootstrap(host, slot, box.workspace);
        await sleep(1500);
        const cpuTicks0 = procCpuTicks(host.pid);
        const eldStart = await host.p06('eld-start', { resolutionMs: 10 });
        host.parentLatency = [];
        const rss: number[] = [];
        const sampler = setInterval(() => {
          const kb = Number(
            readFileSync(`/proc/${host.pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1]
          );
          if (Number.isFinite(kb)) rss.push(kb);
        }, 250);
        const started = performance.now();
        const turns = await Promise.all(
          slots.map(async (slot, i) => {
            if (stagger > 0) await sleep(i * stagger);
            return turn(
              host,
              slot,
              `${slot}-load`,
              `P0-LOAD ${JSON.stringify({ session: i + 1, file: files[i % files.length], chunks: 40, chunkMs: 30 })} 按步骤处理。`,
              180_000
            );
          })
        );
        const wallMs = round(performance.now() - started, 0);
        clearInterval(sampler);
        const stop = await host.p06('eld-stop');
        const parent = host.parentLatency;
        host.parentLatency = null;
        const cpuTicks1 = procCpuTicks(host.pid);
        const hostLatency = stop.hostLatencyMs as number[];
        const window = [Number(eldStart.hostNowMs), Number(stop.hostNowMs)];
        const syncSpawns = readHookLog(box.hookLog).filter(
          (rec) =>
            rec.kind === 'spawn-sync-ms' &&
            Number(rec.pid) === host.pid &&
            Number(rec.tMs) >= window[0] &&
            Number(rec.tMs) <= window[1]
        );
        const syncMs = syncSpawns.map((rec) => Number(rec.ms));
        if (warmup) {
          for (const slot of slots) {
            await host
              .request(slot, 'worker.dispose', { reason: 'app-shutdown' })
              .catch(() => undefined);
          }
          run.warmup = {
            wallMs,
            eld: stop.eld,
            syncSpawnMsMax: syncMs.length ? round(Math.max(...syncMs), 1) : 0,
          };
          await sleep(2000);
          continue;
        }
        rounds.push({
          n,
          syncSpawns: {
            count: syncMs.length,
            totalMs: round(
              syncMs.reduce((a, b) => a + b, 0),
              1
            ),
            maxMs: syncMs.length ? round(Math.max(...syncMs), 1) : 0,
            files: [...new Set(syncSpawns.map((rec) => String(rec.file)))],
          },
          wallMs,
          turnMs: turns.map((t) => t.ms),
          turnEnds: turns.map((t) => t.end),
          allCompleted: turns.every((t) => t.end === 'session.completed'),
          stampsExpected: n * 200,
          eld: stop.eld,
          hostLatencyMs: stats(hostLatency),
          parentLatencyMs: stats(parent ?? []),
          hostCpuMs: stop.cpuMs,
          gc: stop.gc,
          hostCpuPercent: round(((cpuTicks1 - cpuTicks0) * 10 * 100) / wallMs, 0),
          hostRssMaxMb: round(Math.max(...rss) / 1024, 1),
          machineAfter: machine(),
        });
        log(
          `run ${r} n=${n}: wall ${wallMs} ms, eld p99 ${String((stop.eld as Message)?.p99)} max ${String((stop.eld as Message)?.max)}, host lat p99 ${String(stats(hostLatency).p99)}, parent p99 ${String(stats(parent ?? []).p99)}`
        );
        for (const slot of slots) {
          await host
            .request(slot, 'worker.dispose', { reason: 'app-shutdown' })
            .catch(() => undefined);
        }
        await sleep(2000);
      }
      run.rounds = rounds;
      run.shutdown = await host.shutdown();
      run.hooks = { spawnCount: summarizeHooks(readHookLog(box.hookLog)).spawns.length };
      run.hostStderrTail = host.stderr().slice(-2000);
      results.push(run);
    }
  } finally {
    gateway.child.kill('SIGTERM');
  }
  report.runs = results;
  report.summary = Object.fromEntries(
    levels.map((n) => {
      const rows = results.map(
        (run) => (run.rounds as Message[]).find((row) => row.n === n) as Message
      );
      const med = (get: (row: Message) => number) => round(median(rows.map(get)), 2);
      const eld = (row: Message) => row.eld as Message;
      const host = (row: Message) => row.hostLatencyMs as Message;
      const parent = (row: Message) => row.parentLatencyMs as Message;
      return [
        `n${n}`,
        {
          eldP50: med((row) => Number(eld(row).p50)),
          eldP99: med((row) => Number(eld(row).p99)),
          eldMax: med((row) => Number(eld(row).max)),
          eldMaxOfRuns: Math.max(...rows.map((row) => Number(eld(row).max))),
          hostLatP50: med((row) => Number(host(row).p50)),
          hostLatP99: med((row) => Number(host(row).p99)),
          hostLatMax: med((row) => Number(host(row).max)),
          parentLatP50: med((row) => Number(parent(row).p50)),
          parentLatP99: med((row) => Number(parent(row).p99)),
          parentLatMax: med((row) => Number(parent(row).max)),
          turnMsMedian: med((row) => median(row.turnMs as number[])),
          wallMs: med((row) => Number(row.wallMs)),
          hostCpuPercent: med((row) => Number(row.hostCpuPercent)),
          hostRssMaxMb: med((row) => Number(row.hostRssMaxMb)),
          allCompleted: rows.every((row) => row.allCompleted === true),
          stampsSeenHost: rows.map((row) => host(row).n),
          stampsSeenParent: rows.map((row) => parent(row).n),
          syncSpawnMaxMs: med((row) => Number((row.syncSpawns as Message).maxMs)),
          syncSpawnTotalMs: med((row) => Number((row.syncSpawns as Message).totalMs)),
          gcMaxMs: med((row) => Number((row.gc as Message).maxMs)),
          gcTotalMs: med((row) => Number((row.gc as Message).totalMs)),
        },
      ];
    })
  );
  report.summary = {
    idleEld: results.map((run) => (run.idle as Message).eld),
    ...(report.summary as Message),
  };
  report.finishedAt = new Date().toISOString();
  return report;
}

function procCpuTicks(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // utime is field 14, stime field 15 (1-based); rest starts at field 3.
  return Number(rest[11]) + Number(rest[12]);
}

// ---- history ------------------------------------------------------------------------

const HIST_SLOT = 'p06-hist';

async function historyGenMode() {
  const turns = Number(option('turns', '500'));
  const checkpoints = option('checkpoints', '25,125,500').split(',').map(Number);
  if (existsSync(histDir)) rmSync(histDir, { recursive: true, force: true });
  mkdirSync(histDir, { recursive: true, mode: 0o700 });
  await waitQuiet();
  const box = sandbox(histDir, 'gen');
  const files = seedWorkspace(box.workspace, 40);
  const gateway = await startGateway(box.root);
  const report: Message = {
    mode: 'history-gen',
    turns,
    checkpoints,
    machine: machine(),
    startedAt: new Date().toISOString(),
  };
  const host = new SharedHost('hist-gen', box, gateway.port, { AICLIENT_DSH_COMPACTION_AUTO: '0' });
  const perTurn: Message[] = [];
  const snapshots: Message[] = [];
  try {
    await host.waitReady();
    const boot = await bootstrap(host, HIST_SLOT, box.workspace);
    const dshSessionId = String(boot.result.piSessionId);
    report.session = { dshSessionId, sessionFile: String(boot.result.sessionFile) };
    const started = performance.now();
    for (let i = 1; i <= turns; i += 1) {
      const params = { i, file: files[i % files.length], token: `H${i}-${(i * 7919) % 10007}` };
      await host.p06('eld-start', { resolutionMs: 10 });
      const t = await turn(
        host,
        HIST_SLOT,
        `hist-${i}`,
        `P0-HIST ${JSON.stringify(params)} 请阅读这个文件并总结要点，特别留意错误处理、超时参数和并发写入的部分，最后给出下一步建议。`
      );
      const eld = (await host.p06('eld-stop')).eld as Message;
      perTurn.push({ i, ms: t.ms, end: t.end, eldMax: eld?.max });
      if (i % 50 === 0) log(`turn ${i}: ${t.ms} ms, eld max ${String(eld?.max)} ms`);
      if (t.end !== 'session.completed') throw new Error(`turn ${i} ended ${String(t.end)}`);
      if (checkpoints.includes(i)) {
        await sleep(1500);
        const summary = await host.p06('read-session', { sessionId: dshSessionId });
        const target = join(histDir, `snap-${i}`);
        cpSync(box.dshHome, join(target, 'dsh-home'), { recursive: true });
        const rssKb = Number(
          readFileSync(`/proc/${host.pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1]
        );
        snapshots.push({
          turns: i,
          elapsedMs: round(performance.now() - started, 0),
          messages: summary.messages,
          events: summary.count,
          sizeBytes: summary.sizeBytes,
          readMs: summary.readMs,
          genHostRssMb: round(rssKb / 1024, 1),
          dir: target,
        });
        log(
          `checkpoint ${i}: ${JSON.stringify(summary.messages)} ${String(summary.sizeBytes)} bytes`
        );
      }
    }
    report.shutdown = await host.shutdown();
  } finally {
    host.signal('SIGKILL');
    gateway.child.kill('SIGTERM');
  }
  const gatewayLines = readJsonl(gateway.logFile);
  report.snapshots = snapshots;
  report.perTurnSample = perTurn.filter(
    (row) => Number(row.i) <= 3 || Number(row.i) % 50 === 0 || checkpoints.includes(Number(row.i))
  );
  const histRequests = gatewayLines.filter((line) =>
    String(line.decision ?? '').startsWith('HIST')
  );
  report.gateway = {
    requests: gatewayLines.length,
    // Two model requests per HIST turn; the second one of turn i carries the most history.
    bodyCharsAtCheckpoint: Object.fromEntries(
      checkpoints.map((i) => [i, histRequests[2 * i - 1]?.bodyChars ?? null])
    ),
    decisionsNoMarker: gatewayLines.filter((line) => line.decision === 'no-marker').length,
  };
  report.workspace = box.workspace;
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(histDir, 'gen.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function historyMode() {
  const gen = JSON.parse(readFileSync(join(histDir, 'gen.json'), 'utf8')) as Message;
  const snapshots = gen.snapshots as Message[];
  const workspace = String(gen.workspace);
  const gatewayRoot = join(scratchRoot, 'gateway');
  mkdirSync(gatewayRoot, { recursive: true, mode: 0o700 });
  const gateway = await startGateway(gatewayRoot);
  const report: Message = { mode: 'history', node: nodeBin, startedAt: new Date().toISOString() };
  const cases: Message[] = [];
  const memOf = async (host: SharedHost) => {
    const inHost = await host.p06('mem', { gc: true });
    const proc = await sampleMem(host.pid, 5);
    const usage = inHost.memoryUsage as Record<string, number>;
    return {
      rssMb: proc.rssMedianMb,
      pssMb: proc.pssMedianMb,
      heapUsedMb: round(usage.heapUsed / 1048576, 1),
      heapTotalMb: round(usage.heapTotal / 1048576, 1),
      externalMb: round(usage.external / 1048576, 1),
      arrayBuffersMb: round(usage.arrayBuffers / 1048576, 1),
    };
  };
  const sizes = [{ turns: 0 } as Message, ...snapshots];
  try {
    for (let r = 1; r <= runs; r += 1) {
      for (const snap of sizes) {
        await waitQuiet();
        const label = `hist-${String(snap.turns)}-r${r}`;
        const box = sandbox(scratchRoot, label);
        if (Number(snap.turns) > 0) {
          rmSync(box.dshHome, { recursive: true, force: true });
          cpSync(join(String(snap.dir), 'dsh-home'), box.dshHome, { recursive: true });
        }
        const row: Message = {
          run: r,
          turns: snap.turns,
          messages: snap.messages,
          machine: machine(),
        };
        const host = new SharedHost(label, box, gateway.port, {
          AICLIENT_DSH_COMPACTION_AUTO: '0',
        });
        try {
          await host.waitReady();
          await sleep(4000);
          row.baseline = await memOf(host);
          let stub: string | undefined;
          if (Number(snap.turns) > 0) {
            const dir = join(box.dshHome, 'aiclient-sessions');
            stub = join(dir, readdirSync(dir).find((name) => name.endsWith('.dsh.json')) as string);
          }
          const boot = await bootstrap(host, HIST_SLOT, workspace, stub);
          row.resumeMs = boot.ms;
          row.hasInitialHistory = boot.result.initialHistory !== undefined;
          await sleep(4000);
          row.afterResume = await memOf(host);
          if (Number(snap.turns) > 0) {
            const last = Number(snap.turns);
            const markers = [`H1-${7919 % 10007}`, `H${last}-${(last * 7919) % 10007}`];
            const t = await turn(
              host,
              HIST_SLOT,
              `${label}-recall`,
              `P0-RECALL ${JSON.stringify({ markers })} 回顾一下第一轮和最后一轮。`,
              180_000
            );
            const line = readJsonl(gateway.logFile)
              .filter((l) => String(l.decision ?? '').startsWith('RECALL'))
              .at(-1);
            row.recall = {
              ms: t.ms,
              end: t.end,
              decision: line?.decision,
              requestChars: line?.bodyChars,
              messagesBeforeTrigger: (line?.probe as Message | undefined)?.messagesBeforeTrigger,
            };
            await sleep(2000);
            row.afterTurn = await memOf(host);
            row.hwmMb = round(
              Number(
                readFileSync(`/proc/${host.pid}/status`, 'utf8').match(/^VmHWM:\s+(\d+)/m)?.[1]
              ) / 1024,
              1
            );
          }
          row.deltaRssMb = round(
            Number((row.afterResume as Message).rssMb) - Number((row.baseline as Message).rssMb),
            1
          );
          row.deltaHeapUsedMb = round(
            Number((row.afterResume as Message).heapUsedMb) -
              Number((row.baseline as Message).heapUsedMb),
            1
          );
          row.shutdown = await host.shutdown();
        } catch (error) {
          row.error = error instanceof Error ? error.message : String(error);
          row.stderrTail = host.stderr().slice(-2000);
          host.signal('SIGKILL');
        }
        log(
          `${label}: resume ${String(row.resumeMs)} ms, dRSS ${String(row.deltaRssMb)} MB, dHeap ${String(row.deltaHeapUsedMb)} MB`
        );
        cases.push(row);
        if (!keep) rmSync(box.root, { recursive: true, force: true });
      }
    }
  } finally {
    gateway.child.kill('SIGTERM');
  }
  report.generation = {
    turns: gen.turns,
    snapshots: snapshots.map((s) => ({
      turns: s.turns,
      messages: s.messages,
      events: s.events,
      sizeBytes: s.sizeBytes,
      elapsedMs: s.elapsedMs,
    })),
    perTurnSample: gen.perTurnSample,
    gateway: gen.gateway,
  };
  report.cases = cases;
  report.summary = sizes.map((snap) => {
    const rows = cases.filter((row) => row.turns === snap.turns && !row.error);
    const med = (get: (row: Message) => number) => round(median(rows.map(get)), 1);
    return {
      turns: snap.turns,
      messages: snap.messages,
      sizeBytes: snap.sizeBytes,
      runs: rows.length,
      baselineRssMb: med((row) => Number((row.baseline as Message).rssMb)),
      afterResumeRssMb: med((row) => Number((row.afterResume as Message).rssMb)),
      deltaRssMb: med((row) => Number(row.deltaRssMb)),
      deltaHeapUsedMb: med((row) => Number(row.deltaHeapUsedMb)),
      resumeMs: med((row) => Number(row.resumeMs)),
      ...(Number(snap.turns) > 0
        ? {
            afterTurnRssMb: med((row) => Number((row.afterTurn as Message).rssMb)),
            afterTurnHeapUsedMb: med((row) => Number((row.afterTurn as Message).heapUsedMb)),
            hwmMb: med((row) => Number(row.hwmMb)),
            recallTurnMs: med((row) => Number((row.recall as Message).ms)),
            recallDecisions: rows.map((row) => (row.recall as Message).decision),
          }
        : {}),
    };
  });
  report.finishedAt = new Date().toISOString();
  return report;
}

// ---- several long sessions in one host ------------------------------------------------

const histToken = (session: number, i: number) => `M${session}H${i}-${(i * 7919) % 10007}`;

async function historyMultiGenMode() {
  const sessions = Number(option('sessions', '4'));
  const turns = Number(option('turns', '500'));
  const root = join(histDir, 'multi-gen');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  await waitQuiet();
  const box = sandbox(root, 'box');
  const files = seedWorkspace(box.workspace, 40);
  const gateway = await startGateway(box.root);
  const report: Message = { mode: 'history-multi-gen', sessions, turns, machine: machine() };
  const host = new SharedHost('multi-gen', box, gateway.port, {
    AICLIENT_DSH_COMPACTION_AUTO: '0',
  });
  const slots = Array.from({ length: sessions }, (_, k) => `p06-multi-${k + 1}`);
  const stubs: Record<string, string> = {};
  const ids: Record<string, string> = {};
  try {
    await host.waitReady();
    for (const slot of slots) {
      const boot = await bootstrap(host, slot, box.workspace);
      stubs[slot] = String(boot.result.sessionFile).slice(box.dshHome.length + 1);
      ids[slot] = String(boot.result.piSessionId);
    }
    const started = performance.now();
    await Promise.all(
      slots.map(async (slot, k) => {
        for (let i = 1; i <= turns; i += 1) {
          const params = { i, file: files[(i + k) % files.length], token: histToken(k + 1, i) };
          const t = await turn(
            host,
            slot,
            `${slot}-${i}`,
            `P0-HIST ${JSON.stringify(params)} 请阅读这个文件并总结要点，特别留意错误处理、超时参数和并发写入的部分，最后给出下一步建议。`,
            180_000
          );
          if (t.end !== 'session.completed')
            throw new Error(`${slot} turn ${i} ended ${String(t.end)}`);
          if (i % 100 === 0) log(`${slot} turn ${i}: ${t.ms} ms`);
        }
      })
    );
    report.elapsedMs = round(performance.now() - started, 0);
    await sleep(1500);
    report.sessionsOnDisk = Object.fromEntries(
      await Promise.all(
        slots.map(async (slot) => {
          const summary = await host.p06('read-session', { sessionId: ids[slot] });
          return [
            slot,
            { messages: summary.messages, events: summary.count, sizeBytes: summary.sizeBytes },
          ];
        })
      )
    );
    report.shutdown = await host.shutdown();
  } finally {
    host.signal('SIGKILL');
    gateway.child.kill('SIGTERM');
  }
  report.stubs = stubs;
  report.dshHome = box.dshHome;
  report.workspace = box.workspace;
  writeFileSync(join(histDir, 'multi-gen.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function historyMultiMode() {
  const gen = JSON.parse(readFileSync(join(histDir, 'multi-gen.json'), 'utf8')) as Message;
  const stubs = gen.stubs as Record<string, string>;
  const slots = Object.keys(stubs);
  const last = Number(gen.turns);
  const gatewayRoot = join(scratchRoot, 'gateway');
  mkdirSync(gatewayRoot, { recursive: true, mode: 0o700 });
  const gateway = await startGateway(gatewayRoot);
  const report: Message = {
    mode: 'history-multi',
    generation: { sessions: gen.sessions, turns: gen.turns, sessionsOnDisk: gen.sessionsOnDisk },
    startedAt: new Date().toISOString(),
  };
  const results: Message[] = [];
  const memOf = async (host: SharedHost) => {
    const inHost = await host.p06('mem', { gc: true });
    const proc = await sampleMem(host.pid, 5);
    const usage = inHost.memoryUsage as Record<string, number>;
    return {
      rssMb: proc.rssMedianMb,
      pssMb: proc.pssMedianMb,
      heapUsedMb: round(usage.heapUsed / 1048576, 1),
    };
  };
  try {
    for (let r = 1; r <= runs; r += 1) {
      await waitQuiet();
      const box = sandbox(scratchRoot, `multi-${r}`);
      rmSync(box.dshHome, { recursive: true, force: true });
      cpSync(String(gen.dshHome), box.dshHome, { recursive: true });
      const run: Message = { run: r, machine: machine() };
      const host = new SharedHost(`multi-${r}`, box, gateway.port, {
        AICLIENT_DSH_COMPACTION_AUTO: '0',
      });
      try {
        await host.waitReady();
        await sleep(4000);
        const steps: Message[] = [{ resumed: 0, ...(await memOf(host)) }];
        for (const [k, slot] of slots.entries()) {
          const boot = await bootstrap(
            host,
            slot,
            String(gen.workspace),
            join(box.dshHome, stubs[slot])
          );
          await sleep(4000);
          steps.push({ resumed: k + 1, resumeMs: boot.ms, ...(await memOf(host)) });
          log(`multi run ${r}: ${k + 1} resumed, ${JSON.stringify(steps.at(-1))}`);
        }
        run.steps = steps;
        // All four long sessions build and send a request at the same moment.
        await host.p06('eld-start', { resolutionMs: 10 });
        const turns = await Promise.all(
          slots.map((slot, k) =>
            turn(
              host,
              slot,
              `${slot}-r${r}-recall`,
              `P0-RECALL ${JSON.stringify({ markers: [histToken(k + 1, 1), histToken(k + 1, last)] })} 回顾一下第一轮和最后一轮。`,
              180_000
            )
          )
        );
        const stop = await host.p06('eld-stop');
        run.concurrentRecall = {
          turnMs: turns.map((t) => t.ms),
          ends: turns.map((t) => t.end),
          eld: stop.eld,
          gc: stop.gc,
          cpuMs: stop.cpuMs,
          wallMs: stop.wallMs,
          decisions: readJsonl(gateway.logFile)
            .filter((l) => String(l.decision ?? '').startsWith('RECALL'))
            .slice(-slots.length)
            .map((l) => l.decision),
        };
        await sleep(2000);
        run.afterTurns = await memOf(host);
        run.hwmMb = round(
          Number(readFileSync(`/proc/${host.pid}/status`, 'utf8').match(/^VmHWM:\s+(\d+)/m)?.[1]) /
            1024,
          1
        );
        run.shutdown = await host.shutdown();
      } catch (error) {
        run.error = error instanceof Error ? error.message : String(error);
        run.stderrTail = host.stderr().slice(-2000);
        host.signal('SIGKILL');
      }
      results.push(run);
      if (!keep) rmSync(box.root, { recursive: true, force: true });
    }
  } finally {
    gateway.child.kill('SIGTERM');
  }
  report.runs = results;
  const ok = results.filter((run) => !run.error);
  report.summary = {
    steps: [0, ...slots.map((_, k) => k + 1)].map((n) => {
      const rows = ok.map((run) => (run.steps as Message[])[n]);
      return {
        resumed: n,
        rssMb: round(median(rows.map((row) => Number(row.rssMb))), 1),
        heapUsedMb: round(median(rows.map((row) => Number(row.heapUsedMb))), 1),
        ...(n > 0 ? { resumeMs: round(median(rows.map((row) => Number(row.resumeMs))), 1) } : {}),
      };
    }),
    concurrentRecall: {
      eldMaxMs: ok.map((run) => ((run.concurrentRecall as Message).eld as Message).max),
      eldP99Ms: ok.map((run) => ((run.concurrentRecall as Message).eld as Message).p99),
      turnMs: ok.map((run) => (run.concurrentRecall as Message).turnMs),
      afterTurnsRssMb: round(median(ok.map((run) => Number((run.afterTurns as Message).rssMb))), 1),
      hwmMb: round(median(ok.map((run) => Number(run.hwmMb))), 1),
    },
  };
  report.finishedAt = new Date().toISOString();
  return report;
}

// ---- native worker comparison ---------------------------------------------------------

const NATIVE_BOOT = { model: 'fake/fake-1', effort: 'low', tier: 'fullopen' };

/** Our native worker (one process, one session) behind the same RpcTarget shape. */
class NativeWorker implements RpcTarget {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  readonly stderr: () => string;
  private seq = 0;
  private readonly log: Message[] = [];
  private readonly pending = new Map<
    string,
    { done: (m: Message) => void; fail: (e: Error) => void }
  >();
  private readonly waiters = new Set<() => void>();
  private gone = false;

  constructor(box: Sandbox, agentDir: string, cwd: string) {
    const traceDir = join(box.root, 'trace');
    mkdirSync(traceDir, { recursive: true, mode: 0o700 });
    const env = {
      ...baseEnv(box),
      PI_CODING_AGENT_DIR: agentDir,
      AICLIENT_RUNTIME_AGENT_DIR: agentDir,
      AICLIENT_RUNTIME_TRACE_DIR: traceDir,
      AICLIENT_PI_TRUST_PROJECT_CONFIG: '0',
      AICLIENT_PI_WORKER_GENERATION: '1',
    };
    this.child = launch([nodeBin, '--import', hooksEntry, workerEntry], env, cwd);
    this.pid = this.child.pid as number;
    this.stderr = captureStderr(this.child);
    this.exited = exitOf(this.child).then((exit) => {
      this.gone = true;
      for (const pending of this.pending.values()) pending.fail(new Error('worker exited'));
      this.pending.clear();
      for (const wake of [...this.waiters]) wake();
      return exit;
    });
    this.child.on('message', (raw: unknown) => {
      const message = raw as Message;
      if (message?.kind === 'response') {
        const pending = this.pending.get(String(message.requestId));
        if (!pending) return;
        this.pending.delete(String(message.requestId));
        if (message.ok) pending.done((message.result ?? {}) as Message);
        else pending.fail(new Error(JSON.stringify(message.error)));
      } else if (message?.kind === 'event' && message.type === 'runtime.event') {
        this.log.push(message.payload as Message);
        for (const wake of [...this.waiters]) wake();
      }
    });
  }

  request(_slot: string, type: string, payload: Message, timeoutMs = 120_000): Promise<Message> {
    const requestId = `native-${++this.seq}`;
    if (!this.child.connected) return Promise.reject(new Error('worker not connected'));
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        fail(new Error(`native ${type} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, {
        done: (m) => {
          clearTimeout(timer);
          done(m);
        },
        fail: (e) => {
          clearTimeout(timer);
          fail(e);
        },
      });
      this.child.send({
        protocolVersion: 1,
        kind: 'request',
        generation: 1,
        requestId,
        type,
        payload,
      });
    });
  }

  until(
    _slot: string,
    predicate: (events: Message[]) => boolean,
    timeoutMs: number
  ): Promise<boolean> {
    if (predicate(this.log)) return Promise.resolve(true);
    if (this.gone) return Promise.resolve(false);
    return new Promise((done) => {
      const wake = () => {
        const held = predicate(this.log);
        if (!held && !this.gone) return;
        clearTimeout(timer);
        this.waiters.delete(wake);
        done(held);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        done(false);
      }, timeoutMs);
      this.waiters.add(wake);
    });
  }

  events(): Message[] {
    return this.log;
  }

  eventCount(): number {
    return this.log.length;
  }

  async dispose(): Promise<Message> {
    const started = performance.now();
    await this.request('', 'worker.dispose', { reason: 'app-shutdown' }, 20_000).catch(
      () => undefined
    );
    const graceful = await stopWithin(this.exited, 15_000);
    if (!graceful && this.child.exitCode === null && this.child.signalCode === null) {
      killPid(this.pid, 'SIGKILL');
    }
    return { graceful, stopMs: round(performance.now() - started, 0), exit: await this.exited };
  }
}

/** A models.json / auth.json pair pointing our worker at the fake gateway. */
function writeWorkerConfig(agentDir: string, port: number) {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${port}`,
          api: 'anthropic-messages',
          // A window no P0 history reaches, so no compaction rewrites the log.
          models: [{ id: 'fake-1', name: 'P0-6 fake', contextWindow: 10_000_000, maxTokens: 8192 }],
        },
      },
    })
  );
  writeFileSync(
    join(agentDir, 'auth.json'),
    JSON.stringify({ fake: { type: 'api_key', key: 'p0-6-fake-key' } })
  );
}

/** Message rows of a pi session file, by role. */
function piSessionStats(file: string) {
  const roles: Record<string, number> = {};
  let rows = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    rows += 1;
    const role = line.match(/"type":"message"[\s\S]*?"role":"(\w+)"/)?.[1];
    if (role) roles[role] = (roles[role] ?? 0) + 1;
  }
  return {
    rows,
    roles,
    messages: Object.values(roles).reduce((a, b) => a + b, 0),
    sizeBytes: statSync(file).size,
  };
}

async function workerHistoryGenMode() {
  const gen = JSON.parse(readFileSync(join(histDir, 'gen.json'), 'utf8')) as Message;
  const workspace = String(gen.workspace).replace('<hist>', histDir);
  const checkpoints = option('checkpoints', String(gen.checkpoints ?? '25,125,500'))
    .split(',')
    .map(Number);
  const turns = Number(option('turns', String(gen.turns ?? 500)));
  const files = readdirSync(workspace)
    .filter((name) => name.startsWith('module-'))
    .sort()
    .map((name) => join(workspace, name));
  const root = join(histDir, 'native-gen');
  rmSync(root, { recursive: true, force: true });
  const box = sandbox(root, 'box');
  const agentDir = join(root, 'agent');
  const gateway = await startGateway(box.root);
  writeWorkerConfig(agentDir, gateway.port);
  const report: Message = { mode: 'worker-history-gen', turns, checkpoints, machine: machine() };
  const snapshots: Message[] = [];
  let worker = new NativeWorker(box, agentDir, workspace);
  try {
    const boot = await bootstrap(worker, 'p06-native-hist', workspace, undefined, NATIVE_BOOT);
    const sessionFile = String(boot.result.sessionFile);
    report.sessionFile = sessionFile.replace(agentDir, '<agent>');
    const started = performance.now();
    for (let i = 1; i <= turns; i += 1) {
      const params = {
        i,
        file: files[i % files.length],
        token: `H${i}-${(i * 7919) % 10007}`,
        native: true,
      };
      const t = await turn(
        worker,
        'p06-native-hist',
        `native-hist-${i}`,
        `P0-HIST ${JSON.stringify(params)} 请阅读这个文件并总结要点，特别留意错误处理、超时参数和并发写入的部分，最后给出下一步建议。`
      );
      if (t.end !== 'session.completed') {
        throw new Error(`native turn ${i} ended ${String(t.end)}: ${JSON.stringify(t.endPayload)}`);
      }
      if (i % 50 === 0) log(`native turn ${i}: ${t.ms} ms`);
      if (checkpoints.includes(i)) {
        await worker.dispose();
        const target = join(histDir, `native-snap-${i}`);
        rmSync(target, { recursive: true, force: true });
        cpSync(agentDir, join(target, 'agent'), { recursive: true });
        snapshots.push({
          turns: i,
          elapsedMs: round(performance.now() - started, 0),
          ...piSessionStats(sessionFile),
          sessionFile: join(target, 'agent', sessionFile.slice(agentDir.length + 1)),
        });
        log(`native checkpoint ${i}: ${JSON.stringify(snapshots.at(-1))}`);
        if (i < turns) {
          worker = new NativeWorker(box, agentDir, workspace);
          await bootstrap(worker, 'p06-native-hist', workspace, sessionFile, NATIVE_BOOT);
        }
      }
    }
  } finally {
    if (worker.child.exitCode === null && worker.child.signalCode === null) await worker.dispose();
    gateway.child.kill('SIGTERM');
  }
  report.snapshots = snapshots;
  report.workspace = workspace;
  report.gatewayRequests = readJsonl(gateway.logFile).length;
  writeFileSync(join(histDir, 'native-gen.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function workerHistoryMode() {
  const gen = JSON.parse(readFileSync(join(histDir, 'native-gen.json'), 'utf8')) as Message;
  const snapshots = gen.snapshots as Message[];
  const workspace = String(gen.workspace);
  const gatewayRoot = join(scratchRoot, 'gateway');
  mkdirSync(gatewayRoot, { recursive: true, mode: 0o700 });
  const gateway = await startGateway(gatewayRoot);
  const report: Message = {
    mode: 'worker-history',
    node: nodeBin,
    startedAt: new Date().toISOString(),
  };
  const cases: Message[] = [];
  const sizes = [{ turns: 0 } as Message, ...snapshots];
  try {
    for (let r = 1; r <= runs; r += 1) {
      for (const snap of sizes) {
        await waitQuiet();
        const label = `native-${String(snap.turns)}-r${r}`;
        const box = sandbox(scratchRoot, label);
        const agentDir = join(box.root, 'agent');
        let sessionFile: string | undefined;
        if (Number(snap.turns) > 0) {
          const snapAgent = join(histDir, `native-snap-${String(snap.turns)}`, 'agent');
          cpSync(snapAgent, agentDir, { recursive: true });
          sessionFile = join(agentDir, String(snap.sessionFile).slice(snapAgent.length + 1));
        }
        writeWorkerConfig(agentDir, gateway.port);
        const row: Message = {
          run: r,
          turns: snap.turns,
          messages: snap.messages,
          machine: machine(),
        };
        const worker = new NativeWorker(box, agentDir, workspace);
        try {
          const boot = await bootstrap(worker, 'p06-native', workspace, sessionFile, NATIVE_BOOT);
          row.bootstrapMs = boot.ms;
          const history = boot.result.initialHistory as Message | undefined;
          row.initialHistory = history
            ? {
                totalCount: (history.page as Message | undefined)?.totalCount,
                returned: ((history.page as Message | undefined)?.messages as unknown[] | undefined)
                  ?.length,
              }
            : null;
          await sleep(4000);
          row.afterBootstrap = await sampleMem(worker.pid, 5);
          if (Number(snap.turns) > 0) {
            const last = Number(snap.turns);
            const markers = [`H1-${7919 % 10007}`, `H${last}-${(last * 7919) % 10007}`];
            const t = await turn(
              worker,
              'p06-native',
              `${label}-recall`,
              `P0-RECALL ${JSON.stringify({ markers })} 回顾一下第一轮和最后一轮。`,
              180_000
            );
            const line = readJsonl(gateway.logFile)
              .filter((l) => String(l.decision ?? '').startsWith('RECALL'))
              .at(-1);
            row.recall = {
              ms: t.ms,
              end: t.end,
              decision: line?.decision,
              requestChars: line?.bodyChars,
            };
            await sleep(2000);
            row.afterTurn = await sampleMem(worker.pid, 5);
          }
          row.hwmMb = round(
            Number(
              readFileSync(`/proc/${worker.pid}/status`, 'utf8').match(/^VmHWM:\s+(\d+)/m)?.[1]
            ) / 1024,
            1
          );
          row.shutdown = await worker.dispose();
        } catch (error) {
          row.error = error instanceof Error ? error.message : String(error);
          row.stderrTail = worker.stderr().slice(-2000);
          if (worker.child.exitCode === null && worker.child.signalCode === null)
            killPid(worker.pid, 'SIGKILL');
        }
        log(
          `${label}: bootstrap ${String(row.bootstrapMs)} ms, RSS ${String((row.afterBootstrap as Message | undefined)?.rssMedianMb)} MB`
        );
        cases.push(row);
        if (!keep) rmSync(box.root, { recursive: true, force: true });
      }
    }
  } finally {
    gateway.child.kill('SIGTERM');
  }
  report.generation = { turns: gen.turns, snapshots: gen.snapshots };
  report.cases = cases;
  const empty = cases.filter((row) => row.turns === 0 && !row.error);
  const emptyRss = median(empty.map((row) => Number((row.afterBootstrap as Message).rssMedianMb)));
  report.summary = sizes.map((snap) => {
    const rows = cases.filter((row) => row.turns === snap.turns && !row.error);
    const med = (get: (row: Message) => number) => round(median(rows.map(get)), 1);
    return {
      turns: snap.turns,
      messages: snap.messages,
      sizeBytes: snap.sizeBytes,
      runs: rows.length,
      rssMb: med((row) => Number((row.afterBootstrap as Message).rssMedianMb)),
      pssMb: med((row) => Number((row.afterBootstrap as Message).pssMedianMb)),
      deltaVsEmptyMb: round(
        med((row) => Number((row.afterBootstrap as Message).rssMedianMb)) - emptyRss,
        1
      ),
      bootstrapMs: med((row) => Number(row.bootstrapMs)),
      ...(Number(snap.turns) > 0
        ? {
            afterTurnRssMb: med((row) => Number((row.afterTurn as Message).rssMedianMb)),
            hwmMb: med((row) => Number(row.hwmMb)),
            recallDecisions: rows.map((row) => (row.recall as Message).decision),
          }
        : {}),
    };
  });
  report.finishedAt = new Date().toISOString();
  return report;
}

// ---- main ------------------------------------------------------------------------------

async function main() {
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  log(`mode ${mode}; scratch ${scratchRoot}; node ${nodeBin}`);
  let report: Message;
  if (mode === 'crash') report = await crashMode();
  else if (mode === 'latency') report = await latencyMode();
  else if (mode === 'history-gen') report = await historyGenMode();
  else if (mode === 'history') report = await historyMode();
  else if (mode === 'history-multi-gen') report = await historyMultiGenMode();
  else if (mode === 'history-multi') report = await historyMultiMode();
  else if (mode === 'worker-history-gen') report = await workerHistoryGenMode();
  else if (mode === 'worker-history') report = await workerHistoryMode();
  else throw new Error(`unknown mode ${mode}`);
  const json = `${JSON.stringify(report, null, 2)}\n`
    .split(scratchRoot)
    .join('<scratch>')
    .split(histDir)
    .join('<hist>');
  if (outFile) writeFileSync(outFile, json);
  process.stdout.write(`${json.slice(0, 4000)}\n`);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
  else log(`kept ${scratchRoot}`);
}

await main();
