/**
 * dsh-rebase P1-8 long-session contention regression (decision 067; plan
 * P1-8 shard 05 §3-§4): LC-0 to LC-2 on the shared DSH host, driven the way
 * Main's supervisor drives it (channel envelopes, heartbeat pings), observed
 * through the heartbeat's own pong (`eldMaxMs`, `rssMb`). Local script only;
 * no CI wiring yet.
 *
 *   (cd src/dsh-host && ../../out-node-runtime/node tools/contention-regression.ts
 *      [--runs 1] [--only LC-0|LC-1|LC-2] [--turns 500] [--out f.json] [--keep])
 *
 *   LC-0  a fresh host idles 10 s after ready.
 *   LC-1  8 new sessions run one P0-LOAD turn each (200 stamped text deltas
 *         around bash / read calls), started 350 ms apart, after one warm-up
 *         turn. Every delta arrives on its own channel.
 *   LC-2  4 sessions of `--turns` x 4 messages (2000), synthesized in 1.0.x's
 *         format, converted by P1-9's converter and admitted as seeds
 *         (`agents.create({seed})`, experiment E7: time and memory), are
 *         resumed in a fresh host with automatic compaction off (worst case);
 *         a fifth, new session streams a paced answer as the victim while the
 *         four send one request each at the same moment.
 *
 * Hard gates (a failure exits 1) are the maxima over the runs; soft gates,
 * medians, only warn:
 *   LC-0  ELD <= 50 ms, RSS <= 300 MB               (soft 10 ms / 230 MB)
 *   LC-1  all 8 x 200 deltas on the right channel, turns completed,
 *         ELD <= 150 ms, RSS <= 350 MB              (soft 60 ms / 260 MB)
 *   LC-2  5 turns completed, ELD <= 1000 ms, the victim's largest gap between
 *         deltas <= ELD + 150 ms, RSS <= 600 MB, every ping answered, no pong
 *         slower than 2 s                           (soft 450 ms / 450 MB)
 *         The victim (P8-VICTIM) stamps every delta with its send time; its
 *         gaps are corrected for the fake gateway's own stalls (one process
 *         also parsing the four long requests), so the gate sees what the host
 *         and the IPC link added. The raw gaps are reported beside it.
 * ELD is the pong's `eldMaxMs` (worst stall beyond the bridge's 50 ms sampling
 * period since the previous pong), pinged every 250 ms as Main's supervisor
 * would, if more often.
 *
 * Every model request goes to the local fake gateway (plan dsh-p0-2); the
 * probe hooks drop any non-loopback connect. One host at a time; needs 900 MB
 * available. Signals only go to a ChildProcess this script spawned.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { convertPiSessionBytes } from '../../shared/legacyPiSession/convert/index.ts';
import { fakeGatewayPlan, HostClient, isRecord, type Message } from './lib/hostClient.ts';
import {
  baseEnv,
  captureStderr,
  exitOf,
  median,
  procCmdline,
  readMem,
  round,
  type Sandbox,
  sandbox,
  sleep,
  stopWithin,
} from './lib/kit.ts';
import { installProbeBundle } from './lib/probe-bundle.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const hostEntry = join(hostDir, 'host.ts');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const bundledNode = join(repoRoot, 'out-node-runtime', 'node');
const TEMPLATE = join(
  repoRoot,
  'src',
  'shared',
  '__tests__',
  'fixtures',
  'legacy-pi',
  'v4-basic.jsonl'
);

const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const nodeBin = option('node', existsSync(bundledNode) ? bundledNode : process.execPath);
const runs = Math.max(1, Number(option('runs', '1')));
const only = option('only', '');
const turnsPerSession = Number(option('turns', '500'));
const outFile = option('out', '');
const keep = argv.includes('--keep');
const quietWaitMs = Number(option('quiet-wait', '300')) * 1000;
const scratchRoot = join('/var/tmp', `aiclient-dsh-contention-${Date.now()}`);
const log = (message: string) => process.stderr.write(`[contention] ${message}\n`);
const MIN_AVAILABLE_MB = 900;
const PING_MS = 250;
const STAMP = /‹t\d+›/g;
/** The victim's pacing (P8-VICTIM), the 150 of the gate "gap <= ELD + 150 ms". */
const VICTIM_CHUNK_MS = 150;
const nowUs = () => Number(process.hrtime.bigint() / 1000n);

