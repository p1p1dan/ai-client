/**
 * Headless bridge smoke: the DSH host in bridge mode, driven exactly as Main's
 * WorkerSlot drives a worker (Node IPC, worker RPC), with no Electron.
 *
 *   node bridge-smoke.ts [--keep] [--out file.json]
 *
 * Every model reply comes from the local fake gateway (plan dsh-p0-2). Hosts,
 * in order — at most two alive at once:
 *
 *   A  new session S1. Before any turn: the DSH log and the identity stub are
 *      both on disk (P1-1, decision 007). Then the P0-3 turns:
 *        STREAM         paced text in 20 deltas
 *        TOOL           one bash call, then text
 *        APPROVE-ALLOW  write outside the workspace -> sandbox denial ->
 *                       escalation -> permission.requested -> allow
 *        APPROVE-DENY   the same, answered deny
 *      then worker.dispose.
 *   B  new session S2, SIGKILLed right after bootstrap: a header-only log whose
 *      writer died holding the lock — the crash decision 007 exists for.
 *   C  resumes S2 from its stub: a header-only session reopens, the first page
 *      is a legal empty `initialHistory`, and a STREAM turn runs on it.
 *   D  while C holds S2: resuming it again answers `session_locked`.
 *      C is then SIGKILLed mid-session.
 *   E  resumes S2 after that SIGKILL and recalls C's turn.
 *   F  resumes S1 in yet another host and recalls A's turns.
 *   G  asks to CREATE S2 again, as a retry does when an earlier create reached
 *      the disk but never became Main's identity: the bridge reopens the log
 *      with the deterministic id instead of failing on it, and recalls C's turn.
 *
 * Prints the RuntimeEvent sequence per turn, per-host facts and a verdict.
 * SIGKILL only ever goes to the exact pid of a host this script spawned.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { baseEnv, captureStderr, exitOf, sandbox, stopWithin, waitQuiet } from './lib/kit.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const hostEntry = join(here, 'host.ts');
const gatewayEntry = join(
  repoRoot,
  'docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/fake-gateway.mjs'
);
const bundledNode = join(repoRoot, 'out-node-runtime', 'node');
const nodeBin = existsSync(bundledNode) ? bundledNode : process.execPath;
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const outIndex = argv.indexOf('--out');
const outFile = outIndex >= 0 ? argv[outIndex + 1] : '';
const scratchRoot = join('/var/tmp', `aiclient-dsh-p1-1-smoke-${Date.now()}`);
const GENERATION = 1;
const SESSION = 'bridge-smoke';
const EMPTY_SESSION = 'bridge-smoke-empty';

type Message = Record<string, unknown>;

// ---- safety: signal one exact pid ---------------------------------------------

function killPid(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 1 || pid === process.pid) {
    throw new Error(`refusing to signal pid ${String(pid)}`);
  }
  process.kill(pid as number, signal);
}

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

class WorkerClient {
  private seq = 0;
  readonly events: Message[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
    child.on('message', (message: unknown) => {
      const record = message as Message;
      if (record?.kind === 'event' && record.type === 'runtime.event') {
        this.events.push(record.payload as Message);
      }
      for (const wake of [...this.waiters]) wake();
    });
  }

  /** One RPC, answered with the raw response (ok or not). */
  call(type: string, payload: Message, timeoutMs = 60_000): Promise<Message> {
    const requestId = `smoke-${++this.seq}`;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`${type} timed out`)), timeoutMs);
      const onMessage = (message: unknown) => {
        const record = message as Message;
        if (record?.kind !== 'response' || record.requestId !== requestId) return;
        clearTimeout(timer);
        this.child.off('message', onMessage);
        done(record);
      };
      this.child.on('message', onMessage);
      this.child.send({
        protocolVersion: 1,
        kind: 'request',
        generation: GENERATION,
        requestId,
        type,
        payload,
      });
    });
  }

  async request(type: string, payload: Message, timeoutMs = 60_000): Promise<Message> {
    const record = await this.call(type, payload, timeoutMs);
    if (record.ok) return record.result as Message;
    throw new Error(`${type}: ${JSON.stringify(record.error)}`);
  }

  /** Resolve once `predicate` holds over the events seen so far. */
  until(predicate: (events: Message[]) => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate(this.events)) return Promise.resolve(true);
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        done(false);
      }, timeoutMs);
      const check = () => {
        if (!predicate(this.events)) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        done(true);
      };
      this.waiters.add(check);
    });
  }
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
  client: WorkerClient;
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

