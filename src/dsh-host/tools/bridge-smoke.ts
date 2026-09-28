/**
 * Headless bridge smoke: the DSH host driven the way Main's DshHostSupervisor
 * and its WorkerSlots drive it (Node IPC, one channel envelope per session
 * around our worker RPC, src/shared/types/dshHostProtocol.ts), with no Electron.
 *
 *   (cd src/dsh-host && ../../out-node-runtime/node tools/bridge-smoke.ts [--keep] [--out file.json]
 *      [--systemd-scope])
 *
 * Every model reply comes from the local fake gateway (plan dsh-p0-2). Hosts,
 * in order — at most two alive at once:
 *
 *   A  new session S1 on channel 1, bootstrapped before the host reports ready
 *      (the host buffers it). Before any turn: the DSH log and the identity
 *      stub are both on disk (P1-1, decision 007). The shared-host protocol
 *      (P1-3a): ready over IPC with the host's own pid; a request for a channel
 *      the host never opened is answered WORKER_CHANNEL_UNKNOWN; ping answers
 *      pong; closing an unknown channel answers closed. Then the P0-3 turns:
 *        STREAM         paced text in 20 deltas
 *        TOOL           one bash call, then text
 *        APPROVE-ALLOW  write outside the workspace -> sandbox denial ->
 *                       escalation -> permission.requested -> allow
 *        APPROVE-DENY   the same, answered deny
 *      two P1-3a experiments, ENV (no .env file reaches a tool, decision 023)
 *      and FDS (the descriptors a tool inherits, decision 034's precondition),
 *      then worker.dispose right after the last turn (ACK, then closed; the
 *      host lives on), and shutdown (stopped, exit 0).
 *   B  new session S2, SIGKILLed right after bootstrap: a header-only log whose
 *      writer died holding the lock — the crash decision 007 exists for.
 *   C  resumes S2 from its stub: a header-only session reopens, the first page
 *      is a legal empty `initialHistory`, and a STREAM turn runs on it.
 *   D  while C holds S2: resuming it again answers `session_locked`.
 *      C is then SIGKILLed mid-session.
 *   E  resumes S2 after that SIGKILL and recalls C's turn; meanwhile a second
 *      channel on the same host creates S3, and both stream at once without
 *      either channel seeing the other's events. Its first page
 *      (`initialHistory`, P1-4a) is the history C answered before it died.
 *      Before it opens S2, Main's preview reads S2 cold (`readPage`, decision
 *      030): the page the resume then answers, and not a byte or an mtime of
 *      the log changed; a stub for another session and a missing stub are
 *      refused. With S2 open, the preview reads the live session: the page
 *      `worker.history` answers.
 *   F  resumes S1 in yet another host and recalls A's turns; its first page is
 *      the history A answered before it shut down, and the page a cold
 *      `readPage` gave just before, again without touching the log.
 *   G  asks to CREATE S2 again, as a retry does when an earlier create reached
 *      the disk but never became Main's identity: the bridge reopens the log
 *      with the deterministic id instead of failing on it, and recalls C's turn.
 *
 * Prints the RuntimeEvent sequence per turn, per-host facts, the experiments
 * and a verdict. Signals only ever go to a ChildProcess this script spawned.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { HostClient, type Message } from './lib/hostClient.ts';
import {
  baseEnv,
  captureStderr,
  exitOf,
  sandbox,
  sleep,
  stopWithin,
  waitQuiet,
} from './lib/kit.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const hostEntry = join(hostDir, 'host.ts');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const bundledNode = join(repoRoot, 'out-node-runtime', 'node');
const nodeBin = existsSync(bundledNode) ? bundledNode : process.execPath;
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const outIndex = argv.indexOf('--out');
const outFile = outIndex >= 0 ? argv[outIndex + 1] : '';
// --systemd-scope hands the host the two variables Main's environment carries
// (decision 022), so tools launch through DSH's systemd scope path.
const systemdScope = argv.includes('--systemd-scope');
const scratchRoot = join('/var/tmp', `aiclient-dsh-p1-3a-smoke-${Date.now()}`);
const GENERATION = 1;
const SESSION = 'bridge-smoke';
const EMPTY_SESSION = 'bridge-smoke-empty';
const SIDE_SESSION = 'bridge-smoke-side';
const CHANNEL_UNKNOWN = 'WORKER_CHANNEL_UNKNOWN';

async function startGateway(root: string) {
  const child = spawn(
    nodeBin,
    [gatewayEntry, '--port', '0', '--plan', 'dsh-p0-2', '--reset'].concat([
      '--state',
      join(root, 'gateway.state.json'),
      '--log',
      join(root, 'gateway.jsonl'),
      '--model-id',
      'fake-1',
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
  return { child, port };
}

const payloadOf = (event: Message) => (event.payload ?? {}) as Message;
const summarize = (events: Message[]) =>
  events.map((event) => {
    const p = payloadOf(event);
    const detail =
      event.type === 'message.delta'
        ? JSON.stringify(String(p.text)).slice(0, 40)
        : event.type === 'session.status'
          ? String(p.status)
          : event.type === 'tool.started' || event.type === 'permission.requested'
            ? String(p.name ?? p.toolName)
            : event.type === 'tool.completed'
              ? `ok=${String(p.ok)}`
              : event.type === 'permission.resolved'
                ? `${String(p.decision)}`
                : event.type === 'message.started'
                  ? String(p.role)
                  : '';
    return detail ? `${String(event.type)} ${detail}` : String(event.type);
  });

/** Text the assistant streamed in these events. */
function assistantText(events: Message[]): string {
  const assistant = new Set(
    events
      .filter((e) => e.type === 'message.started' && payloadOf(e).role === 'assistant')
      .map((e) => payloadOf(e).messageId)
  );
  return events
    .filter((e) => e.type === 'message.delta' && assistant.has(payloadOf(e).messageId))
    .map((e) => String(payloadOf(e).text))
    .join('');
}