/** Decision 067 / shard 05 §4. */
const GATES = {
  'LC-0': { hard: { eldMs: 50, rssMb: 300 }, soft: { eldMs: 10, rssMb: 230 } },
  'LC-1': { hard: { eldMs: 150, rssMb: 350 }, soft: { eldMs: 60, rssMb: 260 } },
  'LC-2': {
    hard: { eldMs: 1000, rssMb: 600, victimGapOverEldMs: 150, pongRttMs: 2000 },
    soft: { eldMs: 450, rssMb: 450 },
  },
} as const;

type Scenario = keyof typeof GATES;

function availableMb(): number {
  const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
  return match ? Number(match[1]) / 1024 : Number.NaN;
}

/** Wait (bounded) until no vitest process runs and 900 MB are available. */
async function settleMachine(label: string): Promise<{ quiet: boolean; availableMb: number }> {
  const deadline = Date.now() + quietWaitMs;
  let announced = false;
  while (true) {
    const busy = readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid)
      .some((pid) => /vitest/.test(procCmdline(Number(pid))));
    const available = availableMb();
    if (!busy && available >= MIN_AVAILABLE_MB)
      return { quiet: true, availableMb: round(available) };
    if (Date.now() > deadline) {
      if (available < MIN_AVAILABLE_MB)
        throw new Error(`${label}: only ${round(available)} MB available`);
      return { quiet: false, availableMb: round(available) };
    }
    if (!announced)
      log(`${label}: waiting for a quiet machine (vitest ${busy}, ${round(available)} MB)`);
    announced = true;
    await sleep(3000);
  }
}

// ---- processes ---------------------------------------------------------------------

async function startGateway(root: string): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(
    nodeBin,
    [gatewayEntry, '--port', '0', '--plan', 'dsh-p0-2', '--reset', '--model-id', 'fake-1'].concat([
      '--state',
      join(root, 'gateway.state.json'),
      '--log',
      join(root, 'gateway.jsonl'),
    ]),
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
    setTimeout(() => fail(new Error('fake gateway did not start')), 15_000);
  });
  child.stderr?.resume();
  return { child, port };
}

interface Host {
  label: string;
  child: ChildProcess;
  client: HostClient;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
  pid: number;
}

