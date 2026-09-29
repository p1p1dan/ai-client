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
 *      P1-15's one-shot completions beside S1 (decision 125: `complete`, no
 *      channel): a review streamed in deltas, a fenced commit message, a slow
 *      review cancelled mid-stream and answered at once, a malformed request
 *      refused, and no session written for any of them,
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
 *      P1-4d2 (decision 113) reads its menu (DSH's commands, the skill by its
 *      bare name), its bootstrap's skill count, `worker.compact`'s refusal of
 *      instructions, and a `/goal` send that runs with no model turn.
 *   I  (added by dsh-rebase P1-10d) a dedicated host with the pilot plugin
 *      dsh-office-tools switched on through Main's per-plugin overrides
 *      (AICLIENT_DSH_PLUGINS, decisions 108 and 110): `ready.plugins` reports
 *      it loaded, its eight tools reach the model, and a P0-OFFICE turn in
 *      `ask` runs its write tool (`word_create`, one card, answered allow)
 *      and its read tool (`word_read`, no card) in the workspace. Both rows
 *      carry the title the plugin declares for the call (`presentCall`,
 *      decision 131), live and in `worker.history`; no row of DSH's own tools
 *      in any host carries one. Every other
 *      host runs the allowlist's defaults, where the pilot is off: A reports
 *      it disabled and offers the model none of its tools (decision 115).
 *   J  (added by dsh-rebase P1-9c) 1.0.x pi sessions from the committed
 *      synthetic corpus, placed read-only in a scratch profile, migrated by
 *      the host (`seedSession`, decision 054): a native v4 session with an
 *      image, one with three compactions, and a legacy v3 file read through
 *      the 1.0.x copy beside it. Each preview (`readPage`) shows the timeline
 *      the converter says the seed holds, under the pi entry ids; the first
 *      two resume as any DSH chat, their first page the preview's, and a
 *      P0-RECALL turn sees what 1.0.x's model context held and not what it
 *      did not. The same file again answers the same stub, untouched; an
 *      empty file is refused at decode; no source file changes. P1-9f adds a
 *      Claude Code conversation seeded as a new chat (`kind:
 *      'imported-conversation'`, decision 056): previewed, resumed, recalled
 *      without its display-only tool row, and reused when seeded again.
 *
 * Prints the RuntimeEvent sequence per turn, per-host facts, the experiments
 * and a verdict. Signals only ever go to a ChildProcess this script spawned.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
// Main's plugin override variable itself (the module has no imports; type stripping loads it).
import {
  DSH_HOST_PLUGINS_ENV,
  dshHostPluginsEnvValue,
} from '../../main/services/agent-host/dshHostEnvironment.ts';
import { projectDshHistory } from '../../shared/dshHistory/projection.ts';
import {
  convertImportedConversation,
  convertPiSessionBytes,
} from '../../shared/legacyPiSession/convert/index.ts';
import {
  FAKE_MODEL,
  FAKE_ROUTE,
  fakeGatewayPlan,
  HostClient,
  type Message,
  type ServedPlan,
} from './lib/hostClient.ts';
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
/** P1-10d: the allowlist's pilot plugin (decision 115), off unless Main's overrides turn it on. */
const PILOT_PLUGIN = 'dsh-office-tools';
const PILOT_READ_TOOLS = ['word_read', 'excel_read', 'ppt_read'];
const PILOT_WRITE_TOOLS = [
  'word_create',
  'word_update',
  'excel_create',
  'excel_update',
  'ppt_create',
];
/** What the gateway's P0-OFFICE script writes into p0-report.docx and reads back. */
const PILOT_PARAGRAPH = 'Written by dsh-office-tools through the fake gateway.';

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
 * P1-15: every session directory and identity stub under the DSH home
 * (`sessions/<project>/<id>`, `aiclient-sessions/*`), sorted, to tell that
 * a completion wrote none.
 */