interface Host {
  label: string;
  child: ChildProcess;
  client: HostClient;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
  startedAt: number;
}

/**
 * What a session looks like on disk: the stub Main commits, and the DSH log
 * directory under `$DSH_HOME/sessions/--<cwd>--/<id>/`.
 */
function diskFacts(dshHome: string, dshSessionId: string, stubFile: string | undefined) {
  const sessionsRoot = join(dshHome, 'sessions');
  const logDirs: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name.includes(dshSessionId)) logDirs.push(full);
      else walk(full, depth + 1);
    }
  };
  walk(sessionsRoot, 0);
  const logFiles = logDirs.flatMap((dir) =>
    readdirSync(dir).map((name) => {
      const file = join(dir, name);
      const stat = statSync(file);
      return { file: relative(dshHome, file), bytes: stat.size, mtimeMs: stat.mtimeMs };
    })
  );
  const log = logFiles.find((f) => /^session\.v\d+\.jsonl/.test(f.file.split('/').pop() ?? ''));
  let stub: Message | undefined;
  let stubMtimeMs: number | undefined;
  if (stubFile && existsSync(stubFile)) {
    stub = JSON.parse(readFileSync(stubFile, 'utf8')) as Message;
    stubMtimeMs = statSync(stubFile).mtimeMs;
  }
  return { logFiles, log, stub, stubMtimeMs };
}

/** The target of one of a live process's descriptors (Linux), e.g. `socket:[123]`. */
function fdTarget(pid: number | undefined, fd: number): string | null {
  try {
    return readlinkSync(`/proc/${String(pid)}/fd/${fd}`);
  } catch {
    return null;
  }
}