async function startHost(
  label: string,
  box: Sandbox,
  port: number,
  extraEnv: Record<string, string> = {}
): Promise<Host> {
  const hostCwd = join(box.root, `host-cwd-${label}`);
  mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
  const env = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    // Sessions are driven through the product bridge; the probe row would answer approvals.
    AICLIENT_DSH_PROBE_ROW: '0',
    ...extraEnv,
  };
  const child = spawn(nodeBin, ['--expose-internals', '--import', hooksEntry, hostEntry], {
    cwd: hostCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // HostClient and the probes below each listen on the IPC channel.
  child.setMaxListeners(100);
  const host: Host = {
    label,
    child,
    client: new HostClient(child, { requestPrefix: `lc-${label}` }),
    stderr: captureStderr(child),
    exited: exitOf(child),
    pid: child.pid as number,
  };
  // P1-5: Main's model source, played — one route to the gateway, a fake key per request.
  host.client.configure(fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${port}` }), 'p1-8-fake-key');
  const ready = await host.client.control((m) => m.type === 'ready' || m.type === 'fatal', 180_000);
  if (ready?.type !== 'ready') {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    throw new Error(`${label}: no ready ${JSON.stringify(ready)} ${host.stderr().slice(-1500)}`);
  }
  return host;
}

async function stopHost(host: Host) {
  host.client.send({ type: 'shutdown' });
  const graceful = await stopWithin(host.exited, 20_000);
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
  return { graceful, exit: await host.exited };
}

// ---- heartbeat ---------------------------------------------------------------------

interface PingStats {
  pings: number;
  answered: number;
  unanswered: number;
  maxRttMs: number;
  eldMaxMs: number;
  rssMaxMb: number;
  rssLastMb: number;
}

/** Ping every 250 ms as the supervisor does; collect what each pong says. */
function startPings(host: Host) {
  const sent = new Map<number, number>();
  const pongs: Array<{ rttMs: number; eldMaxMs: number; rssMb: number }> = [];
  let nextId = 1_000_000 * (1 + Math.floor(Math.random() * 1000));
  const onMessage = (message: unknown) => {
    if (!isRecord(message) || message.host !== 'pong') return;
    const at = sent.get(Number(message.id));
    if (at === undefined) return;
    sent.delete(Number(message.id));
    pongs.push({
      rttMs: performance.now() - at,
      eldMaxMs: Number(message.eldMaxMs),
      rssMb: Number(message.rssMb),
    });
  };
  host.child.on('message', onMessage);
  const ping = () => {
    const id = ++nextId;
    sent.set(id, performance.now());
    host.client.send({ host: 'ping', id });
  };
  // Reset the host's worst-since-last-pong window at the start.
  ping();
  const timer = setInterval(ping, PING_MS);
  return {
    async stop(): Promise<PingStats> {
      clearInterval(timer);
      ping();
      const deadline = Date.now() + 3000;
      while (sent.size > 0 && Date.now() < deadline) await sleep(50);
      host.child.off('message', onMessage);
      // The first pong reports the window before the scenario began.
      const window = pongs.slice(1);
      return {
        pings: window.length + sent.size,
        answered: window.length,
        unanswered: sent.size,
        maxRttMs: round(Math.max(0, ...pongs.map((p) => p.rttMs)), 1),
        eldMaxMs: round(Math.max(0, ...window.map((p) => p.eldMaxMs)), 1),
        rssMaxMb: round(Math.max(0, ...pongs.map((p) => p.rssMb)), 1),
        rssLastMb: round(pongs.at(-1)?.rssMb ?? 0, 1),
      };
    },
  };
}

// ---- sessions ----------------------------------------------------------------------

async function bootstrap(
  host: Host,
  logicalSessionId: string,
  cwd: string,
  sessionFile?: string
): Promise<{ ch: string; ms: number }> {
  const ch = host.client.openChannel();
  const started = performance.now();
  await host.client.request(
    ch,
    'worker.bootstrap',
    { logicalSessionId, cwd, ...(sessionFile ? { sessionFile } : {}) },
    180_000
  );
  return { ch, ms: round(performance.now() - started, 0) };
}

interface TurnResult {
  ch: string;
  logicalSessionId: string;
  idle: boolean;
  completed: boolean;
  ms: number;
  stamps: number;
  foreignEvents: number;
  /** Every assistant delta: Main-side receipt time and, when stamped, the gateway's send time (µs, CLOCK_MONOTONIC). */
  deltas: Array<{ recvUs: number; sentUs?: number }>;
  reply: string;
}

async function runTurn(
  host: Host,
  ch: string,
  logicalSessionId: string,
  requestId: string,
  text: string,
  timeoutMs = 180_000
): Promise<TurnResult> {
  const client = host.client;
  const from = client.events(ch).length;
  const deltas: Array<{ recvUs: number; sentUs?: number }> = [];
  const assistant = new Set<unknown>();
  // Main-side receipt time of every assistant delta of this channel.
  const onMessage = (message: unknown) => {
    if (!isRecord(message) || message.ch !== ch || !isRecord(message.rpc)) return;
    const event = message.rpc.payload as Message | undefined;
    if (message.rpc.type !== 'runtime.event' || !event) return;
    const payload = (event.payload ?? {}) as Message;
    if (event.type === 'message.started' && payload.role === 'assistant')
      assistant.add(payload.messageId);
    if (event.type === 'message.delta' && assistant.has(payload.messageId)) {
      const stamp = String(payload.text ?? '').match(/‹t(\d+)›/);
      deltas.push({ recvUs: nowUs(), ...(stamp ? { sentUs: Number(stamp[1]) } : {}) });
    }
  };
  host.child.on('message', onMessage);
  const started = performance.now();
  try {
    await client.request(ch, 'worker.send', {
      logicalSessionId,
      requestId,
      attemptId: `${requestId}-a`,
      text,
    });
    const idle = await client.until(
      ch,
      (events) =>
        events
          .slice(from)
          .some(
            (e) =>
              e.type === 'session.status' &&
              (e.payload as Message | undefined)?.status === 'idle' &&
              e.requestId === requestId
          ),
      timeoutMs
    );
    const events = client.events(ch).slice(from);
    const replyText = events
      .filter(
        (e) => e.type === 'message.delta' && assistant.has(((e.payload ?? {}) as Message).messageId)
      )
      .map((e) => String(((e.payload ?? {}) as Message).text ?? ''))
      .join('');
    return {
      ch,
      logicalSessionId,
      idle,
      completed: events.some((e) => e.type === 'session.completed'),
      ms: round(performance.now() - started, 0),
      stamps: replyText.match(STAMP)?.length ?? 0,
      foreignEvents: events.filter((e) => e.sessionId !== logicalSessionId).length,
      deltas,
      reply: replyText.replace(STAMP, '').slice(0, 160),
    };
  } finally {
    host.child.off('message', onMessage);
  }
}

function seedWorkspace(dir: string, files: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < files; i += 1) {
    const lines: string[] = [`// module ${i}: generated for the contention regression`];
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
  return paths;
}

// ---- LC-2 history (read-page-probe's generator, four sessions) -----------------------

const WORDS = (
  'the a build test file error module function value session history page host read ' +
  'write cache index render timeline message tool result step turn model prompt answer ' +
  'context summary branch commit merge review patch diff config setting option path ' +
  'workspace project source target output input stream buffer event queue worker slot ' +
  'channel lock stub log frame record header schema field type string number array'
).split(' ');

function prose(seed: number, chars: number): string {
  let state = (seed * 2654435761) >>> 0 || 1;
  let text = '';
  while (text.length < chars) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const word = WORDS[state % WORDS.length] as string;
    text += state % 11 === 0 ? `${word}. ` : state % 29 === 0 ? `${word}\n` : `${word} `;
  }
  return text.slice(0, chars);
}

function uuid(k: number, n: number): string {
  return `00000000-0000-4000-8000-${(k * 1_000_000 + n).toString(16).padStart(12, '0')}`;
}

/** `turns` turns of v4-basic's first turn (prompt, think + text + read, result, answer). */
function syntheticSession(cwd: string, turns: number, salt: number): Buffer {
  const lines = readFileSync(TEMPLATE, 'utf8').split('\n').filter(Boolean);
  const header = { ...JSON.parse(lines[0] as string), cwd, id: uuid(9, salt) };
  const template = lines.slice(4, 8).map((line) => JSON.parse(line) as Message);
  const out = [JSON.stringify(header)];
  let seq = 0;
  let parentId: string | null = null;
  let time = Number(header.createdAt) + 1000;
  for (let turn = 0; turn < turns; turn += 1) {
    template.forEach((entry, index) => {
      seq += 1;
      time += 250;
      const id = uuid(index + 1 + salt * 10, turn);
      const message = structuredClone(entry.message) as Message;
      const callId = `call-read-${salt}-${turn}`;
      const mix = salt * 100_000 + turn * 8 + index * 2;
      if (message.role === 'user') {
        message.content = [{ type: 'text', text: `Turn ${turn}. ${prose(mix, 240)}` }];
      } else if (message.role === 'toolResult') {
        message.toolCallId = callId;
        message.content = [{ type: 'text', text: prose(mix, 1800) }];
      } else if (Array.isArray(message.content)) {
        message.content = (message.content as Message[]).map((block, position) => {
          if (block.type === 'toolCall') return { ...block, id: callId };
          if (block.type === 'thinking') return { ...block, thinking: prose(mix + position, 400) };
          if (block.type === 'text') return { ...block, text: prose(mix + position + 1, 700) };
          return block;
        });
      }
      message.timestamp = time;
      out.push(JSON.stringify({ ...entry, message, id, seq, parentId, timestamp: time }));
      parentId = id;
    });
  }
  return Buffer.from(`${out.join('\n')}\n`);
}

/** E7: seed four long sessions in their own host, then close it. */
async function seedLongSessions(box: Sandbox, port: number, count: number) {
  const host = await startHost('seed', box, port);
  const facts: Message = { sessions: [] };
  let peakKb = readMem(host.pid).rssKb;
  const sampler = setInterval(() => {
    try {
      peakKb = Math.max(peakKb, readMem(host.pid).rssKb);
    } catch {
      // Host gone; the seed call reports it.
    }
  }, 50);
  const stubs: string[] = [];
  try {
    for (let k = 1; k <= count; k += 1) {
      const logical = `lc2-long-${k}`;
      const dshId = `aiclient-${logical}`;
      const bytes = syntheticSession(box.workspace, turnsPerSession, k);
      const convertStarted = performance.now();
      const converted = convertPiSessionBytes(bytes, {
        sourceFile: join(box.root, `${logical}.jsonl`),
        cwd: box.workspace,
      });
      if (!converted.ok) throw new Error(`conversion failed: ${JSON.stringify(converted.failure)}`);
      const convertMs = round(performance.now() - convertStarted, 0);
      const seeded = await host.client.probe(
        'seed',
        { sessionId: dshId, cwd: box.workspace, events: converted.seed },
        300_000
      );
      const stubFile = join(box.dshHome, 'aiclient-sessions', `${dshId}.dsh.json`);
      mkdirSync(dirname(stubFile), { recursive: true, mode: 0o700 });
      const stub = {
        engine: 'dsh',
        version: 1,
        dshSessionId: dshId,
        logicalSessionId: logical,
        cwd: box.workspace,
        createdAt: Date.now(),
      };
      writeFileSync(stubFile, `${JSON.stringify(stub, null, 2)}\n`);
      stubs.push(stubFile);
      (facts.sessions as Message[]).push({
        logical,
        sourceBytes: bytes.length,
        seedEvents: converted.seed.length,
        convertMs,
        seedMs: seeded.ms,
      });
    }
  } finally {
    clearInterval(sampler);
    facts.seedHostPeakRssMb = round(peakKb / 1024);
    facts.stop = await stopHost(host);
  }
  return { facts, stubs };
}

// ---- scenarios ---------------------------------------------------------------------

async function lc0(host: Host) {
  await sleep(3000);
  const pings = startPings(host);
  await sleep(10_000);
  return { pings: await pings.stop() };
}

async function lc1(host: Host, box: Sandbox, files: string[], run: number) {
  const load = (session: number) =>
    `P0-LOAD ${JSON.stringify({ session, file: files[session % files.length], chunks: 40, chunkMs: 30 })} 按步骤处理。`;
  // Warm-up: a fresh host's first bash / read pays one-time loads (P0-6).
  const warm = await bootstrap(host, `lc1-r${run}-warm`, box.workspace);
  const warmTurn = await runTurn(host, warm.ch, `lc1-r${run}-warm`, `lc1-r${run}-warm-t`, load(0));
  await host.client.request(warm.ch, 'worker.dispose', { reason: 'slot-dispose' });
  const slots: Array<{ ch: string; logical: string }> = [];
  for (let i = 1; i <= 8; i += 1) {
    const logical = `lc1-r${run}-s${i}`;
    slots.push({ ch: (await bootstrap(host, logical, box.workspace)).ch, logical });
  }
  await sleep(1500);
  const pings = startPings(host);
  const turns = await Promise.all(
    slots.map(async (slot, i) => {
      await sleep(i * 350);
      return runTurn(host, slot.ch, slot.logical, `${slot.logical}-t`, load(i + 1));
    })
  );
  const stats = await pings.stop();
  for (const slot of slots) {
    await host.client.request(slot.ch, 'worker.dispose', { reason: 'slot-dispose' });
  }
  return {
    warmUp: { completed: warmTurn.completed, stamps: warmTurn.stamps, ms: warmTurn.ms },
    pings: stats,
    turns: turns.map((t) => ({
      logical: t.logicalSessionId,
      completed: t.completed,
      stamps: t.stamps,
      foreignEvents: t.foreignEvents,
      ms: t.ms,
    })),
  };
}

async function lc2(box: Sandbox, port: number, stubs: string[], run: number) {
  const host = await startHost(`lc2-r${run}`, box, port, { AICLIENT_DSH_COMPACTION_AUTO: '0' });
  const facts: Message = {};
  try {
    await sleep(3000);
    facts.idleRssMb = round(readMem(host.pid).rssKb / 1024);
    const long: Array<{ ch: string; logical: string; resumeMs: number }> = [];
    for (const stubFile of stubs) {
      const stub = JSON.parse(readFileSync(stubFile, 'utf8')) as Message;
      const logical = String(stub.logicalSessionId);
      const boot = await bootstrap(host, logical, box.workspace, stubFile);
      long.push({ ch: boot.ch, logical, resumeMs: boot.ms });
    }
    facts.resumeMs = long.map((item) => item.resumeMs);
    facts.afterResumeRssMb = round(readMem(host.pid).rssKb / 1024);
    const victimLogical = `lc2-r${run}-victim`;
    const victim = await bootstrap(host, victimLogical, box.workspace);
    await sleep(2000);
    const pings = startPings(host);
    const victimTurn = runTurn(
      host,
      victim.ch,
      victimLogical,
      `${victimLogical}-t`,
      `P8-VICTIM {"tag":"victim-${run}","chunks":60,"chunkMs":${VICTIM_CHUNK_MS}} 写一段长一点的说明。`
    );
    // Fire the four long requests while the victim is mid-stream.
    const firstDelta = await host.client.until(
      victim.ch,
      (events) => events.some((e) => e.type === 'message.delta'),
      30_000
    );
    await sleep(1000);
    const started = performance.now();
    const recalls = await Promise.all(
      long.map((item, k) =>
        runTurn(
          host,
          item.ch,
          item.logical,
          `${item.logical}-r${run}-recall`,
          `P0-RECALL ${JSON.stringify({ markers: ['Turn 0.', `Turn ${turnsPerSession - 1}.`] })} 回顾一下第一轮和最后一轮（${k + 1}）。`
        )
      )
    );
    facts.recallWallMs = round(performance.now() - started, 0);
    const victimResult = await victimTurn;
    const stats = await pings.stop();
    const deltas = victimResult.deltas;
    const rawGaps = deltas
      .slice(1)
      .map((d, i) => (d.recvUs - (deltas[i]?.recvUs ?? d.recvUs)) / 1000);
    // The fake gateway is one process: while it parses the four ~3 MB requests
    // its own pacing stalls too. The gate takes that out: each gap is corrected
    // by how late the gateway itself sent the delta, then measured against the
    // nominal pace, so what remains is what the host (and IPC) added.
    const correctedGaps = deltas.slice(1).flatMap((d, i) => {
      const previous = deltas[i];
      if (d.sentUs === undefined || previous?.sentUs === undefined) return [];
      return [(d.recvUs - previous.recvUs - (d.sentUs - previous.sentUs)) / 1000 + VICTIM_CHUNK_MS];
    });
    const latencies = deltas.flatMap((d) =>
      d.sentUs === undefined ? [] : [(d.recvUs - d.sentUs) / 1000]
    );
    facts.pings = stats;
    facts.victim = {
      streamed: firstDelta,
      completed: victimResult.completed,
      deltas: deltas.length,
      stamped: latencies.length,
      maxGapMs: round(Math.max(0, ...correctedGaps), 1),
      rawMaxGapMs: round(Math.max(0, ...rawGaps), 1),
      medianRawGapMs: round(rawGaps.length ? median(rawGaps) : 0, 1),
      maxDeliveryLatencyMs: round(Math.max(0, ...latencies), 1),
      medianDeliveryLatencyMs: round(latencies.length ? median(latencies) : 0, 1),
    };
    facts.recalls = recalls.map((t) => ({
      logical: t.logicalSessionId,
      completed: t.completed,
      ms: t.ms,
      reply: t.reply,
    }));
    facts.hwmMb = round(
      Number(readFileSync(`/proc/${host.pid}/status`, 'utf8').match(/^VmHWM:\s+(\d+)/m)?.[1]) / 1024
    );
    for (const item of [...long, { ch: victim.ch }]) {
      await host.client
        .request(item.ch, 'worker.dispose', { reason: 'slot-dispose' })
        .catch(() => undefined);
    }
  } catch (error) {
    facts.error = error instanceof Error ? error.message : String(error);
    facts.stderrTail = host.stderr().slice(-2000);
  } finally {
    facts.stop = await stopHost(host);
  }
  return facts;
}

// ---- gates -------------------------------------------------------------------------

interface GateResult {
  hard: Record<string, boolean>;
  softWarnings: string[];
  numbers: Record<string, number[]>;
}

function judge(scenario: Scenario, results: Message[]): GateResult {
  const gates = GATES[scenario];
  const pings = results.map((r) => (r.pings ?? {}) as PingStats);
  const eld = pings.map((p) => p.eldMaxMs);
  const rss = pings.map((p) => p.rssMaxMb);
  const hard: Record<string, boolean> = {
    [`${scenario} ELD <= ${gates.hard.eldMs} ms`]: eld.every((v) => v <= gates.hard.eldMs),
    [`${scenario} RSS <= ${gates.hard.rssMb} MB`]: rss.every((v) => v <= gates.hard.rssMb),
  };
  const numbers: Record<string, number[]> = { eldMaxMs: eld, rssMaxMb: rss };
  if (scenario === 'LC-1') {
    const turns = results.flatMap((r) => (r.turns ?? []) as Message[]);
    hard['LC-1 8 x 200 deltas, each on its own channel'] =
      results.every((r) => ((r.turns ?? []) as Message[]).length === 8) &&
      turns.every((t) => t.stamps === 200 && t.foreignEvents === 0);
    hard['LC-1 all turns completed'] = turns.every((t) => t.completed === true);
  }
  if (scenario === 'LC-2') {
    const lc2Gates = GATES['LC-2'].hard;
    hard['LC-2 no host error'] = results.every((r) => r.error === undefined);
    hard['LC-2 victim deltas stamped'] = results.every(
      (r) => Number((r.victim as Message | undefined)?.stamped ?? 0) >= 60
    );
    hard['LC-2 5 turns completed'] = results.every(
      (r) =>
        ((r.recalls ?? []) as Message[]).filter((t) => t.completed === true).length === 4 &&
        (r.victim as Message | undefined)?.completed === true
    );
    const gaps = results.map((r) =>
      Number((r.victim as Message | undefined)?.maxGapMs ?? Infinity)
    );
    numbers.victimMaxGapMs = gaps;
    hard[`LC-2 victim gap <= ELD + ${lc2Gates.victimGapOverEldMs} ms`] = results.every(
      (_r, i) => (gaps[i] ?? Infinity) <= (eld[i] ?? 0) + lc2Gates.victimGapOverEldMs
    );
    hard['LC-2 every ping answered'] = pings.every((p) => p.unanswered === 0 && p.answered > 0);
    numbers.maxPongRttMs = pings.map((p) => p.maxRttMs);
    hard[`LC-2 no pong slower than ${lc2Gates.pongRttMs} ms`] = pings.every(
      (p) => p.maxRttMs <= lc2Gates.pongRttMs
    );
  }
  const softWarnings: string[] = [];
  if (median(eld) > gates.soft.eldMs)
    softWarnings.push(`${scenario} ELD median ${median(eld)} ms > soft ${gates.soft.eldMs} ms`);
  if (median(rss) > gates.soft.rssMb)
    softWarnings.push(`${scenario} RSS median ${median(rss)} MB > soft ${gates.soft.rssMb} MB`);
  return { hard, softWarnings, numbers };
}

// ---- main --------------------------------------------------------------------------

async function main(): Promise<number> {
  const want = (scenario: Scenario) => !only || only === scenario;
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const gatewayRoot = join(scratchRoot, 'gateway');
  mkdirSync(gatewayRoot, { recursive: true });
  const report: Message = {
    node: nodeBin,
    runs,
    turnsPerSession,
    pingMs: PING_MS,
    gates: GATES,
    startedAt: new Date().toISOString(),
  };
  const gateway = await startGateway(gatewayRoot);
  const results: Record<Scenario, Message[]> = { 'LC-0': [], 'LC-1': [], 'LC-2': [] };
  try {
    let stubs: string[] = [];
    let seedBox: Sandbox | undefined;
    if (want('LC-2')) {
      report.seedMachine = await settleMachine('seed');
      seedBox = sandbox(scratchRoot, 'lc2-seed');
      installProbeBundle(seedBox.dshHome);
      const seeded = await seedLongSessions(seedBox, gateway.port, 4);
      report.e7Seed = seeded.facts;
      stubs = seeded.stubs;
      log(`seeded 4 x ${turnsPerSession * 4} messages: ${JSON.stringify(seeded.facts)}`);
    }
    for (let run = 1; run <= runs; run += 1) {
      if (want('LC-0') || want('LC-1')) {
        const machine = await settleMachine(`run ${run} LC-0/1`);
        // The product composition alone: LC-0 / LC-1 need no probe row.
        const box = sandbox(scratchRoot, `lc01-r${run}`);
        const files = seedWorkspace(box.workspace, 8);
        const host = await startHost(`lc01-r${run}`, box, gateway.port);
        try {
          if (want('LC-0')) {
            results['LC-0'].push({ run, machine, ...(await lc0(host)) });
            log(`run ${run} LC-0 ${JSON.stringify(results['LC-0'].at(-1)?.pings)}`);
          }
          if (want('LC-1')) {
            results['LC-1'].push({ run, machine, ...(await lc1(host, box, files, run)) });
            log(`run ${run} LC-1 ${JSON.stringify(results['LC-1'].at(-1)?.pings)}`);
          }
        } catch (error) {
          report[`error-r${run}`] = error instanceof Error ? error.message : String(error);
          report[`stderr-r${run}`] = host.stderr().slice(-2000);
        } finally {
          await stopHost(host);
        }
      }
      if (want('LC-2') && seedBox) {
        const machine = await settleMachine(`run ${run} LC-2`);
        const facts = await lc2(seedBox, gateway.port, stubs, run);
        results['LC-2'].push({ run, machine, ...facts });
        log(`run ${run} LC-2 ${JSON.stringify({ pings: facts.pings, victim: facts.victim })}`);
      }
    }
  } finally {
    gateway.child.kill('SIGTERM');
  }
  report.results = results;
  const verdict: Message = {};
  const hardFailures: string[] = [];
  const softWarnings: string[] = [];
  for (const scenario of Object.keys(results) as Scenario[]) {
    if (results[scenario].length === 0) continue;
    const judged = judge(scenario, results[scenario]);
    verdict[scenario] = judged;
    for (const [gate, ok] of Object.entries(judged.hard)) if (!ok) hardFailures.push(gate);
    softWarnings.push(...judged.softWarnings);
  }
  report.verdict = verdict;
  report.hardFailures = hardFailures;
  report.softWarnings = softWarnings;
  const json = `${JSON.stringify(report, null, 2)}\n`.split(scratchRoot).join('<scratch>');
  if (outFile) writeFileSync(outFile, json);
  process.stdout.write(json);
  log(hardFailures.length ? `HARD GATES FAILED: ${hardFailures.join('; ')}` : 'hard gates passed');
  for (const warning of softWarnings) log(`soft: ${warning}`);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
  else log(`kept ${scratchRoot}`);
  const errors = Object.keys(report).filter((key) => key.startsWith('error-'));
  return hardFailures.length === 0 && errors.length === 0 ? 0 : 1;
}

process.exitCode = await main();