function sessionIdsUnder(dshHome: string): string[] {
  const found: string[] = [];
  const sessionsRoot = join(dshHome, 'sessions');
  if (existsSync(sessionsRoot)) {
    for (const project of readdirSync(sessionsRoot)) {
      const dir = join(sessionsRoot, project);
      if (!statSync(dir).isDirectory()) continue;
      for (const id of readdirSync(dir)) found.push(`sessions/${project}/${id}`);
    }
  }
  const stubs = join(dshHome, 'aiclient-sessions');
  if (existsSync(stubs)) {
    for (const name of readdirSync(stubs)) found.push(`aiclient-sessions/${name}`);
  }
  return found.sort();
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
            // P1-10b / P1-10d: every allowlisted plugin's state on this host.
            plugins: message.plugins,
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
      // Decision 131: the titles plugin calls declared (`presentCall`), in the order they came.
      presentations: events
        .filter(
          (e) =>
            (e.type === 'tool.started' || e.type === 'tool.updated') &&
            payloadOf(e).presentation !== undefined
        )
        .map((e) => ({
          type: e.type,
          toolCallId: payloadOf(e).toolCallId,
          presentation: payloadOf(e).presentation,
        })),
      sessionIds: [...new Set(events.map((e) => e.sessionId))],
    };
    turns[label] = turn;
    return turn;
  };
  const toolOutput = (label: string) =>
    ((turns[label] as { tools?: Message[] } | undefined)?.tools ?? [])
      .map((tool) => String(tool.output ?? tool.error ?? ''))
      .join('\n');
  /** P1-10d: the tool names each model request offered, in the gateway's order. */
  const offeredTools = (): string[][] => {
    const file = join(box.root, 'gateway.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { toolNames?: string[] }).toolNames ?? []);
  };
  /** Tool names offered by the model requests of one turn: `run` between two reads of the log. */
  const offeredDuring = async (run: () => Promise<unknown>): Promise<string[][]> => {
    const before = offeredTools().length;
    await run();
    return offeredTools().slice(before);
  };

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

    // P1-10d: the pilot plugin is off by default, so none of its tools is offered.
    report.offeredWithPilotOff = await offeredDuring(() =>
      runTurn(a, chA, SESSION, 'STREAM', 'P0-STREAM: stream a paragraph back to me.')
    );
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

    // P1-15 (decision 125): one-shot completions on the same host, beside S1:
    // no channel, no session written.
    const sessionsBeforeCompletions = sessionIdsUnder(box.dshHome);
    report.completions = {
      review: await a.client.complete({
        purpose: 'code-review',
        prompt: 'P1-COMPLETE-REVIEW: review the smoke diff.',
        timeoutMs: 60_000,
        stream: true,
      }),
      commit: await a.client.complete({
        purpose: 'commit-message',
        prompt: 'P1-COMPLETE-COMMIT: one line for the smoke diff.',
        timeoutMs: 60_000,
      }),
      cancelled: await a.client.complete(
        {
          purpose: 'code-review',
          prompt: 'P1-COMPLETE-SLOW: a review to stop.',
          timeoutMs: 60_000,
          stream: true,
        },
        { cancelAfterDeltas: 2 }
      ),
      invalid: await a.client.complete({ purpose: 'title', prompt: 'x', timeoutMs: 1_000 }),
      sessionsUnchanged:
        JSON.stringify(sessionIdsUnder(box.dshHome)) === JSON.stringify(sessionsBeforeCompletions),
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
    // P1-4d2 (decisions 099 rules 9-12, 113): the menu is DSH's commands and
    // the fixture skill by its bare name; `worker.compact` refuses instructions.
    report.menu = await h.client.request(chH, 'worker.commands', {
      logicalSessionId: INS_SKL_SESSION,
    });
    const compactWithInstructions = await h.client.call(chH, 'worker.compact', {
      logicalSessionId: INS_SKL_SESSION,
      instructions: 'keep it short',
    });
    report.compactInstructions = {
      ok: compactWithInstructions.ok,
      code: (compactWithInstructions.error as Message | undefined)?.code,
    };
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
    // P1-4d2: a known command line runs as DSH's command, with no model turn.
    await runTurn(h, chH, INS_SKL_SESSION, 'COMMAND-GOAL', '/goal');
    // P1-7a (decision 118): the panels a reloaded renderer asks for, and the
    // goal bar's out-of-band command. No goal here: `/goal` answers its usage,
    // `/goal pause` is DSH's own refusal (`ok: false`), `/plan` is not run out
    // of band; none of the three puts an event on the channel.
    const eventsBeforePanels = h.client.events(chH).length;
    report.panels = await h.client.request(chH, 'worker.panels', {
      logicalSessionId: INS_SKL_SESSION,
    });
    report.commandShow = await h.client.request(chH, 'worker.command', {
      logicalSessionId: INS_SKL_SESSION,
      line: '/goal',
    });
    report.commandPause = await h.client.request(chH, 'worker.command', {
      logicalSessionId: INS_SKL_SESSION,
      line: '/goal pause',
    });
    const planOutOfBand = await h.client.call(chH, 'worker.command', {
      logicalSessionId: INS_SKL_SESSION,
      line: '/plan',
    });
    report.commandPlan = {
      ok: planOutOfBand.ok,
      code: (planOutOfBand.error as Message | undefined)?.code,
    };
    report.panelsCommandEvents = h.client.events(chH).length - eventsBeforePanels;
    // P1-7b (decisions 069, 099 rule 15, 119): a foreground command's live
    // tail and its exec stamp; then a background job the window reads and
    // stops, whose kill notice wakes the agent.
    const liveFrom = h.client.events(chH).length;
    await runTurn(
      h,
      chH,
      INS_SKL_SESSION,
      'LIVE-OUT',
      'P0-SLEEPTOOL {"token":"live-out","seconds":2} run a slow command.'
    );
    const liveEvents = h.client.events(chH).slice(liveFrom);
    report.liveOutput = {
      tails: liveEvents
        .filter((event) => event.type === 'tool.output')
        .map((event) => String(payloadOf(event).tail)),
      execStamped: liveEvents.some(
        (event) =>
          event.type === 'tool.updated' && typeof payloadOf(event).execStartedAt === 'number'
      ),
    };
    const jobsFrom = h.client.events(chH).length;
    await runTurn(
      h,
      chH,
      INS_SKL_SESSION,
      'JOBS-BG',
      'P1-JOBKILL: start a ticker in the background.'
    );
    const listed = h.client
      .events(chH)
      .slice(jobsFrom)
      .filter((event) => event.type === 'session.projection' && payloadOf(event).key === 'jobs')
      .flatMap((event) => (payloadOf(event).view as Message[] | undefined) ?? []);
    const jobId = listed[0] ? String(listed[0].id) : '';
    await sleep(800);
    const jobRead = jobId
      ? await h.client.request(chH, 'worker.job.read', {
          logicalSessionId: INS_SKL_SESSION,
          jobId,
        })
      : undefined;
    const jobKill = jobId
      ? await h.client.request(chH, 'worker.job.kill', {
          logicalSessionId: INS_SKL_SESSION,
          jobId,
        })
      : undefined;
    const jobsWoke = await h.client.until(
      chH,
      (events) =>
        events
          .slice(jobsFrom)
          .some(
            (event) =>
              event.type === 'session.status' &&
              payloadOf(event).status === 'idle' &&
              String(event.requestId ?? '').startsWith('dsh-turn-')
          ),
      60_000
    );
    const jobsAfter = await h.client.request(chH, 'worker.panels', {
      logicalSessionId: INS_SKL_SESSION,
    });
    // The human parent's interrupt reaches DSH's subagent service through the
    // row (`ctx.get('subagents')`); a child DSH does not hold is its no-op.
    const interruptNobody = await h.client.call(chH, 'worker.subagent.interrupt', {
      logicalSessionId: INS_SKL_SESSION,
      childId: 'aiclient-no-such-child',
    });
    report.subagentInterrupt = {
      ok: interruptNobody.ok,
      result: interruptNobody.result,
      code: (interruptNobody.error as Message | undefined)?.code,
    };
    report.jobs = {
      listed: listed.map((job) => ({ id: job.id, kind: job.kind, status: job.status })),
      readStartsWithTick: String(jobRead?.text ?? '').startsWith('tick 1'),
      kill: jobKill,
      woke: jobsWoke,
      after: (((jobsAfter.projections as Message[] | undefined) ?? []).find(
        (entry) => entry.key === 'jobs'
      )?.view ?? []) as Message[],
    };
    await closeSession(h, chH);
    await stopHost(h);

    // ---- I: P1-10d's pilot plugin, switched on the way Main does it (decision 110).
    const pluginWorkspace = join(box.root, 'plugin-workspace');
    mkdirSync(pluginWorkspace, { recursive: true, mode: 0o700 });
    const pluginChild = spawn(nodeBin, ['--expose-internals', hostEntry], {
      cwd: hostCwd,
      env: {
        ...env,
        [DSH_HOST_PLUGINS_ENV]: dshHostPluginsEnvValue({ [PILOT_PLUGIN]: true }) as string,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const pluginClient = new HostClient(pluginChild);
    const pluginHost: Host = {
      label: 'PLUGIN',
      child: pluginChild,
      client: pluginClient,
      stderr: captureStderr(pluginChild),
      exited: exitOf(pluginChild),
      startedAt: performance.now(),
      served: pluginClient.configure(plan, SMOKE_KEY),
    };
    live.push(pluginHost);
    await ready(pluginHost);
    const chI = pluginHost.client.openChannel();
    const PLUGIN_SESSION = 'bridge-smoke-plugin';
    const bootI = await bootstrap(pluginHost, chI, {
      logicalSessionId: PLUGIN_SESSION,
      cwd: pluginWorkspace,
    });
    if (!bootI.ok) throw new Error(`I bootstrap: ${JSON.stringify(bootI.error)}`);
    // The session opens in `ask`: the write tool's card is answered allow; the read needs none.
    report.offeredWithPilotOn = await offeredDuring(() =>
      runTurn(
        pluginHost,
        chI,
        PLUGIN_SESSION,
        'PLUGIN-OFFICE',
        'P0-OFFICE: create a Word report, then read it back.'
      )
    );
    const docx = join(pluginWorkspace, 'p0-report.docx');
    report.pilotFile = existsSync(docx)
      ? { bytes: statSync(docx).size, head: readFileSync(docx).subarray(0, 2).toString('latin1') }
      : null;
    // Decision 131: the reopened rows carry the titles the live ones did.
    const pilotHistory = await pluginHost.client.request(chI, 'worker.history', {
      logicalSessionId: PLUGIN_SESSION,
    });
    report.pilotHistoryTitles = (
      ((pilotHistory.page as Message | undefined)?.messages as Message[] | undefined) ?? []
    )
      .flatMap((message) => (message.blocks as Message[] | undefined) ?? [])
      .filter((block) => block.type === 'tool_call')
      .map((block) => ({ name: block.name, presentation: block.presentation }));
    await closeSession(pluginHost, chI);
    await stopHost(pluginHost);

    // ---- J: P1-9c (decision 054) — 1.0.x pi sessions migrated by the host, read, resumed.
    const j = startHost('J');
    await ready(j);
    const piSessions = join(box.root, 'pi-profile', 'sessions');
    mkdirSync(piSessions, { recursive: true, mode: 0o700 });
    const corpus = join(repoRoot, 'src', 'shared', '__tests__', 'fixtures', 'legacy-pi');
    /** A committed corpus file in the scratch profile, read-only: a write would fail. */
    const placePi = (file: string): string => {
      const target = join(piSessions, file);
      copyFileSync(join(corpus, file), target);
      chmodSync(target, 0o444);
      return target;
    };
    const v3 = placePi('legacy-pi-v3.jsonl');
    // 1.0.x's copy beside it, naming this profile's path as 1.0.x would have written it.
    const v3Copy = `${realpathSync(v3)}.native-v4.jsonl`;
    const copyText = readFileSync(join(corpus, 'legacy-pi-v3.jsonl.native-v4.jsonl'), 'utf8');
    const copyCut = copyText.indexOf('\n');
    const copyHeader = JSON.parse(copyText.slice(0, copyCut)) as { metadata: Message };
    copyHeader.metadata.importedFrom = realpathSync(v3);
    writeFileSync(v3Copy, `${JSON.stringify(copyHeader)}${copyText.slice(copyCut)}`);
    chmodSync(v3Copy, 0o444);
    const migrations = [
      {
        label: 'basic',
        file: placePi('v4-basic.jsonl'),
        read: '',
        logical: 'migrated-basic',
        // A prompt and the last reply reach the model; the label, an ignorable record, does not.
        present: ['What do the notes say?', 'Wrote out/summary.md.'],
        absent: ['notes answer'],
      },
      {
        label: 'compaction',
        file: placePi('v4-compaction.jsonl'),
        read: '',
        logical: 'migrated-compaction',
        // What the last compaction kept reaches the model; what it summarized does not.
        present: ['Wrap it up.', 'All steps done.'],
        absent: ['Start the long task.', 'Step one is done.'],
      },
      {
        label: 'legacy-v3',
        file: v3,
        read: v3Copy,
        logical: 'migrated-v3',
        present: [],
        absent: [],
      },
    ];
    const damagedPi = placePi('damaged-empty.jsonl');
    const fingerprint = (file: string) => {
      const stats = statSync(file);
      return `${createHash('sha256').update(readFileSync(file)).digest('hex')}:${stats.size}:${stats.mtimeMs}:${(stats.mode & 0o777).toString(8)}`;
    };
    const sourcesBefore = [...migrations.map((m) => m.file), v3Copy].map(fingerprint);
    const idsOf = (page: unknown) =>
      (((page as Message | undefined)?.messages as Message[] | undefined) ?? []).map((m) => m.id);
    const migrate: Record<string, Message> = {};
    for (const m of migrations) {
      const { size, mtimeMs } = statSync(m.file);
      const seeded = await j.client.seedSession({
        sourceFile: m.file,
        logicalSessionId: m.logical,
        cwd: box.workspace,
        expect: { bytes: size, mtimeMs },
      });
      const result = seeded.result as Message | undefined;
      // The timeline the converter says the seed holds: pi entry ids as message ids (decision 054 rule 6).
      const expected = convertPiSessionBytes(readFileSync(m.read || m.file), {
        sourceFile: realpathSync(m.file),
        cwd: box.workspace,
      });
      const expectedIds = expected.ok ? projectDshHistory(expected.seed).map((row) => row.id) : [];
      const page = result
        ? await j.client.readPage({
            stubFile: String(result.stubFile),
            logicalSessionId: m.logical,
          })
        : undefined;
      const pageIds = idsOf(page?.page);
      const row: Message = {
        ok: seeded.ok,
        error: seeded.error,
        roundTripMs: seeded.roundTripMs,
        reused: result?.reused,
        dshSessionId: result?.dshSessionId,
        stubFile: result?.stubFile,
        converted: result?.converted,
        images: result?.images,
        pageOk: page?.ok,
        messages: pageIds.length,
        pageIdsMatch: pageIds.length > 0 && JSON.stringify(pageIds) === JSON.stringify(expectedIds),
      };
      migrate[m.label] = row;
      if (!result || m.present.length === 0) continue;
      // Resumed as any DSH chat: its first page is the preview's, and the next turn sees it.
      const chJ = j.client.openChannel();
      const boot = await bootstrap(j, chJ, {
        logicalSessionId: m.logical,
        cwd: box.workspace,
        sessionFile: String(result.stubFile),
      });
      row.bootOk = boot.ok;
      row.initialIdsMatch =
        JSON.stringify(
          idsOf(((boot.result as Message | undefined)?.initialHistory as Message)?.page)
        ) === JSON.stringify(pageIds);
      const turn = await runTurn(
        j,
        chJ,
        m.logical,
        `MIGRATED-${m.label}`,
        `P0-RECALL ${JSON.stringify({ markers: [...m.present, ...m.absent] })} which markers do you see?`
      );
      const [seen = '', missed = ''] = turn.reply.split(' missing=');
      row.recall = turn.reply;
      row.recallOk =
        turn.completed &&
        m.present.every((marker) => seen.includes(marker)) &&
        m.absent.every((marker) => missed.includes(marker));
      await closeSession(j, chJ);
    }
    // The same bytes again: the stub it made, reused, and nothing written.
    const basicMigration = migrations[0] as (typeof migrations)[number];
    const basicStub = String(migrate.basic?.stubFile ?? '');
    const stubBefore = basicStub && existsSync(basicStub) ? fingerprint(basicStub) : '';
    const again = await j.client.seedSession({
      sourceFile: basicMigration.file,
      logicalSessionId: basicMigration.logical,
      cwd: box.workspace,
    });
    migrate.again = {
      ok: again.ok,
      reused: (again.result as Message | undefined)?.reused,
      sameSession:
        (again.result as Message | undefined)?.dshSessionId === migrate.basic?.dshSessionId,
      stubUntouched: stubBefore !== '' && fingerprint(basicStub) === stubBefore,
    };
    const damaged = await j.client.seedSession({
      sourceFile: damagedPi,
      logicalSessionId: 'migrated-damaged',
      cwd: box.workspace,
    });
    migrate.damaged = { ok: damaged.ok, error: damaged.error };
    // P1-9f (decision 056): a Claude Code conversation as Main's scanner makes it,
    // seeded by the host as a new chat; its preview is the converter's timeline,
    // its resume sees the prompt and the reply and not the display-only tool row.
    const importLogical = 'session-import-claude-code-smoke';
    const importedConversation = {
      schemaVersion: 1,
      importerVersion: 'b4-legacy-v2',
      sourceKind: 'claude-code',
      stableSourceIdentity: 'smoke-project/session-1',
      sourceSessionId: 'session-1',
      workspacePath: box.workspace,
      title: 'Imported in the smoke',
      startedAt: 1_790_000_000_000,
      sourceFingerprint: {
        stableSourceIdentity: 'smoke-project/session-1',
        contentHash: createHash('sha256').update('smoke-import').digest('hex'),
        size: 12,
        mode: 0o100644,
        mtimeMs: 1_790_000_000_000,
      },
      entries: [
        { kind: 'user', text: 'IMPORT-USER-MARKER what is here?', timestamp: 1_790_000_000_001 },
        {
          kind: 'display',
          displayKind: 'tool',
          title: 'Legacy tool result: Bash',
          toolCallId: 'call-1',
          toolName: 'Bash',
          output: 'IMPORT-DISPLAY-MARKER',
          isError: false,
          redacted: true,
          timestamp: 1_790_000_000_002,
        },
        {
          kind: 'assistant',
          blocks: [{ type: 'text', text: 'IMPORT-REPLY-MARKER nothing much.' }],
          model: 'claude-test',
          timestamp: 1_790_000_000_003,
        },
      ],
      diagnostics: [],
    } as const;
    const importSeeded = await j.client.seedImport({
      conversation: importedConversation,
      logicalSessionId: importLogical,
      cwd: box.workspace,
    });
    const importResult = importSeeded.result as Message | undefined;
    const expectedImport = convertImportedConversation(
      structuredClone(importedConversation) as unknown as Parameters<
        typeof convertImportedConversation
      >[0]
    );
    const expectedImportIds = expectedImport.ok
      ? projectDshHistory(expectedImport.seed).map((row) => row.id)
      : [];
    const importPage = importResult
      ? await j.client.readPage({
          stubFile: String(importResult.stubFile),
          logicalSessionId: importLogical,
        })
      : undefined;
    const importPageIds = idsOf(importPage?.page);
    const importRow: Message = {
      ok: importSeeded.ok,
      error: importSeeded.error,
      roundTripMs: importSeeded.roundTripMs,
      kind: importResult?.kind,
      reused: importResult?.reused,
      dshSessionId: importResult?.dshSessionId,
      pageOk: importPage?.ok,
      messages: importPageIds.length,
      pageIdsMatch:
        importPageIds.length > 0 &&
        JSON.stringify(importPageIds) === JSON.stringify(expectedImportIds),
    };
    if (importResult) {
      const chImport = j.client.openChannel();
      const boot = await bootstrap(j, chImport, {
        logicalSessionId: importLogical,
        cwd: box.workspace,
        sessionFile: String(importResult.stubFile),
      });
      importRow.bootOk = boot.ok;
      const present = ['IMPORT-USER-MARKER', 'IMPORT-REPLY-MARKER'];
      const absent = ['IMPORT-DISPLAY-MARKER'];
      const turn = await runTurn(
        j,
        chImport,
        importLogical,
        'IMPORTED-claude',
        `P0-RECALL ${JSON.stringify({ markers: [...present, ...absent] })} which markers do you see?`
      );
      const [seen = '', missed = ''] = turn.reply.split(' missing=');
      importRow.recall = turn.reply;
      importRow.recallOk =
        turn.completed &&
        present.every((marker) => seen.includes(marker)) &&
        absent.every((marker) => missed.includes(marker));
      await closeSession(j, chImport);
      // The same conversation for the same chat again: the stub it made, nothing new.
      const importAgain = await j.client.seedImport({
        conversation: importedConversation,
        logicalSessionId: importLogical,
        cwd: box.workspace,
      });
      const againResult = importAgain.result as Message | undefined;
      importRow.againReused =
        importAgain.ok === true &&
        againResult?.reused === true &&
        againResult?.dshSessionId === importResult.dshSessionId;
    }
    migrate.imported = importRow;
    migrate.sourcesUntouched = {
      same:
        JSON.stringify([...migrations.map((m) => m.file), v3Copy].map(fingerprint)) ===
        JSON.stringify(sourcesBefore),
    };
    report.migrate = migrate;
    await stopHost(j);
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
    presentations?: Array<{ type: string; toolCallId: unknown; presentation: Message }>;
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
  /** Host J's record of one migration (P1-9c). */
  const migrated = (label: string) =>
    ((report.migrate as Record<string, Message> | undefined)?.[label] ?? {}) as Message;
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
  // P1-15: host A's one-shot completions, as `HostClient.complete` answered them.
  type CompletionAnswer = Message & { deltas: string[]; cancelToAnswerMs?: number };
  const completions = report.completions as
    | {
        review?: CompletionAnswer;
        commit?: CompletionAnswer;
        cancelled?: CompletionAnswer;
        invalid?: CompletionAnswer;
        sessionsUnchanged?: boolean;
      }
    | undefined;
  type FdsView = { lines: string[]; inherited: boolean; channelVariable: boolean };
  const ipcHandle = experiments.ipcHandle as
    | { hostFd3: string | null; sandboxed: FdsView; escalated: FdsView }
    | undefined;
  // P1-4d2: host H's menu as `<source>:<name>`, its bootstrap's inventory and its command send.
  const menuNames = (((report.menu as Message | undefined)?.commands as Message[]) ?? []).map(
    (row) => `${String(row.source)}:${String(row.name)}`
  );
  const bootHCapabilities = (hosts.INS_SKL?.bootstrap as Message | undefined)?.capabilities as
    | Message
    | undefined;
  const commandGoal = turns['COMMAND-GOAL'] as
    | { idle?: boolean; completed?: boolean; sequence?: string[] }
    | undefined;
  // P1-10d: the pilot plugin, off on A (the allowlist's default) and on for I.
  const pilotOf = (label: string) => {
    const plugins = (hosts[label]?.ready as Message | undefined)?.plugins as
      | { enabledFrom?: string; plugins?: Message[] }
      | undefined;
    return {
      enabledFrom: plugins?.enabledFrom,
      status: plugins?.plugins?.find((item) => item.name === PILOT_PLUGIN),
    };
  };
  const pilotTools = [...PILOT_READ_TOOLS, ...PILOT_WRITE_TOOLS];
  const offeredOff = (report.offeredWithPilotOff as string[][] | undefined) ?? [];
  const offeredOn = (report.offeredWithPilotOn as string[][] | undefined) ?? [];
  const pilotTurn = turns['PLUGIN-OFFICE'] as GateTurn | undefined;
  const pilotFile = report.pilotFile as { bytes?: number; head?: string } | null | undefined;
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
    // P1-15 (decision 125): one-shot completions through ctx.llm, no channel, no session
    completionStreamsAndAnswers:
      completions?.review?.ok === true &&
      completions.review.deltas.length >= 2 &&
      completions.review.deltas.join('') === completions.review.text &&
      completions.review.model === `${FAKE_ROUTE}/${FAKE_MODEL}` &&
      completions.commit?.ok === true &&
      completions.commit.deltas.length === 0 &&
      String(completions.commit.text).startsWith('```'),
    completionCancelAnsweredAtOnce:
      completions?.cancelled?.ok === false &&
      (completions.cancelled.error as Message | undefined)?.code === 'completion_cancelled' &&
      (completions.cancelled.cancelToAnswerMs ?? Number.POSITIVE_INFINITY) < 1_000,
    completionRefusesMalformedRequest:
      (completions?.invalid?.error as Message | undefined)?.code === 'completion_request_invalid',
    completionWritesNoSession: completions?.sessionsUnchanged === true,
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
    // P1-4d2 (decisions 099 rules 9-12, 113): DSH's commands minus the hidden
    // and window-owned ones, the skill by its bare name; the inventory counts
    // skills alone; `/compact` takes no instructions; a command send opens no
    // model turn and answers with a notice.
    menuListsDshCommandsAndSkills:
      menuNames.includes('command:goal') &&
      menuNames.includes('skill:ins-skl-smoke') &&
      !menuNames.some((name) => /:(plan|permission|feedback|compact)$/.test(name)) &&
      !menuNames.some((name) => name.includes('skill:skill:')),
    capabilitiesReportSkillsOnly:
      JSON.stringify(Object.keys(bootHCapabilities ?? {})) === '["skills"]' &&
      Number(bootHCapabilities?.skills) >= 1,
    compactRefusesInstructions:
      (report.compactInstructions as Message | undefined)?.ok === false &&
      (report.compactInstructions as Message | undefined)?.code ===
        'WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED',
    commandSendOpensNoModelTurn:
      commandGoal?.idle === true &&
      commandGoal.completed === true &&
      commandGoal.sequence?.includes('message.started user') === true &&
      commandGoal.sequence.includes('custom.message') &&
      !commandGoal.sequence.includes('message.started assistant'),
    // P1-7a (decision 118): `worker.panels` answers the three DSH keys and the
    // bridge's `goalActivation` (null: no goal); `worker.command` runs `/goal`
    // out of band with DSH's text either way, refuses `/plan`, and neither RPC
    // puts an event on the channel.
    // P1-7b adds the bridge's `jobs` (empty: no job yet).
    panelsAnswerCurrentValues:
      JSON.stringify(
        (((report.panels as Message | undefined)?.projections as Message[]) ?? []).map(
          (entry) => entry.key
        )
      ) === '["todos","goal","subagentCatalog","goalActivation","jobs"]' &&
      (((report.panels as Message | undefined)?.projections as Message[]) ?? []).find(
        (entry) => entry.key === 'goalActivation'
      )?.view === null &&
      JSON.stringify(
        (((report.panels as Message | undefined)?.projections as Message[]) ?? []).find(
          (entry) => entry.key === 'jobs'
        )?.view
      ) === '[]',
    // P1-7b (decisions 072 rule 5, 099 rule 15): a running command's row got
    // its live tail from the job DSH runs it as, and its exec stamp.
    liveOutputReachesTheRow:
      ((report.liveOutput as { tails?: string[] } | undefined)?.tails ?? []).some((tail) =>
        tail.includes('sleep-tool live-out started')
      ) && (report.liveOutput as { execStamped?: boolean } | undefined)?.execStamped === true,
    // P1-7b (decision 119): a background job is listed, read from the top,
    // stopped from outside, and its kill notice wakes the agent (069 rule 2).
    subagentInterruptReachesDsh:
      (report.subagentInterrupt as Message | undefined)?.ok === true &&
      ((report.subagentInterrupt as Message | undefined)?.result as Message | undefined)
        ?.interrupted === true,
    backgroundJobListedReadAndStopped:
      (report.jobs as { listed?: Message[] } | undefined)?.listed?.[0]?.status === 'running' &&
      (report.jobs as { readStartsWithTick?: boolean } | undefined)?.readStartsWithTick === true &&
      (report.jobs as { kill?: Message } | undefined)?.kill?.outcome === 'requested' &&
      (report.jobs as { woke?: boolean } | undefined)?.woke === true &&
      ((report.jobs as { after?: Message[] } | undefined)?.after ?? []).some(
        (job) => job.status === 'killed'
      ),
    commandRunsOutOfBand:
      (report.commandShow as Message | undefined)?.ok === true &&
      String((report.commandShow as Message | undefined)?.output).includes('No goal') &&
      (report.commandPause as Message | undefined)?.ok === false &&
      typeof (report.commandPause as Message | undefined)?.error === 'string' &&
      (report.commandPlan as Message | undefined)?.ok === false &&
      (report.commandPlan as Message | undefined)?.code === 'WORKER_COMMAND_UNKNOWN' &&
      report.panelsCommandEvents === 0,
    // P1-10d (decisions 060, 115): the pilot plugin is allowlisted but off by
    // default — reported disabled, none of its tools offered to the model...
    pilotOffByDefault:
      pilotOf('A').enabledFrom === 'default' &&
      pilotOf('A').status?.state === 'disabled' &&
      offeredOff.length > 0 &&
      offeredOff.every(
        (names) => names.length > 0 && !names.some((name) => pilotTools.includes(name))
      ),
    // ...and Main's override loads it from the install scope, every tool offered...
    pilotLoadedWhenEnabled:
      pilotOf('PLUGIN').enabledFrom === 'main' &&
      pilotOf('PLUGIN').status?.state === 'loaded' &&
      pilotOf('PLUGIN').status?.inactiveRows === undefined &&
      offeredOn.length > 0 &&
      offeredOn.every((names) => pilotTools.every((tool) => names.includes(tool))),
    // ...its write tool raises the gate's card, its read tool in the workspace does not...
    pilotWriteAskedReadDidNot:
      JSON.stringify(pilotTurn?.cards) ===
        JSON.stringify([{ toolName: 'word_create', decision: 'allow' }]) &&
      String(
        ((pilotTurn?.permission as Message | undefined)?.input as Message | undefined)?.path
      ).endsWith('/p0-report.docx'),
    // ...and the document it wrote is a real zip it reads back.
    pilotWroteAndReadBack:
      pilotFile?.head === 'PK' &&
      (pilotFile.bytes ?? 0) > 0 &&
      (pilotTurn?.tools ?? []).length === 2 &&
      (pilotTurn?.tools ?? []).every((t) => t.ok === true) &&
      String(pilotTurn?.tools?.[1]?.output).includes(PILOT_PARAGRAPH) &&
      pilotTurn?.completed === true &&
      exitOfHost('PLUGIN').code === 0,
    // Decision 131: each office row carries the title the plugin declares
    // for it — `Create …` for the write, `Read …` for the read, live and
    // reopened alike — and no row of DSH's own tools carries one.
    pilotRowsTitled:
      JSON.stringify(
        (pilotTurn?.presentations ?? []).map((entry) => [
          entry.presentation.card,
          entry.presentation.title,
          entry.presentation.kind,
        ])
      ) ===
        JSON.stringify([
          ['generic', 'Create p0-report.docx', 'edit'],
          ['generic', 'Read p0-report.docx', 'read'],
        ]) &&
      JSON.stringify(
        ((report.pilotHistoryTitles as Message[] | undefined) ?? []).map((row) => [
          row.name,
          (row.presentation as Message | undefined)?.title,
        ])
      ) ===
        JSON.stringify([
          ['word_create', 'Create p0-report.docx'],
          ['word_read', 'Read p0-report.docx'],
        ]) &&
      Object.values(turns).every((turn) =>
        ((turn as GateTurn).presentations ?? []).every(
          (entry) => turn === pilotTurn && entry.presentation !== undefined
        )
      ),
    // P1-9c (decision 054): each migration made a session whose preview is
    // the converter's timeline, under the pi entry ids...
    migratedAndPreviewed: ['basic', 'compaction', 'legacy-v3'].every(
      (label) =>
        migrated(label).ok === true &&
        migrated(label).reused === false &&
        migrated(label).pageOk === true &&
        migrated(label).pageIdsMatch === true
    ),
    // ...its image admitted, the legacy file read through its 1.0.x copy...
    migratedImageAndCopy:
      (migrated('basic').images as Message | undefined)?.admitted === 1 &&
      migrated('legacy-v3').converted === 'native-v4-copy',
    // ...resumed as any DSH chat, with what 1.0.x's model saw in context...
    migratedResumedAndRecalled: ['basic', 'compaction'].every(
      (label) =>
        migrated(label).bootOk === true &&
        migrated(label).initialIdsMatch === true &&
        migrated(label).recallOk === true
    ),
    // ...the same file again answering the same stub, untouched...
    migrationIdempotent:
      migrated('again').ok === true &&
      migrated('again').reused === true &&
      migrated('again').sameSession === true &&
      migrated('again').stubUntouched === true,
    // ...a Claude Code conversation imported as a DSH chat (P1-9f): previewed,
    // resumed with what reached 1.0.x's model and not its display rows, and
    // the same import again answered with the stub it made...
    importedConversationSeeded:
      migrated('imported').ok === true &&
      migrated('imported').kind === 'imported-conversation' &&
      migrated('imported').reused === false &&
      migrated('imported').pageOk === true &&
      migrated('imported').pageIdsMatch === true &&
      migrated('imported').bootOk === true &&
      migrated('imported').recallOk === true &&
      migrated('imported').againReused === true,
    // ...an unreadable one refused where 1.0.x refused it, and no source changed.
    migrationRefusesAndTouchesNothing:
      migrated('damaged').ok === false &&
      (migrated('damaged').error as Message | undefined)?.stage === 'decode' &&
      (migrated('damaged').error as Message | undefined)?.code === 'session_invalid' &&
      migrated('sourcesUntouched').same === true &&
      exitOfHost('J').code === 0,
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
