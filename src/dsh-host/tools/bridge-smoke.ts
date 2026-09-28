/**
 * Headless bridge smoke: the DSH host driven the way Main's DshHostSupervisor
 * and its WorkerSlots drive it (Node IPC, one channel envelope per session
 * around our worker RPC, src/shared/types/dshHostProtocol.ts), with no Electron.
 *
 *   (cd src/dsh-host && ../../out-node-runtime/node tools/bridge-smoke.ts [--keep] [--out file.json]
 *      [--systemd-scope])
 *
 * Every model reply comes from the local fake gateway (plan dsh-p0-2). The
 * smoke plays Main's model source (P1-5, decisions 033 and 034): every host
 * gets a model plan with one route to the gateway first, and asks for its fake
 * key per request. Hosts, in order — at most two alive at once:
 *
 *   A  new session S1 on channel 1, bootstrapped before the host reports ready
 *      (the host buffers it). Before any turn: the DSH log and the identity
 *      stub are both on disk (P1-1, decision 007). The shared-host protocol
 *      (P1-3a): ready over IPC with the host's own pid; a request for a channel
 *      the host never opened is answered WORKER_CHANNEL_UNKNOWN; ping answers
 *      pong; closing an unknown channel answers closed. Then the P0-3 turns:
 *        STREAM         paced text in 20 deltas
 *        TOOL           one bash call (its card answered allow), then text
 *        APPROVE-ALLOW  write outside the workspace -> permission.requested ->
 *                       allow; the escalated retry the script sends next
 *                       asks again and is allowed too
 *        APPROVE-DENY   the same, both cards answered deny
 *      P1-6b part 2: S1 opens in `ask` (Main's default), so every card of
 *      every turn is answered by the smoke; the permission gate is the
 *      aiclient-permissions row's, attached by the bridge, and DSH's sandbox
 *      is off (decisions 044, 045). Three gate checks follow:
 *        PERM-DENY      `cat .env` is refused without a card, nothing leaks
 *        PERM-SESSION   two `echo` calls: one card, answered for the session,
 *                       and the second call runs without one
 *        PERM-PLAN      a second channel opened in plan mode: its write is
 *                       refused without a card, its read runs
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
 *   H  (added by dsh-rebase P1-16a) a dedicated host with its own
 *      AICLIENT_PERMISSION_AGENT_DIR, pointed at a scratch <agentDir> holding
 *      an AGENTS.md and a skill (decision 101): a fresh session's first turn
 *      only names the skill by DSH's own /name gesture, no P0/P1 marker; the
 *      next turn's P0-RECALL confirms the agent-instructions baseline
 *      (<agentDir>/AGENTS.md, the project CLAUDE.md) and the skill's injected
 *      body all reached the model by the first request (INS-1, SKL-1).
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
import { fakeGatewayPlan, HostClient, type Message, type ServedPlan } from './lib/hostClient.ts';
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
/** P1-6b part 2: a session opened in plan mode. */
const PLAN_SESSION = 'bridge-smoke-plan';
/** In the workspace's `.env`; no tool output may ever carry it. */
const ENV_CANARY = 'P16_ENV_CANARY=leaked-from-workspace-env';
const CHANNEL_UNKNOWN = 'WORKER_CHANNEL_UNKNOWN';
/** The fake key Main's stand-in hands every host, per request. */
const SMOKE_KEY = 'p1-5-smoke-fake-key';

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
  /** Main's model source, played for this host. */
  served: ServedPlan;
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
    ...(systemdScope
      ? Object.fromEntries(
          ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
            .filter((name) => process.env[name] !== undefined)
            .map((name) => [name, process.env[name] as string])
        )
      : {}),
  };
  // P1-5: the route every host is configured with, and the key it asks for.
  const plan = fakeGatewayPlan({
    baseUrl: `http://127.0.0.1:${gateway.port}`,
    clientVersion: 'bridge-smoke',
  });
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
    const client = new HostClient(child);
    const host = {
      label,
      child,
      client,
      stderr: captureStderr(child),
      exited: exitOf(child),
      startedAt: performance.now(),
      served: client.configure(plan, SMOKE_KEY),
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
      ready: message
        ? {
            type: message.type,
            pid: message.pid,
            message: message.message,
            revision: message.revision,
            routeDiagnostics: message.routeDiagnostics,
          }
        : null,
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
  /**
   * One turn, every card it raises answered as it comes (P1-6b part 2: the
   * gate asks in `ask`): `answer` is the decision, or picks one per card
   * (0-based, in the order they were shown).
   */
  const runTurn = async (
    host: Host,
    ch: string,
    logicalSessionId: string,
    label: string,
    text: string,
    answer: 'allow' | 'deny' | ((card: Message, index: number) => string) = 'allow'
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
    const isIdle = (events: Message[]) =>
      events.some(
        (e) =>
          e.type === 'session.status' && payloadOf(e).status === 'idle' && e.requestId === requestId
      );
    const answered = new Set<unknown>();
    const cards: Array<{ toolName: unknown; action: unknown; decision: string }> = [];
    const unanswered = (events: Message[]) =>
      events.filter(
        (e) => e.type === 'permission.requested' && !answered.has(payloadOf(e).permissionId)
      );
    let idle = false;
    for (;;) {
      const woke = await client.until(
        ch,
        (events) => isIdle(events.slice(from)) || unanswered(events.slice(from)).length > 0,
        150_000
      );
      const slice = client.events(ch).slice(from);
      for (const card of unanswered(slice)) {
        const payload = payloadOf(card);
        answered.add(payload.permissionId);
        const decision = typeof answer === 'function' ? answer(payload, cards.length) : answer;
        cards.push({ toolName: payload.toolName, action: payload.action, decision });
        await client.request(ch, 'worker.permission.respond', {
          logicalSessionId,
          permissionId: payload.permissionId,
          decision,
        });
      }
      idle = isIdle(client.events(ch).slice(from));
      if (idle || !woke) break;
    }
    const events = client.events(ch).slice(from);
    const deltas = events.filter((e) => e.type === 'message.delta');
    const turn = {
      idle,
      completed: events.some((e) => e.type === 'session.completed'),
      sequence: summarize(events),
      assistantDeltas: deltas.length - 1,
      reply: assistantText(events).slice(0, 200),
      permission: events.find((e) => e.type === 'permission.requested')?.payload,
      cards,
      resolved: events
        .filter((e) => e.type === 'permission.resolved')
        .map((e) => String(payloadOf(e).decision)),
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
  // P1-16a (decision 101; INS-1, SKL-1): fixture markers for host H's
  // <agentDir>/AGENTS.md, project CLAUDE.md and skill body, read back by the
  // verdict below.
  const AGENTS_DIR_MARKER = 'AICLIENT-INS1-AGENTDIR-3f7a91';
  const PROJECT_MARKER = 'AICLIENT-INS1-PROJECT-9c2e04';
  const SKILL_BODY_MARKER = 'AICLIENT-SKL1-BODY-5b1dc7';
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

    // P1-6b part 2: the gate itself. A secret is refused without a card...
    writeFileSync(join(box.workspace, '.env'), `${ENV_CANARY}\n`);
    await runTurn(a, chA, SESSION, 'PERM-DENY', 'P1-PERM-DENY: print the env file.');
    // ...an answer for the session covers the next call of the same command...
    await runTurn(
      a,
      chA,
      SESSION,
      'PERM-SESSION',
      'P1-PERM-SESSION: echo twice.',
      (_card, index) => (index === 0 ? 'allow_session' : 'deny')
    );
    // ...and a session opened in plan mode cannot write.
    writeFileSync(join(box.workspace, 'perm-plan-notes.txt'), 'plan notes\n');
    const chPlan = a.client.openChannel();
    const bootPlan = await bootstrap(a, chPlan, {
      logicalSessionId: PLAN_SESSION,
      cwd: box.workspace,
      permissions: { mode: 'plan', gear: 'ask' },
    });
    if (!bootPlan.ok) throw new Error(`plan bootstrap: ${JSON.stringify(bootPlan.error)}`);
    await runTurn(a, chPlan, PLAN_SESSION, 'PERM-PLAN', 'P1-PERM-PLAN: write, then read.');
    report.planFileWritten = existsSync(join(box.workspace, 'perm-plan.txt'));
    await closeSession(a, chPlan);

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
    await runTurn(a, chA, SESSION, 'FDS', 'P0-FDS: list the inherited descriptors.');
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
    // P1-5b: what host A asked Main for, values excluded.
    report.credentials = {
      requests: a.served.requests.length,
      outcomes: [...new Set(a.served.requests.map((item) => item.outcome))],
      refs: [...new Set(a.served.requests.map((item) => item.ref))],
    };

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

    // ---- H: P1-16a's <agentDir> overlays (decision 101) — agent-instructions'
    // dshHome and skill-filesystem's customSkillDirs, the same directory P1-6c
    // hands the host as AICLIENT_PERMISSION_AGENT_DIR (INS-1, SKL-1).
    const insSklAgentDir = join(box.root, 'ins-skl-agent-dir');
    const insSklSkillDir = join(insSklAgentDir, 'skills', 'ins-skl-smoke');
    mkdirSync(insSklSkillDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(insSklAgentDir, 'AGENTS.md'),
      `# Global agent notes\n${AGENTS_DIR_MARKER}\n`
    );
    writeFileSync(
      join(insSklSkillDir, 'SKILL.md'),
      [
        '---',
        'name: ins-skl-smoke',
        'description: P1-16a bridge-smoke fixture skill (SKL-1).',
        '---',
        '',
        `Skill body marker: ${SKILL_BODY_MARKER}`,
        '',
      ].join('\n')
    );
    const insSklWorkspace = join(box.root, 'ins-skl-workspace');
    // A `.git` marker pins the project root at this workspace, the same
    // default dsh-agent-instructions and dsh-skill-filesystem both use.
    mkdirSync(join(insSklWorkspace, '.git'), { recursive: true, mode: 0o700 });
    writeFileSync(join(insSklWorkspace, 'CLAUDE.md'), `# Project notes\n${PROJECT_MARKER}\n`);
    const insSklChild = spawn(nodeBin, ['--expose-internals', hostEntry], {
      cwd: hostCwd,
      env: { ...env, AICLIENT_PERMISSION_AGENT_DIR: insSklAgentDir },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const insSklClient = new HostClient(insSklChild);
    const h: Host = {
      label: 'INS_SKL',
      child: insSklChild,
      client: insSklClient,
      stderr: captureStderr(insSklChild),
      exited: exitOf(insSklChild),
      startedAt: performance.now(),
      served: insSklClient.configure(plan, SMOKE_KEY),
    };
    live.push(h);
    await ready(h);
    const chH = h.client.openChannel();
    const INS_SKL_SESSION = 'bridge-smoke-ins-skl';
    const bootH = await bootstrap(h, chH, {
      logicalSessionId: INS_SKL_SESSION,
      cwd: insSklWorkspace,
    });
    if (!bootH.ok) throw new Error(`H bootstrap: ${JSON.stringify(bootH.error)}`);
    // Turn 1 carries no P0/P1 marker: it only has to be the session's first
    // step (agent-instructions' baseline is folded in then, right after this
    // claimed message) and name the skill by DSH's own `/name` gesture
    // (decision 101 rule 3), not the 1.0.x `/skill:name` spelling.
    await runTurn(
      h,
      chH,
      INS_SKL_SESSION,
      'INS-SKL-PRIME',
      'Please use /ins-skl-smoke and say hello.'
    );
    // Turn 2's own request carries everything turn 1's request carried as
    // history: the agent-instructions baseline and the skill's injected body
    // are both part of turn 1's request by the time this P0-RECALL runs.
    await runTurn(
      h,
      chH,
      INS_SKL_SESSION,
      'INS-SKL-RECALL',
      `P0-RECALL {"markers":["${AGENTS_DIR_MARKER}","${PROJECT_MARKER}","${SKILL_BODY_MARKER}"]}`
    );
    await closeSession(h, chH);
    await stopHost(h);
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
  const allow = turns['APPROVE-ALLOW'] as
    | { permission?: Message; tools?: Message[]; resolved?: string[] }
    | undefined;
  const deny = turns['APPROVE-DENY'] as
    | { permission?: Message; tools?: Message[]; resolved?: string[] }
    | undefined;
  type GateTurn = {
    cards?: Message[];
    tools?: Message[];
    completed?: boolean;
    permission?: Message;
  };
  const permDeny = turns['PERM-DENY'] as GateTurn | undefined;
  const permSession = turns['PERM-SESSION'] as GateTurn | undefined;
  const permPlan = turns['PERM-PLAN'] as GateTurn | undefined;
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
  const credentials = report.credentials as
    | { requests: number; outcomes: string[]; refs: string[] }
    | undefined;
  type FdsView = { lines: string[]; inherited: boolean; channelVariable: boolean };
  const ipcHandle = experiments.ipcHandle as
    | { hostFd3: string | null; sandboxed: FdsView; escalated: FdsView }
    | undefined;
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
      // P1-4b: version 2, whose lineage starts with the session itself.
      stub?.version === 2 &&
      JSON.stringify((stub?.lineage as Message[] | undefined)?.map((item) => item.reason)) ===
        '["create"]' &&
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
    // P1-5a (decision 033): the host runs the plan it was sent, every route taken
    configuredWithPlan:
      (hosts.A?.ready as Message | undefined)?.revision === plan.revision &&
      JSON.stringify((hosts.A?.ready as Message | undefined)?.routeDiagnostics) === '[]',
    // P1-5b (decision 034): every model request pulled its key from Main, one per request
    keysPulledPerRequest:
      credentials !== undefined &&
      credentials.requests >= 4 &&
      JSON.stringify(credentials.outcomes) === '["served"]' &&
      JSON.stringify(credentials.refs) === JSON.stringify(Object.keys(plan.refs)),
    // Decision 034's precondition (IT-07): no tool inherits the host's IPC channel
    // P1-6b part 2 (decisions 042, 044): the app's own gate judges every call
    gateAsksInAsk:
      JSON.stringify((turns.TOOL as { cards?: Message[] } | undefined)?.cards) ===
      JSON.stringify([{ toolName: 'bash', action: 'run_command', decision: 'allow' }]),
    approvalCardsAnsweredEach:
      JSON.stringify(allow?.resolved) === '["allow","allow"]' &&
      JSON.stringify(deny?.resolved) === '["deny","deny"]',
    deniedCommandRefusedWithoutCard:
      permDeny !== undefined &&
      (permDeny.cards ?? []).length === 0 &&
      (permDeny.tools ?? []).length === 1 &&
      permDeny.tools?.[0]?.ok === false &&
      // 1.0.x's wording for a denied shell operand, naming the file.
      /denied: .*\/\.env$/.test(String(permDeny.tools?.[0]?.error)) &&
      !JSON.stringify(permDeny.tools).includes(ENV_CANARY) &&
      permDeny.completed === true,
    sessionGrantCoversNextCall:
      permSession !== undefined &&
      JSON.stringify(permSession.cards) ===
        JSON.stringify([{ toolName: 'bash', action: 'run_command', decision: 'allow_session' }]) &&
      JSON.stringify((permSession.permission as Message | undefined)?.sessionGrantScope) ===
        JSON.stringify({ kind: 'command', value: 'echo' }) &&
      (permSession.tools ?? []).length === 2 &&
      (permSession.tools ?? []).every((t) => t.ok === true) &&
      String(permSession.tools?.[1]?.output).includes('perm-session-second'),
    planModeRefusesWrite:
      permPlan !== undefined &&
      (permPlan.cards ?? []).length === 0 &&
      permPlan.tools?.[0]?.ok === false &&
      String(permPlan.tools?.[0]?.error).includes('access denied') &&
      permPlan.tools?.[1]?.ok === true &&
      String(permPlan.tools?.[1]?.output).includes('plan notes') &&
      report.planFileWritten === false &&
      permPlan.completed === true,
    toolsDoNotInheritIpc:
      ipcHandle !== undefined &&
      ipcHandle.hostFd3 !== null &&
      !ipcHandle.sandboxed.inherited &&
      !ipcHandle.escalated.inherited &&
      !ipcHandle.sandboxed.channelVariable &&
      !ipcHandle.escalated.channelVariable &&
      ipcHandle.sandboxed.lines.length > 0,
    // P1-16a (decision 101): <agentDir>'s AGENTS.md, the project CLAUDE.md
    // (INS-1) and a skill's `/name`-injected body (SKL-1) all reached the
    // model by the end of the session's first request.
    agentDirOverlaysReachedFirstRequest:
      (turns['INS-SKL-RECALL'] as { reply?: string } | undefined)?.reply?.includes(
        `present=${AGENTS_DIR_MARKER},${PROJECT_MARKER},${SKILL_BODY_MARKER} missing=-`
      ) === true,
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