async function main() {
  await waitQuiet();
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const box = sandbox(scratchRoot, 'run');
  const outside = join(box.root, 'outside');
  mkdirSync(outside, { recursive: true, mode: 0o700 });
  const gateway = await startGateway(box.root);
  const env = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AICLIENT_DSH_BRIDGE: '1',
    AICLIENT_PI_WORKER_GENERATION: String(GENERATION),
    AICLIENT_DSH_GATEWAY_URL: `http://127.0.0.1:${gateway.port}`,
    AICLIENT_DSH_GATEWAY_KEY: 'p1-1-fake-key',
  };
  const report: Record<string, unknown> = { node: nodeBin, scratch: '<scratch>' };
  const turns: Record<string, unknown> = {};
  const hosts: Record<string, Message> = {};
  const live: Host[] = [];

  // Host cwd is app-private (P0-2: the launch directory's .env reaches tools).
  const startHost = (label: string): Host => {
    const child = spawn(nodeBin, ['--expose-internals', hostEntry], {
      cwd: box.dshHome,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const host = {
      label,
      child,
      client: new WorkerClient(child),
      stderr: captureStderr(child),
      exited: exitOf(child),
      startedAt: performance.now(),
    };
    live.push(host);
    return host;
  };
  const bootstrap = async (host: Host, payload: Message) => {
    // Sent immediately, as Main does: the host must buffer it until the bridge row is up.
    const response = await host.client.call('worker.bootstrap', payload);
    hosts[host.label] = {
      ...(hosts[host.label] ?? {}),
      pid: host.child.pid,
      bootstrapMs: Math.round(performance.now() - host.startedAt),
      bootstrap: response.ok ? response.result : { error: response.error },
    };
    return response;
  };
  const dispose = async (host: Host) => {
    const disposed = await host.client.request('worker.dispose', { reason: 'app-shutdown' });
    const graceful = await stopWithin(host.exited, 15_000);
    hosts[host.label] = {
      ...hosts[host.label],
      dispose: disposed,
      graceful,
      exit: await host.exited,
    };
  };
  const kill = async (host: Host) => {
    killPid(host.child.pid, 'SIGKILL');
    hosts[host.label] = { ...hosts[host.label], killed: true, exit: await host.exited };
  };
  const runTurn = async (
    host: Host,
    logicalSessionId: string,
    label: string,
    text: string,
    onPermission?: 'allow' | 'deny'
  ) => {
    const { client } = host;
    const requestId = `turn-${label}`;
    const from = client.events.length;
    await client.request('worker.send', {
      logicalSessionId,
      requestId,
      attemptId: `attempt-${label}`,
      text,
    });
    if (onPermission) {
      const asked = await client.until(
        (events) => events.slice(from).some((e) => e.type === 'permission.requested'),
        60_000
      );
      const request = client.events.slice(from).find((e) => e.type === 'permission.requested');
      if (asked && request) {
        await client.request('worker.permission.respond', {
          logicalSessionId,
          permissionId: payloadOf(request).permissionId,
          decision: onPermission,
        });
      }
    }
    const idle = await client.until(
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
    const events = client.events.slice(from);
    const deltas = events.filter((e) => e.type === 'message.delta');
    const turn = {
      idle,
      completed: events.some((e) => e.type === 'session.completed'),
      sequence: summarize(events),
      assistantDeltas: deltas.length - 1,
      reply: assistantText(events).slice(0, 200),
      permission: events.find((e) => e.type === 'permission.requested')?.payload,
      tools: events.filter((e) => e.type === 'tool.completed').map((e) => payloadOf(e)),
    };
    turns[label] = turn;
    return turn;
  };

  const facts: Record<string, ReturnType<typeof diskFacts>> = {};
  let stubS1: string | undefined;
  let stubS2: string | undefined;
  let resumedS2: Message | undefined;
  let lockedCode: unknown;
  try {
    // ---- A: new session, persisted before its first turn, then the P0-3 turns
    const a = startHost('A');
    const bootA = await bootstrap(a, { logicalSessionId: SESSION, cwd: box.workspace });
    if (!bootA.ok) throw new Error(`A bootstrap: ${JSON.stringify(bootA.error)}`);
    report.bootstrapMs = hosts.A.bootstrapMs;
    report.bootstrap = bootA.result;
    stubS1 = String((bootA.result as Message).sessionFile);
    facts.newBeforeFirstTurn = diskFacts(box.dshHome, `aiclient-${SESSION}`, stubS1);
    report.commands = await a.client.request('worker.commands', { logicalSessionId: SESSION });

    await runTurn(a, SESSION, 'STREAM', 'P0-STREAM: stream a paragraph back to me.');
    await runTurn(a, SESSION, 'TOOL', 'P0-TOOL: list the workspace.');
    const allowTarget = join(outside, 'allowed.txt');
    await runTurn(
      a,
      SESSION,
      'APPROVE-ALLOW',
      `P0-APPROVAL: write outside, path=${allowTarget}`,
      'allow'
    );
    const denyTarget = join(outside, 'denied.txt');
    await runTurn(
      a,
      SESSION,
      'APPROVE-DENY',
      `P0-APPROVAL: write outside, path=${denyTarget}`,
      'deny'
    );
    report.files = { allowed: existsSync(allowTarget), denied: existsSync(denyTarget) };
    report.history = await a.client.request('worker.history', { logicalSessionId: SESSION });
    await dispose(a);
    report.dispose = hosts.A.dispose;
    report.graceful = hosts.A.graceful;

    // ---- B: new session S2, killed before any turn (header-only log, lock held)
    const b = startHost('B');
    const bootB = await bootstrap(b, { logicalSessionId: EMPTY_SESSION, cwd: box.workspace });
    if (!bootB.ok) throw new Error(`B bootstrap: ${JSON.stringify(bootB.error)}`);
    stubS2 = String((bootB.result as Message).sessionFile);
    facts.headerOnly = diskFacts(box.dshHome, `aiclient-${EMPTY_SESSION}`, stubS2);
    await kill(b);

    // ---- C: resume the header-only session from its stub and run a turn
    const c = startHost('C');
    const bootC = await bootstrap(c, {
      logicalSessionId: EMPTY_SESSION,
      cwd: box.workspace,
      sessionFile: stubS2,
    });
    if (!bootC.ok) throw new Error(`C bootstrap: ${JSON.stringify(bootC.error)}`);
    resumedS2 = bootC.result as Message;
    await runTurn(c, EMPTY_SESSION, 'RESUMED-STREAM', 'P0-STREAM: stream a paragraph back to me.');

    // ---- D: a second host cannot open a session C holds
    const d = startHost('D');
    const bootD = await bootstrap(d, {
      logicalSessionId: EMPTY_SESSION,
      cwd: box.workspace,
      sessionFile: stubS2,
      // Ignored by the bridge: the DSH write lock is a kernel lock.
      forceTakeover: true,
    });
    lockedCode = bootD.ok ? 'opened' : (bootD.error as Message | undefined)?.code;
    await dispose(d);

    // ---- C dies mid-session; E reopens S2 and recalls C's turn
    await kill(c);
    facts.afterKill = diskFacts(box.dshHome, `aiclient-${EMPTY_SESSION}`, stubS2);
    const e = startHost('E');
    const bootE = await bootstrap(e, {
      logicalSessionId: EMPTY_SESSION,
      cwd: box.workspace,
      sessionFile: stubS2,
    });
    if (!bootE.ok) throw new Error(`E bootstrap: ${JSON.stringify(bootE.error)}`);
    await runTurn(e, EMPTY_SESSION, 'RECALL-AFTER-KILL', 'P0-RECALL {"markers":["P0-STREAM"]}');
    await dispose(e);

    // ---- F: S1 in yet another host, with A's turns in context
    const f = startHost('F');
    const bootF = await bootstrap(f, {
      logicalSessionId: SESSION,
      cwd: box.workspace,
      sessionFile: stubS1,
    });
    if (!bootF.ok) throw new Error(`F bootstrap: ${JSON.stringify(bootF.error)}`);
    await runTurn(f, SESSION, 'RECALL-OTHER-HOST', 'P0-RECALL {"markers":["P0-STREAM","P0-TOOL"]}');
    await dispose(f);

    // ---- G: a create for a logical session whose DSH log already exists
    const g = startHost('G');
    const bootG = await bootstrap(g, { logicalSessionId: EMPTY_SESSION, cwd: box.workspace });
    if (!bootG.ok) throw new Error(`G bootstrap: ${JSON.stringify(bootG.error)}`);
    facts.recreated = diskFacts(box.dshHome, `aiclient-${EMPTY_SESSION}`, stubS2);
    await runTurn(g, EMPTY_SESSION, 'RECALL-RECREATED', 'P0-RECALL {"markers":["P0-STREAM"]}');
    await dispose(g);
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

  const stream = turns.STREAM as { assistantDeltas?: number } | undefined;
  const tool = turns.TOOL as { tools?: Message[] } | undefined;
  const allow = turns['APPROVE-ALLOW'] as { permission?: Message; tools?: Message[] } | undefined;
  const deny = turns['APPROVE-DENY'] as { permission?: Message; tools?: Message[] } | undefined;
  const files = report.files as { allowed?: boolean; denied?: boolean } | undefined;
  type Turn = { idle?: boolean; completed?: boolean; reply?: string };
  const resumedTurn = turns['RESUMED-STREAM'] as Turn | undefined;
  const recallKill = turns['RECALL-AFTER-KILL'] as Turn | undefined;
  const recallOther = turns['RECALL-OTHER-HOST'] as Turn | undefined;
  const history = resumedS2?.initialHistory as
    | { logicalSessionId?: string; sessionFile?: string; workspacePath?: string; page?: Message }
    | undefined;
  const fresh = facts.newBeforeFirstTurn;
  const stub = fresh?.stub;
  const exitOfHost = (label: string) =>
    (hosts[label]?.exit ?? {}) as { code?: number | null; signal?: string | null };
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
    // P1-1: a repeated create reopens the existing log (deterministic id) and rewrites its stub
    recreateReopenedExistingLog:
      (hosts.G?.bootstrap as Message | undefined)?.sessionFile === stubS2 &&
      !('initialHistory' in ((hosts.G?.bootstrap as Message | undefined) ?? {})) &&
      Number(facts.recreated?.stub?.createdAt) > Number(facts.headerOnly?.stub?.createdAt) &&
      (turns['RECALL-RECREATED'] as Turn | undefined)?.reply?.includes(
        'present=P0-STREAM missing=-'
      ) === true &&
      exitOfHost('G').code === 0,
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