async function main() {
  await waitQuiet();
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const box = sandbox(scratchRoot, 'run');
  const outside = join(box.root, 'outside');
  mkdirSync(outside, { recursive: true, mode: 0o700 });
  // The host's launch directory is private and empty, as Main makes it (decision 023).
  const hostCwd = join(box.root, 'host-cwd');
  mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
  // Decision 023: neither of these may ever reach a tool.
  writeFileSync(join(hostCwd, '.env'), 'P0_HOSTCWD_CANARY=leaked-from-host-cwd\n');
  writeFileSync(join(box.dshHome, '.env'), 'P0_DSHHOME_CANARY=leaked-from-dsh-home\n');
  const gateway = await startGateway(box.root);
  const env = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AICLIENT_DSH_GATEWAY_URL: `http://127.0.0.1:${gateway.port}`,
    AICLIENT_DSH_GATEWAY_KEY: 'p1-1-fake-key',
    ...(systemdScope
      ? Object.fromEntries(
          ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
            .filter((name) => process.env[name] !== undefined)
            .map((name) => [name, process.env[name] as string])
        )
      : {}),
  };
  const report: Record<string, unknown> = { node: nodeBin, scratch: '<scratch>' };
  const turns: Record<string, unknown> = {};
  const hosts: Record<string, Message> = {};
  const protocol: Record<string, unknown> = {};
  const experiments: Record<string, unknown> = {};
  /** P1-4a (decision 030): what the host's read-only page answered, and the disk around it. */
  const readPages: Record<string, unknown> = {};
  /** The session's log directory and stub, byte for byte and mtime for mtime. */
  const untouched = (dshSessionId: string, stubFile: string | undefined) => {
    const disk = diskFacts(box.dshHome, dshSessionId, stubFile);
    return JSON.stringify({ log: disk.logFiles, stub: disk.stub, stubMtimeMs: disk.stubMtimeMs });
  };
  const live: Host[] = [];

  const startHost = (label: string): Host => {
    const child = spawn(nodeBin, ['--expose-internals', hostEntry], {
      cwd: hostCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const host = {
      label,
      child,
      client: new HostClient(child),
      stderr: captureStderr(child),
      exited: exitOf(child),
      startedAt: performance.now(),
    };
    live.push(host);
    return host;
  };
  const ready = async (host: Host) => {
    const message = await host.client.control(
      (m) => m.type === 'ready' || m.type === 'fatal',
      180_000
    );
    hosts[host.label] = {
      ...(hosts[host.label] ?? {}),
      pid: host.child.pid,
      readyMs: Math.round(performance.now() - host.startedAt),
      ready: message ? { type: message.type, pid: message.pid, message: message.message } : null,
    };
    if (message?.type !== 'ready')
      throw new Error(`${host.label}: no ready (${JSON.stringify(message)})`);
    return message;
  };
  const bootstrap = async (host: Host, ch: string, payload: Message) => {
    const response = await host.client.call(ch, 'worker.bootstrap', payload);
    hosts[host.label] = {
      ...(hosts[host.label] ?? {}),
      pid: host.child.pid,
      bootstrapMs: Math.round(performance.now() - host.startedAt),
      bootstrap: response.ok ? response.result : { error: response.error },
    };
    return response;
  };
  /** worker.dispose on one channel: its ACK, then `closed`; the host lives on. */
  const closeSession = async (host: Host, ch: string) => {
    const disposed = await host.client.request(ch, 'worker.dispose', { reason: 'slot-dispose' });
    const closed = await host.client.control((m) => m.host === 'closed' && m.ch === ch, 10_000);
    const order = host.client.arrivals.filter((item) => item.ch === ch).map((item) => item.what);
    return { disposed, closed: closed !== undefined, order };
  };
  /** Host-wide shutdown: `stopped`, then a clean exit. */
  const stopHost = async (host: Host) => {
    host.client.send({ type: 'shutdown' });
    const stopped = await host.client.control((m) => m.type === 'stopped', 15_000);
    const graceful = await stopWithin(host.exited, 15_000);
    hosts[host.label] = {
      ...hosts[host.label],
      stopped: stopped !== undefined,
      graceful,
      exit: await host.exited,
    };
  };
  const kill = async (host: Host) => {
    if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
    hosts[host.label] = { ...hosts[host.label], killed: true, exit: await host.exited };
  };
  const runTurn = async (
    host: Host,
    ch: string,
    logicalSessionId: string,
    label: string,
    text: string,
    onPermission?: 'allow' | 'deny'
  ) => {
    const { client } = host;
    const requestId = `turn-${label}`;
    const from = client.events(ch).length;
    await client.request(ch, 'worker.send', {
      logicalSessionId,
      requestId,
      attemptId: `attempt-${label}`,
      text,
    });
    if (onPermission) {
      const asked = await client.until(
        ch,
        (events) => events.slice(from).some((e) => e.type === 'permission.requested'),
        60_000
      );
      const request = client
        .events(ch)
        .slice(from)
        .find((e) => e.type === 'permission.requested');
      if (asked && request) {
        await client.request(ch, 'worker.permission.respond', {
          logicalSessionId,
          permissionId: payloadOf(request).permissionId,
          decision: onPermission,
        });
      }
    }
    const idle = await client.until(
      ch,
      (events) =>
        events
          .slice(from)
          .some(
            (e) =>
              e.type === 'session.status' &&
              payloadOf(e).status === 'idle' &&
              e.requestId === requestId
          ),
      90_000
    );
    const events = client.events(ch).slice(from);
    const deltas = events.filter((e) => e.type === 'message.delta');
    const turn = {
      idle,
      completed: events.some((e) => e.type === 'session.completed'),
      sequence: summarize(events),
      assistantDeltas: deltas.length - 1,
      reply: assistantText(events).slice(0, 200),
      permission: events.find((e) => e.type === 'permission.requested')?.payload,
      tools: events.filter((e) => e.type === 'tool.completed').map((e) => payloadOf(e)),
      sessionIds: [...new Set(events.map((e) => e.sessionId))],
    };
    turns[label] = turn;
    return turn;
  };
  const toolOutput = (label: string) =>
    ((turns[label] as { tools?: Message[] } | undefined)?.tools ?? [])
      .map((tool) => String(tool.output ?? tool.error ?? ''))
      .join('\n');

  const facts: Record<string, ReturnType<typeof diskFacts>> = {};
  let stubS1: string | undefined;
  let stubS2: string | undefined;
  let resumedS2: Message | undefined;
  /** E's own bootstrap: the side session's bootstrap on the same host overwrites `hosts.E`. */
  let resumedAfterKill: Message | undefined;
  let lockedCode: unknown;
  try {
    // ---- A: new session, persisted before its first turn, then the P0-3 turns
    const a = startHost('A');
    const chA = a.client.openChannel();
    // Sent at once, before ready: the host must buffer it until the bridge row is up.
    const bootingA = bootstrap(a, chA, { logicalSessionId: SESSION, cwd: box.workspace });
    const readyA = await ready(a);
    const bootA = await bootingA;
    if (!bootA.ok) throw new Error(`A bootstrap: ${JSON.stringify(bootA.error)}`);
    report.bootstrapMs = hosts.A.bootstrapMs;
    report.bootstrap = bootA.result;
    protocol.readyPid = { reported: readyA.pid, spawned: a.child.pid };
    protocol.readySkippedPlugins = readyA.skippedPlugins;
    stubS1 = String((bootA.result as Message).sessionFile);
    facts.newBeforeFirstTurn = diskFacts(box.dshHome, `aiclient-${SESSION}`, stubS1);
    report.commands = await a.client.request(chA, 'worker.commands', { logicalSessionId: SESSION });

    // The shared-host protocol around the channel (P1-3a).
    const unknown = await a.client.call('c1-99', 'worker.history', { logicalSessionId: SESSION });
    protocol.unknownChannel = {
      ok: unknown.ok,
      code: (unknown.error as Message | undefined)?.code,
      generation: unknown.generation,
      requestId: unknown.requestId,
    };
    a.client.send({ host: 'ping', id: 7 });
    const pong = await a.client.control((m) => m.host === 'pong' && m.id === 7, 10_000);
    protocol.pong = pong;
    a.client.send({ host: 'close', ch: 'c1-98' });
    protocol.closeUnknown =
      (await a.client.control((m) => m.host === 'closed' && m.ch === 'c1-98', 10_000)) !==
      undefined;

    await runTurn(a, chA, SESSION, 'STREAM', 'P0-STREAM: stream a paragraph back to me.');
    await runTurn(a, chA, SESSION, 'TOOL', 'P0-TOOL: list the workspace.');
    const allowTarget = join(outside, 'allowed.txt');
    await runTurn(
      a,
      chA,
      SESSION,
      'APPROVE-ALLOW',
      `P0-APPROVAL: write outside, path=${allowTarget}`,
      'allow'
    );
    const denyTarget = join(outside, 'denied.txt');
    await runTurn(
      a,
      chA,
      SESSION,
      'APPROVE-DENY',
      `P0-APPROVAL: write outside, path=${denyTarget}`,
      'deny'
    );
    report.files = { allowed: existsSync(allowTarget), denied: existsSync(denyTarget) };
    report.history = await a.client.request(chA, 'worker.history', { logicalSessionId: SESSION });

    // Experiment (decision 023): no .env file reaches a tool.
    await runTurn(a, chA, SESSION, 'ENV', 'P0-ENV: print the env canaries.');
    const envLine = toolOutput('ENV').split('\n')[0] ?? '';
    experiments.dotEnv = {
      line: envLine.slice(0, 200),
      warned: (a.stderr().match(/\.env is ignored/g) ?? []).length,
    };
    // Experiment (decision 034's precondition): does a tool inherit the host's
    // IPC channel, inside the sandbox and once escalated out of it?
    const hostChannelFd = fdTarget(a.child.pid, 3);
    await runTurn(a, chA, SESSION, 'FDS', 'P0-FDS: list the inherited descriptors.', 'allow');
    const fdsRuns = ((turns.FDS as { tools?: Message[] } | undefined)?.tools ?? []).map((item) =>
      String(item.output ?? item.error ?? '')
    );
    const fdsView = (output: string | undefined) => ({
      lines: (output ?? '')
        .split('\n')
        .filter((line) => /^fd \d+ -> /.test(line) || line.startsWith('pid='))
        .slice(0, 24),
      inherited: hostChannelFd !== null && (output ?? '').includes(hostChannelFd),
      channelVariable: /channel_fd=(?!unset)/.test(output ?? ''),
    });
    experiments.ipcHandle = {
      systemdScope,
      hostFd3: hostChannelFd,
      sandboxed: fdsView(fdsRuns[0]),
      escalated: fdsView(fdsRuns[1]),
    };

    // P1-4a: what F's first page must repeat after the host restarts.
    report.historyBeforeClose = await a.client.request(chA, 'worker.history', {
      logicalSessionId: SESSION,
    });
    // Dispose right after the turn ended (P1-1 left a projection-cache warning
    // here); the shared host lives on, so a late flush would surface now.
    const closedA = await closeSession(a, chA);
    report.dispose = closedA.disposed;
    protocol.disposeCloses = closedA;
    await sleep(1500);
    a.client.send({ host: 'ping', id: 8 });
    protocol.pongAfterClose = await a.client.control(
      (m) => m.host === 'pong' && m.id === 8,
      10_000
    );
    experiments.projectionCacheAfterDispose = a
      .stderr()
      .split('\n')
      .filter((line) => /projection cache|closed handle/i.test(line))
      .slice(0, 6);
    await stopHost(a);
    report.graceful = hosts.A.graceful;

    // ---- B: new session S2, killed before any turn (header-only log, lock held)
    const b = startHost('B');
    await ready(b);
    const chB = b.client.openChannel();
    const bootB = await bootstrap(b, chB, { logicalSessionId: EMPTY_SESSION, cwd: box.workspace });
    if (!bootB.ok) throw new Error(`B bootstrap: ${JSON.stringify(bootB.error)}`);
    stubS2 = String((bootB.result as Message).sessionFile);
    facts.headerOnly = diskFacts(box.dshHome, `aiclient-${EMPTY_SESSION}`, stubS2);
    await kill(b);

    // ---- C: resume the header-only session from its stub and run a turn
    const c = startHost('C');
    await ready(c);
    const chC = c.client.openChannel();
    const bootC = await bootstrap(c, chC, {
      logicalSessionId: EMPTY_SESSION,
      cwd: box.workspace,
      sessionFile: stubS2,
    });
    if (!bootC.ok) throw new Error(`C bootstrap: ${JSON.stringify(bootC.error)}`);
    resumedS2 = bootC.result as Message;
    await runTurn(
      c,
      chC,
      EMPTY_SESSION,
      'RESUMED-STREAM',
      'P0-STREAM: stream a paragraph back to me.'
    );

    // ---- D: a second host cannot open a session C holds
    const d = startHost('D');
    await ready(d);
    const chD = d.client.openChannel();
    const bootD = await bootstrap(d, chD, {
      logicalSessionId: EMPTY_SESSION,
      cwd: box.workspace,
      sessionFile: stubS2,
      // Ignored by the bridge: the DSH write lock is a kernel lock.
      forceTakeover: true,
    });
    lockedCode = bootD.ok ? 'opened' : (bootD.error as Message | undefined)?.code;
    await closeSession(d, chD);
    await stopHost(d);

    // ---- C dies mid-session; E reopens S2 and recalls C's turn
    // P1-4a: what E's first page must repeat after the crash restart.
    report.historyBeforeKill = await c.client.request(chC, 'worker.history', {
      logicalSessionId: EMPTY_SESSION,
    });
    await kill(c);
    facts.afterKill = diskFacts(box.dshHome, `aiclient-${EMPTY_SESSION}`, stubS2);
    const e = startHost('E');
    await ready(e);
    // P1-4a (decision 030): Main's preview of S2, cold, before anything opens it.
    const diskBeforeRead = untouched(`aiclient-${EMPTY_SESSION}`, stubS2);
    readPages.coldAfterKill = await e.client.readPage({
      stubFile: String(stubS2),
      logicalSessionId: EMPTY_SESSION,
    });
    readPages.coldAfterKillWroteNothing =
      untouched(`aiclient-${EMPTY_SESSION}`, stubS2) === diskBeforeRead;
    readPages.foreignStub = await e.client.readPage({
      stubFile: String(stubS2),
      logicalSessionId: SESSION,
    });
    readPages.missingStub = await e.client.readPage({
      stubFile: join(box.dshHome, 'aiclient-sessions', 'aiclient-bridge-smoke-none.dsh.json'),
      logicalSessionId: 'bridge-smoke-none',
    });
    const chE = e.client.openChannel();
    const bootE = await bootstrap(e, chE, {
      logicalSessionId: EMPTY_SESSION,
      cwd: box.workspace,
      sessionFile: stubS2,
    });
    if (!bootE.ok) throw new Error(`E bootstrap: ${JSON.stringify(bootE.error)}`);
    resumedAfterKill = bootE.result as Message;
    // A second session on the same host, streaming beside the recall.
    const chSide = e.client.openChannel();
    const bootSide = await bootstrap(e, chSide, {
      logicalSessionId: SIDE_SESSION,
      cwd: box.workspace,
    });
    if (!bootSide.ok) throw new Error(`E side bootstrap: ${JSON.stringify(bootSide.error)}`);
    await Promise.all([
      runTurn(e, chE, EMPTY_SESSION, 'RECALL-AFTER-KILL', 'P0-RECALL {"markers":["P0-STREAM"]}'),
      runTurn(e, chSide, SIDE_SESSION, 'SIDE-STREAM', 'P0-STREAM: stream a paragraph back to me.'),
    ]);
    protocol.twoChannels = {
      mainSessions: [...new Set(e.client.events(chE).map((event) => event.sessionId))],
      sideSessions: [...new Set(e.client.events(chSide).map((event) => event.sessionId))],
    };
    // With S2 open on this host, the preview reads the live session.
    readPages.live = await e.client.readPage({
      stubFile: String(stubS2),
      logicalSessionId: EMPTY_SESSION,
    });
    readPages.liveHistory = await e.client.request(chE, 'worker.history', {
      logicalSessionId: EMPTY_SESSION,
    });
    await closeSession(e, chE);
    await closeSession(e, chSide);
    await stopHost(e);

    // ---- F: S1 in yet another host, with A's turns in context
    const f = startHost('F');
    await ready(f);
    const diskBeforeReadF = untouched(`aiclient-${SESSION}`, stubS1);
    readPages.coldOtherHost = await f.client.readPage({
      stubFile: String(stubS1),
      logicalSessionId: SESSION,
    });
    readPages.coldOtherHostWroteNothing =
      untouched(`aiclient-${SESSION}`, stubS1) === diskBeforeReadF;
    const chF = f.client.openChannel();
    const bootF = await bootstrap(f, chF, {
      logicalSessionId: SESSION,
      cwd: box.workspace,
      sessionFile: stubS1,
    });
    if (!bootF.ok) throw new Error(`F bootstrap: ${JSON.stringify(bootF.error)}`);
    await runTurn(
      f,
      chF,
      SESSION,
      'RECALL-OTHER-HOST',
      'P0-RECALL {"markers":["P0-STREAM","P0-TOOL"]}'
    );
    await closeSession(f, chF);
    await stopHost(f);

    // ---- G: a create for a logical session whose DSH log already exists
    const g = startHost('G');
    await ready(g);
    const chG = g.client.openChannel();
    const bootG = await bootstrap(g, chG, { logicalSessionId: EMPTY_SESSION, cwd: box.workspace });
    if (!bootG.ok) throw new Error(`G bootstrap: ${JSON.stringify(bootG.error)}`);
    facts.recreated = diskFacts(box.dshHome, `aiclient-${EMPTY_SESSION}`, stubS2);
    await runTurn(g, chG, EMPTY_SESSION, 'RECALL-RECREATED', 'P0-RECALL {"markers":["P0-STREAM"]}');
    await closeSession(g, chG);
    await stopHost(g);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    for (const host of live) {
      if (host.child.exitCode === null && host.child.signalCode === null)
        host.child.kill('SIGKILL');
    }
    for (const host of live) {
      hosts[host.label] = { ...hosts[host.label], exit: await host.exited };
    }
    gateway.child.kill('SIGTERM');
  }
  report.exit = hosts.A?.exit;
  report.turns = turns;
  report.hosts = hosts;
  report.disk = facts;
  report.protocol = protocol;
  report.experiments = experiments;
  report.readPages = readPages;

  const stream = turns.STREAM as { assistantDeltas?: number } | undefined;
  const tool = turns.TOOL as { tools?: Message[] } | undefined;
  const allow = turns['APPROVE-ALLOW'] as { permission?: Message; tools?: Message[] } | undefined;
  const deny = turns['APPROVE-DENY'] as { permission?: Message; tools?: Message[] } | undefined;
  const files = report.files as { allowed?: boolean; denied?: boolean } | undefined;
  type Turn = { idle?: boolean; completed?: boolean; reply?: string };
  const resumedTurn = turns['RESUMED-STREAM'] as Turn | undefined;
  const recallKill = turns['RECALL-AFTER-KILL'] as Turn | undefined;
  const recallOther = turns['RECALL-OTHER-HOST'] as Turn | undefined;
  const sideTurn = turns['SIDE-STREAM'] as (Turn & { assistantDeltas?: number }) | undefined;
  const history = resumedS2?.initialHistory as
    | { logicalSessionId?: string; sessionFile?: string; workspacePath?: string; page?: Message }
    | undefined;
  const fresh = facts.newBeforeFirstTurn;
  const stub = fresh?.stub;
  const exitOfHost = (label: string) =>
    (hosts[label]?.exit ?? {}) as { code?: number | null; signal?: string | null };
  const readyPid = protocol.readyPid as { reported?: unknown; spawned?: unknown } | undefined;
  const unknownChannel = protocol.unknownChannel as Message | undefined;
  const pong = protocol.pong as Message | undefined;
  const pongAfterClose = protocol.pongAfterClose as Message | undefined;
  const disposeCloses = protocol.disposeCloses as
    | { closed?: boolean; order?: string[] }
    | undefined;
  const twoChannels = protocol.twoChannels as
    | { mainSessions?: unknown[]; sideSessions?: unknown[] }
    | undefined;
  const dotEnv = experiments.dotEnv as { line?: string } | undefined;
  /** A reopened session's first page is non-empty and repeats what the session answered before. */
  const samePage = (reopened: unknown, before: unknown) => {
    const page = (reopened as { page?: { messages?: unknown[] } } | undefined)?.page;
    const earlier = (before as { page?: unknown } | undefined)?.page;
    return (
      Array.isArray(page?.messages) &&
      page.messages.length > 0 &&
      earlier !== undefined &&
      JSON.stringify(page) === JSON.stringify(earlier)
    );
  };
  report.verdict = {
    // P0-3, unchanged
    streamedInManyDeltas: (stream?.assistantDeltas ?? 0) >= 10,
    toolRowSettled: tool?.tools?.some((t) => t.ok === true) ?? false,
    approvalCardShown: Boolean(allow?.permission) && Boolean(deny?.permission),
    allowWrote: files?.allowed === true,
    denyDidNotWrite: files?.denied === false,
    exitedCleanly: exitOfHost('A').code === 0,
    // P1-1: new session is on disk before its first turn (decision 007)
    persistedBeforeFirstTurn:
      (fresh?.log?.bytes ?? 0) > 0 &&
      stub?.engine === 'dsh' &&
      stub?.version === 1 &&
      stub?.dshSessionId === `aiclient-${SESSION}` &&
      stub?.logicalSessionId === SESSION &&
      stub?.cwd === box.workspace &&
      typeof stub?.createdAt === 'number',
    stubNotOlderThanLog:
      fresh?.stubMtimeMs !== undefined &&
      fresh?.log !== undefined &&
      fresh.stubMtimeMs >= fresh.log.mtimeMs,
    // P1-1: a header-only session whose writer was SIGKILLed reopens (inferences in §9)
    headerOnlyKilledHost:
      (facts.headerOnly?.log?.bytes ?? 0) > 0 && exitOfHost('B').signal === 'SIGKILL',
    headerOnlyResumed:
      resumedS2?.sessionFile === stubS2 &&
      history?.logicalSessionId === EMPTY_SESSION &&
      history?.sessionFile === stubS2 &&
      history?.workspacePath === box.workspace &&
      history?.page?.offset === 0 &&
      history?.page?.limit === 80 &&
      Array.isArray(history?.page?.messages) &&
      (history?.page?.messages as unknown[]).length === 0,
    resumedTurnCompleted: resumedTurn?.idle === true && resumedTurn?.completed === true,
    // P1-1: DSH's kernel lock reaches Main as session_locked, forceTakeover or not
    lockedWhileOwned: lockedCode === 'session_locked',
    exitedCleanlyAfterLockRefusal: exitOfHost('D').code === 0,
    // P1-1: SIGKILL mid-session, then another host resumes with the turn in context
    resumedAfterSigkill:
      exitOfHost('C').signal === 'SIGKILL' &&
      (hosts.E?.bootstrap as Message | undefined)?.bootstrapped === true,
    recalledAfterSigkill: recallKill?.reply?.includes('present=P0-STREAM missing=-') === true,
    // P1-1: resume from the stub in another host, earlier turns in context
    resumedInOtherHostRecalled:
      recallOther?.reply?.includes('present=P0-STREAM,P0-TOOL missing=-') === true,
    exitedCleanlyAfterResume: exitOfHost('E').code === 0 && exitOfHost('F').code === 0,
    // P1-4a: the first page after a restart is the projected log, the same as before it
    initialHistoryMatchesBeforeResume: samePage(
      (hosts.F?.bootstrap as Message | undefined)?.initialHistory,
      report.historyBeforeClose
    ),
    initialHistoryMatchesBeforeCrash: samePage(
      resumedAfterKill?.initialHistory,
      report.historyBeforeKill
    ),
    // P1-4a (decision 030): Main's preview, read by the host without opening the session
    readPageColdMatchesResume:
      (readPages.coldAfterKill as Message | undefined)?.ok === true &&
      samePage(resumedAfterKill?.initialHistory, readPages.coldAfterKill) &&
      (readPages.coldOtherHost as Message | undefined)?.ok === true &&
      samePage(
        (hosts.F?.bootstrap as Message | undefined)?.initialHistory,
        readPages.coldOtherHost
      ),
    readPageWroteNothing:
      readPages.coldAfterKillWroteNothing === true && readPages.coldOtherHostWroteNothing === true,
    readPageLiveMatchesHistory:
      (readPages.live as Message | undefined)?.ok === true &&
      samePage(readPages.live, readPages.liveHistory),
    readPageRefusesForeignAndMissingStubs:
      (readPages.foreignStub as Message | undefined)?.ok === false &&
      ((readPages.foreignStub as Message).error as Message | undefined)?.code ===
        'session_invalid' &&
      (readPages.missingStub as Message | undefined)?.ok === false &&
      ((readPages.missingStub as Message).error as Message | undefined)?.code ===
        'dsh_session_missing',
    // P1-1: a repeated create reopens the existing log (deterministic id) and rewrites its stub
    recreateReopenedExistingLog:
      (hosts.G?.bootstrap as Message | undefined)?.sessionFile === stubS2 &&
      !('initialHistory' in ((hosts.G?.bootstrap as Message | undefined) ?? {})) &&
      Number(facts.recreated?.stub?.createdAt) > Number(facts.headerOnly?.stub?.createdAt) &&
      (turns['RECALL-RECREATED'] as Turn | undefined)?.reply?.includes(
        'present=P0-STREAM missing=-'
      ) === true &&
      exitOfHost('G').code === 0,
    // P1-3a: the shared-host protocol (src/shared/types/dshHostProtocol.ts)
    readyOverIpcWithOwnPid:
      readyPid?.reported !== undefined && readyPid.reported === readyPid.spawned,
    unknownChannelRefused:
      unknownChannel?.ok === false &&
      unknownChannel.code === CHANNEL_UNKNOWN &&
      unknownChannel.generation === GENERATION &&
      typeof unknownChannel.requestId === 'string',
    pongListsChannel:
      Array.isArray(pong?.channels) &&
      (pong.channels as Message[]).some((item) => item.ch === 'c1-1' && item.busy === false) &&
      typeof pong.eldMaxMs === 'number' &&
      typeof pong.rssMb === 'number' &&
      (pong.rssMb as number) > 0,
    closeOfUnknownChannelAnswered: protocol.closeUnknown === true,
    disposeAckThenClosed:
      disposeCloses?.closed === true &&
      (disposeCloses.order ?? []).at(-1) === 'closed' &&
      (disposeCloses.order ?? []).at(-2)?.startsWith('response:') === true,
    hostOutlivesChannel:
      Array.isArray(pongAfterClose?.channels) &&
      (pongAfterClose.channels as unknown[]).length === 0,
    stoppedBeforeExit: hosts.A?.stopped === true && hosts.A?.graceful === true,
    channelsDoNotCross:
      JSON.stringify(twoChannels?.mainSessions) === JSON.stringify([EMPTY_SESSION]) &&
      JSON.stringify(twoChannels?.sideSessions) === JSON.stringify([SIDE_SESSION]) &&
      (sideTurn?.assistantDeltas ?? 0) >= 10 &&
      sideTurn?.completed === true,
    // P1-3a: decision 023, no .env file reaches a tool
    dotEnvNotRead:
      dotEnv?.line?.includes('hostcwd=unset') === true &&
      dotEnv.line.includes('dshhome=unset') === true,
  };
  report.stderrTail = live
    .map((host) => `--- ${host.label}\n${host.stderr().slice(-1200)}`)
    .join('\n')
    .slice(-6000);
  const json = `${JSON.stringify(report, null, 2)}\n`.split(scratchRoot).join('<scratch>');
  if (outFile) writeFileSync(outFile, json);
  process.stdout.write(json);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
}

await main();
