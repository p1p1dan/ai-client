/**
 * dsh-rebase P1-8 real-host regression for the `aiclient-loop-guard` row
 * (decisions 065, 066; plan P1-8 §6, scenarios G1-G7, experiments E1-E6).
 * Every model request is answered by the local fake gateway's P8 scripts;
 * sessions are driven through the test-only probe row (create, prompt, wait
 * idle) and judged from the durable session events it logs.
 *
 *   (cd src/dsh-host && ../../out-node-runtime/node tools/loop-guard-smoke.ts [--keep] [--out f.json])
 *
 * Host A  guard on, step ceiling 3 (home patch), gateway route retrying in
 *         mode `always` with a short backoff (the plan the script configures
 *         the host with, P1-5a):
 *   G1/E1/E2  P8-REPEAT: 200 identical `job_list {}` in one paced reply. Cut at
 *             the third: the gateway sees the client hang up right after it,
 *             one request only (no retry), `assistant/attempt`, no `tool/call`,
 *             `turn/end error{tool_call_repetition}`; the next request of the
 *             session does not carry the cut reply.
 *   E1 ctl    P1-FAIL in the same host is retried (`llm/retry`): mode always is live.
 *   G2        P8-VARIED: 40 distinct `job_output`; cut at the seventeenth.
 *   G3        P8-FANOUT: ten distinct `subagent` calls run, nothing is cut.
 *   G7/E3     P8-SUBREPEAT: the child's own degenerate reply is cut in the
 *             child; a child's endless loop meets its own step ceiling.
 *   G4/E4/E5  P8-LOOP: three read steps, then the wrap-up step carries the
 *             instruction (tools still declared), its escalating bash call is
 *             refused with no approval asked, and the turn ends
 *             `aborted{hook,'aiclient-turn-ceiling'}`; the same with a text wrap-up.
 *   G5/E6     P8-WAKE: two background jobs, the ceiling, then each job notice
 *             gets one tool-less wrap-up request (no more), the notices stay
 *             in the log; the next user message opens a new count.
 * Host B  AICLIENT_RUNTIME_LOOP_GUARD=0 (same patch):
 *   G6        P8-REPEAT runs all 30 calls; a 6-step P8-LOOP is not capped.
 * Host C  guard on, ceiling 3, the route in mode `normal` with retries, and
 *         `aiclient-permissions` switched on with no gate attached (every call
 *         refused by it):
 *   E1b       P8-REPEAT is not retried in mode normal either.
 *   E5b       the wrap-up step's call is refused by the loop guard, not by the
 *             permission row registered before it.
 *
 * At most one host runs at a time; the script needs 900 MB available. Signals
 * only ever go to a ChildProcess it spawned.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { fakeGatewayPlan, serveModelPlan } from './lib/hostClient.ts';
import {
  baseEnv,
  captureStderr,
  exitOf,
  launch,
  type Sandbox,
  sandbox,
  sleep,
  stopWithin,
  waitMessage,
} from './lib/kit.ts';
import { installProbeBundle } from './lib/probe-bundle.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const hostEntry = join(hostDir, 'host.ts');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const bundledNode = join(repoRoot, 'out-node-runtime', 'node');

const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const nodeBin = option('node', existsSync(bundledNode) ? bundledNode : process.execPath);
const keep = argv.includes('--keep');
const outFile = option('out', '');
const only = option('only', '');
const scratchRoot = join('/var/tmp', `aiclient-dsh-loop-guard-${Date.now()}`);
const log = (message: string) => process.stderr.write(`[loop-guard] ${message}\n`);
const MIN_AVAILABLE_MB = 900;
const CEILING = 3;
const REFUSAL =
  'Refused: this run has reached its turn ceiling. Do not call tools; write your summary for the user instead.';
const CEILING_TEXT = "this app's ceiling for one run";

type Line = Record<string, unknown>;

function availableMb(): number {
  const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
  return match ? Number(match[1]) / 1024 : Number.NaN;
}

function readLines(file: string): Line[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

// ---- processes -----------------------------------------------------------------

async function startGateway(root: string): Promise<{ port: number; child: ChildProcess }> {
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
      join(root, 'gateway.jsonl'),
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
  child.stderr?.resume();
  return { port, child };
}

interface Host {
  label: string;
  box: Sandbox;
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
  ready: Line;
  events: string;
}

let requestSeq = 0;
async function call(host: Host, type: string, payload: Line = {}, timeoutMs = 60_000) {
  const requestId = `r${++requestSeq}`;
  const reply = waitMessage(
    host.child,
    (m) => m.requestId === requestId,
    timeoutMs,
    `${host.label} ${type}`
  );
  host.child.send({ type, requestId, ...payload });
  return reply;
}

/** Retry policies of the gateway route; the plan's routes carry them (P1-5a). */
const ALWAYS_RETRY = {
  mode: 'always',
  backoff: { initialDelayMs: 200, maxDelayMs: 400, jitterRatio: 0 },
};
const NORMAL_RETRY = {
  mode: 'normal',
  maxRetries: 3,
  backoff: { initialDelayMs: 200, maxDelayMs: 400, jitterRatio: 0 },
};

const ceilingPatch = `- id: aiclient-loop-guard\n  config:\n    stepCeiling: ${CEILING}\n`;

async function startHost(
  label: string,
  port: number,
  homePatch: string,
  extraEnv: Record<string, string> = {},
  retryPolicy?: Record<string, unknown>
): Promise<Host> {
  const box = sandbox(scratchRoot, label);
  writeFileSync(join(box.workspace, 'p8-loop.txt'), 'P8 loop file\n');
  writeFileSync(join(box.dshHome, 'cordis.patch.yml'), homePatch);
  installProbeBundle(box.dshHome);
  const events = join(box.root, 'events.jsonl');
  const env = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AICLIENT_PROBE_EVENT_LOG: events,
    ...extraEnv,
  };
  const launchDir = join(box.root, 'launch');
  mkdirSync(launchDir, { recursive: true });
  const child = launch(
    [nodeBin, '--expose-internals', '--import', hooksEntry, hostEntry],
    env,
    launchDir
  );
  // Main's model source, played: the route with this host's retry policy, and its key.
  serveModelPlan(
    child,
    fakeGatewayPlan({
      baseUrl: `http://127.0.0.1:${port}`,
      ...(retryPolicy ? { retryPolicy } : {}),
    }),
    'p1-8-fake-key'
  );
  const stderr = captureStderr(child);
  const exited = exitOf(child);
  const ready = await waitMessage(child, (m) => m.type === 'ready', 180_000, `${label} ready`);
  log(`host ${label} ready (pid ${String(ready.pid)})`);
  return { label, box, child, stderr, exited, ready, events };
}

async function stopHost(host: Host) {
  host.child.send({ type: 'shutdown' });
  const graceful = await stopWithin(host.exited, 30_000);
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
  return { graceful, exit: await host.exited };
}

async function runTurn(host: Host, sessionId: string, text: string, timeoutMs = 90_000) {
  const started = performance.now();
  await call(host, 'prompt', { sessionId, text });
  const idle = await call(host, 'wait-idle', { sessionId, timeoutMs }, timeoutMs + 5_000);
  return { idle: idle.idle === true, ms: Math.round(performance.now() - started) };
}

async function newSession(host: Host, sessionId: string) {
  await call(host, 'create-session', { sessionId, cwd: host.box.workspace });
  return sessionId;
}

// ---- reading the logs ------------------------------------------------------------

interface SessionView {
  events: Line[];
  types: string[];
  turnEnds: Line[];
  attempts: number;
  toolCalls: string[];
  toolResults: Array<{ text: string; isError: boolean }>;
  userSources: string[];
  retries: number;
}

function sessionView(host: Host, sessionId: string): SessionView {
  const events = readLines(host.events).filter(
    (line) => line.kind === 'session' && line.sessionId === sessionId
  );
  const data = (line: Line) =>
    (typeof line.data === 'object' && line.data ? line.data : {}) as Line;
  const textOf = (content: unknown) =>
    Array.isArray(content)
      ? content.map((block) => String((block as { text?: unknown })?.text ?? '')).join('')
      : String(content ?? '');
  return {
    events,
    types: events.map((line) => String(line.type)),
    turnEnds: events.filter((line) => line.type === 'turn/end').map((line) => data(line)),
    attempts: events.filter((line) => line.type === 'assistant/attempt').length,
    toolCalls: events
      .filter((line) => line.type === 'tool/call')
      .map((line) => String((data(line).name ?? data(line).toolName ?? '') as string)),
    toolResults: events
      .filter((line) => line.type === 'tool/result')
      .map((line) => {
        const message = (data(line).message ?? {}) as Line;
        return { text: textOf(message.content), isError: message.isError === true };
      }),
    userSources: events
      .filter((line) => line.type === 'user/message')
      .map((line) => String(((data(line).source ?? {}) as Line).kind ?? '')),
    retries: events.filter((line) => line.type === 'llm/retry').length,
  };
}

/** Sessions the probe did not create (subagent children), by id. */
function otherSessions(host: Host, known: Set<string>): string[] {
  return [
    ...new Set(
      readLines(host.events)
        .filter((line) => line.kind === 'session' && !known.has(String(line.sessionId)))
        .map((line) => String(line.sessionId))
    ),
  ];
}

const reasonOf = (turnEnd: Line | undefined) => (turnEnd?.reason ?? {}) as Line;
const errorCodeOf = (turnEnd: Line | undefined) =>
  String(((reasonOf(turnEnd).error ?? {}) as Line).code ?? '');
const isCeilingAbort = (turnEnd: Line | undefined) => {
  const reason = reasonOf(turnEnd);
  const cause = (reason.reason ?? {}) as Line;
  return (
    reason.kind === 'aborted' && cause.kind === 'hook' && cause.reason === 'aiclient-turn-ceiling'
  );
};

function gatewayRequests(root: string, pattern: RegExp): Line[] {
  return readLines(join(root, 'gateway.jsonl')).filter(
    (line) => line.event === undefined && pattern.test(String(line.decision ?? ''))
  );
}

function gatewayClose(root: string, seq: unknown): Line | undefined {
  return readLines(join(root, 'gateway.jsonl')).find(
    (line) => line.event === 'client-closed' && line.seq === seq
  );
}

function approvals(host: Host): Line[] {
  return readLines(host.events).filter((line) => line.kind === 'approval');
}

// ---- hosts ---------------------------------------------------------------------------

async function hostA(port: number, gatewayRoot: string) {
  const host = await startHost('a', port, ceilingPatch, {}, ALWAYS_RETRY);
  const facts: Line = { census: host.ready.census };
  const known = new Set<string>();
  const session = async (id: string) => {
    known.add(id);
    return newSession(host, id);
  };
  try {
    // G1 / E1 / E2
    const g1 = await session('p8-g1');
    facts.g1Turn = await runTurn(
      host,
      g1,
      'P8-REPEAT {"tag":"g1","count":200,"chunkMs":15} list the jobs.'
    );
    const g1View = sessionView(host, g1);
    const g1Requests = gatewayRequests(gatewayRoot, /^P8-REPEAT:g1 /);
    facts.g1 = {
      requests: g1Requests.length,
      close: gatewayClose(gatewayRoot, g1Requests[0]?.seq),
      attempts: g1View.attempts,
      toolCalls: g1View.toolCalls.length,
      toolResults: g1View.toolResults.length,
      retries: g1View.retries,
      turnEnd: g1View.turnEnds[0],
    };
    facts.g1Recall = await runTurn(
      host,
      g1,
      'P0-RECALL {"markers":["Checking the background work."]} is the cut reply still there?'
    );
    facts.g1RecallDecision = gatewayRequests(gatewayRoot, /^RECALL/).at(-1)?.decision;

    // E1 control: mode always really retries an ordinary failure.
    const ctl = await session('p8-fail-control');
    await call(host, 'prompt', { sessionId: ctl, text: 'P1-FAIL control' });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && gatewayRequests(gatewayRoot, /^P1-FAIL/).length < 3) {
      await sleep(200);
    }
    await call(host, 'close-session', { sessionId: ctl });
    facts.failControl = {
      requests: gatewayRequests(gatewayRoot, /^P1-FAIL/).length,
      retries: sessionView(host, ctl).retries,
    };

    // G2
    const g2 = await session('p8-g2');
    facts.g2Turn = await runTurn(
      host,
      g2,
      'P8-VARIED {"tag":"g2","count":40,"chunkMs":10} read them.'
    );
    const g2View = sessionView(host, g2);
    const g2Requests = gatewayRequests(gatewayRoot, /^P8-VARIED:g2 /);
    facts.g2 = {
      requests: g2Requests.length,
      close: gatewayClose(gatewayRoot, g2Requests[0]?.seq),
      toolCalls: g2View.toolCalls.length,
      turnEnd: g2View.turnEnds[0],
    };

    // G3
    const g3 = await session('p8-g3');
    facts.g3Turn = await runTurn(host, g3, 'P8-FANOUT {"tag":"g3","count":10} fan out.', 180_000);
    const g3View = sessionView(host, g3);
    facts.g3 = {
      toolCalls: g3View.toolCalls,
      toolErrors: g3View.toolResults.filter((result) => result.isError).length,
      attempts: g3View.attempts,
      turnEnds: g3View.turnEnds,
    };

    // G7 / E3: the cut and the ceiling inside a child.
    const earlierChildren = new Set(otherSessions(host, known));
    const g7 = await session('p8-g7');
    facts.g7Turn = await runTurn(
      host,
      g7,
      'P8-SUBREPEAT {"tag":"g7","count":60} delegate.',
      120_000
    );
    const g7b = await session('p8-g7b');
    facts.g7bTurn = await runTurn(
      host,
      g7b,
      'P8-SUBREPEAT {"tag":"g7b","child":"LOOP"} delegate.',
      120_000
    );
    const children = otherSessions(host, known)
      .filter((id) => !earlierChildren.has(id))
      .map((id) => ({ id, view: sessionView(host, id) }));
    facts.g7 = {
      parent: sessionView(host, g7).turnEnds,
      parentResult: sessionView(host, g7).toolResults.map((result) => ({
        isError: result.isError,
        text: result.text.slice(0, 300),
      })),
      parentB: sessionView(host, g7b).turnEnds,
      children: children.map(({ id, view }) => ({
        id,
        attempts: view.attempts,
        toolCalls: view.toolCalls.length,
        turnEnds: view.turnEnds,
      })),
    };

    // G4 / E4 / E5: the ceiling, a wrap-up that still tries a tool.
    const g4 = await session('p8-g4');
    facts.g4Turn = await runTurn(host, g4, 'P8-LOOP {"tag":"g4","wrapTool":true} keep reading.');
    const g4View = sessionView(host, g4);
    const g4Requests = gatewayRequests(gatewayRoot, /^P8-LOOP:g4 /);
    facts.g4 = {
      requests: g4Requests.map((line) => ({ decision: line.decision, tools: line.tools })),
      toolCalls: g4View.toolCalls,
      toolResults: g4View.toolResults.map((result) => ({
        isError: result.isError,
        text: result.text.slice(0, 200),
      })),
      userSources: g4View.userSources,
      turnEnds: g4View.turnEnds,
      bashApprovals: approvals(host).filter((line) => line.toolName === 'bash'),
      wrapToolRan: existsSync(join(host.box.workspace, 'p8-wrap-tool.txt')),
    };
    const g4b = await session('p8-g4b');
    facts.g4bTurn = await runTurn(host, g4b, 'P8-LOOP {"tag":"g4b"} keep reading.');
    const g4bView = sessionView(host, g4b);
    facts.g4b = {
      requests: gatewayRequests(gatewayRoot, /^P8-LOOP:g4b /).map((line) => line.decision),
      turnEnds: g4bView.turnEnds,
    };

    // G5 / E6: notices after the ceiling, then a new count.
    const g5 = await session('p8-g5');
    facts.g5Turn = await runTurn(
      host,
      g5,
      'P8-WAKE {"tag":"g5","jobs":2,"seconds":3} start the jobs, then keep reading.'
    );
    const firstTurnRequests = gatewayRequests(gatewayRoot, /^P8-WAKE:g5 /).length;
    // Both jobs end within 3 + 4 s; each notice wakes the idle agent once.
    await sleep(9_000);
    await call(host, 'wait-idle', { sessionId: g5, timeoutMs: 30_000 }, 35_000);
    await sleep(1_000);
    await call(host, 'wait-idle', { sessionId: g5, timeoutMs: 30_000 }, 35_000);
    const afterNotices = sessionView(host, g5);
    const wakeRequests = gatewayRequests(gatewayRoot, /^P8-WAKE:g5 /);
    facts.g5 = {
      firstTurnRequests,
      noticeRequests: wakeRequests.slice(firstTurnRequests).map((line) => line.decision),
      turnEnds: afterNotices.turnEnds,
      userSources: afterNotices.userSources,
      toolResultsAfterFirstTurn: afterNotices.toolResults.length,
    };
    facts.g5EpochTurn = await runTurn(host, g5, 'P8-LOOP {"tag":"g5-epoch"} read again.');
    const epoch = sessionView(host, g5);
    facts.g5Epoch = {
      requests: gatewayRequests(gatewayRoot, /^P8-LOOP:g5-epoch /).map((line) => line.decision),
      lastTurnEnd: epoch.turnEnds.at(-1),
    };
  } finally {
    facts.stop = await stopHost(host);
    facts.stderrTail = host.stderr().slice(-3000);
  }
  return facts;
}

async function hostB(port: number, gatewayRoot: string) {
  const host = await startHost('b', port, ceilingPatch, { AICLIENT_RUNTIME_LOOP_GUARD: '0' });
  const facts: Line = { census: host.ready.census };
  try {
    const g6 = await newSession(host, 'p8-g6');
    facts.g6Turn = await runTurn(host, g6, 'P8-REPEAT {"tag":"g6","count":30,"chunkMs":5} list.');
    const view = sessionView(host, g6);
    facts.g6 = {
      requests: gatewayRequests(gatewayRoot, /^P8-REPEAT:g6 /).map((line) => line.decision),
      toolCalls: view.toolCalls.length,
      attempts: view.attempts,
      turnEnds: view.turnEnds,
    };
    const g6b = await newSession(host, 'p8-g6b');
    facts.g6bTurn = await runTurn(host, g6b, 'P8-LOOP {"tag":"g6b","max":6} read six times.');
    const loop = sessionView(host, g6b);
    facts.g6b = {
      requests: gatewayRequests(gatewayRoot, /^P8-LOOP:g6b /).map((line) => line.decision),
      toolResults: loop.toolResults.length,
      userSources: loop.userSources,
      turnEnds: loop.turnEnds,
    };
  } finally {
    facts.stop = await stopHost(host);
    facts.stderrTail = host.stderr().slice(-1500);
  }
  return facts;
}

async function hostC(port: number, gatewayRoot: string) {
  const host = await startHost(
    'c',
    port,
    `${ceilingPatch}- id: aiclient-permissions\n  disabled: false\n`,
    {},
    NORMAL_RETRY
  );
  const facts: Line = { census: host.ready.census };
  try {
    const e1 = await newSession(host, 'p8-e1b');
    facts.e1bTurn = await runTurn(
      host,
      e1,
      'P8-REPEAT {"tag":"e1b","count":50,"chunkMs":10} list.'
    );
    const e1View = sessionView(host, e1);
    facts.e1b = {
      requests: gatewayRequests(gatewayRoot, /^P8-REPEAT:e1b /).length,
      retries: e1View.retries,
      turnEnd: e1View.turnEnds[0],
    };
    const e5 = await newSession(host, 'p8-e5b');
    facts.e5bTurn = await runTurn(host, e5, 'P8-LOOP {"tag":"e5b","wrapTool":true} keep reading.');
    const e5View = sessionView(host, e5);
    facts.e5b = {
      toolResults: e5View.toolResults.map((result) => ({
        isError: result.isError,
        text: result.text.slice(0, 160),
      })),
      turnEnds: e5View.turnEnds,
      approvals: approvals(host),
    };
  } finally {
    facts.stop = await stopHost(host);
    facts.stderrTail = host.stderr().slice(-1500);
  }
  return facts;
}

// ---- verdict ---------------------------------------------------------------------------

function verdictOf(report: Line): Record<string, boolean> {
  const a = (report.a ?? {}) as Line;
  const b = (report.b ?? {}) as Line;
  const c = (report.c ?? {}) as Line;
  const v: Record<string, boolean> = {};
  const inactive = (facts: Line) =>
    ((facts.census as Line | undefined)?.inactive ?? []) as unknown[];
  if (report.a) {
    const g1 = a.g1 as Line;
    const close = (g1.close ?? {}) as Line;
    v.aAllRowsActive = inactive(a).length === 0;
    v.g1OneRequest = g1.requests === 1;
    v.g1UpstreamClosedAtThird =
      close.event === 'client-closed' &&
      Number(close.toolBlocksSent) >= 3 &&
      Number(close.toolBlocksSent) <= 5 &&
      Number(close.toolBlocksTotal) === 200;
    v.g1Attempt = g1.attempts === 1;
    v.g1ZeroExecution = g1.toolCalls === 0 && g1.toolResults === 0;
    v.g1NotRetried = g1.retries === 0;
    v.g1TurnEndRepetition = errorCodeOf(g1.turnEnd as Line) === 'tool_call_repetition';
    v.g1CutReplyOutOfContext = String(a.g1RecallDecision).includes(
      'missing=Checking the background work.'
    );
    const ctl = a.failControl as Line;
    v.e1ControlAlwaysRetries = Number(ctl.requests) >= 2 && Number(ctl.retries) >= 1;
    const g2 = a.g2 as Line;
    const g2Close = (g2.close ?? {}) as Line;
    v.g2CutAtSeventeenth =
      g2.requests === 1 &&
      Number(g2Close.toolBlocksSent) >= 17 &&
      Number(g2Close.toolBlocksSent) <= 19 &&
      g2.toolCalls === 0 &&
      errorCodeOf(g2.turnEnd as Line) === 'tool_call_repetition' &&
      String(((reasonOf(g2.turnEnd as Line).error ?? {}) as Line).message).includes(
        '17 subagent tool calls'
      );
    const g3 = a.g3 as Line;
    const g3Ends = (g3.turnEnds ?? []) as Line[];
    v.g3FanOutRuns =
      (g3.toolCalls as string[]).filter((name) => name === 'subagent').length === 10 &&
      g3.toolErrors === 0 &&
      g3.attempts === 0 &&
      reasonOf(g3Ends.at(-1)).kind === 'completed';
    const g7 = a.g7 as Line;
    const children = (g7.children ?? []) as Line[];
    v.g7ChildReplyCut = children.some(
      (child) =>
        Number(child.attempts) === 1 &&
        Number(child.toolCalls) === 0 &&
        ((child.turnEnds ?? []) as Line[]).some(
          (end) => errorCodeOf(end) === 'tool_call_repetition'
        )
    );
    v.g7ParentCompletes = reasonOf(((g7.parent ?? []) as Line[]).at(-1)).kind === 'completed';
    v.g7ChildCeiling = children.some((child) =>
      ((child.turnEnds ?? []) as Line[]).some((end) => isCeilingAbort(end))
    );
    const g4 = a.g4 as Line;
    const g4Requests = (g4.requests ?? []) as Line[];
    const g4Results = (g4.toolResults ?? []) as Line[];
    v.g4ThreeStepsThenWrapUp =
      g4Requests.length === 4 &&
      String(g4Requests[3]?.decision).endsWith('wrap-up tool') &&
      Number(g4Requests[3]?.tools) > 0;
    v.g4WrapUpCallRefused =
      g4Results.length === 4 &&
      g4Results.slice(0, 3).every((result) => result.isError === false) &&
      g4Results[3]?.isError === true &&
      String(g4Results[3]?.text).includes(REFUSAL) &&
      g4.wrapToolRan === false;
    v.g4NoApprovalAsked = ((g4.bashApprovals ?? []) as Line[]).length === 0;
    v.g4InstructionFromGuard = ((g4.userSources ?? []) as string[]).includes('aiclient-loop-guard');
    v.g4EndsTurnLimit = isCeilingAbort(((g4.turnEnds ?? []) as Line[]).at(-1));
    const g4b = a.g4b as Line;
    v.g4bTextWrapUp =
      ((g4b.requests ?? []) as string[]).length === 4 &&
      String(((g4b.requests ?? []) as string[])[3]).endsWith('wrap-up') &&
      isCeilingAbort(((g4b.turnEnds ?? []) as Line[]).at(-1));
    const g5 = a.g5 as Line;
    const notices = (g5.noticeRequests ?? []) as string[];
    const g5Sources = (g5.userSources ?? []) as string[];
    v.g5FirstTurnCapped = g5.firstTurnRequests === CEILING + 1;
    v.g5NoticesBounded =
      notices.length >= 1 && notices.length <= 2 && notices.every((d) => d.endsWith('wrap-up'));
    v.g5NoticesKept = g5Sources.filter((kind) => kind === 'tool-jobs').length === 2;
    v.g5NoticeTurnsWrapUp = ((g5.turnEnds ?? []) as Line[]).every((end) => isCeilingAbort(end));
    const epoch = a.g5Epoch as Line;
    const epochRequests = (epoch.requests ?? []) as string[];
    v.g5UserOpensNewCount =
      epochRequests.length === CEILING + 1 &&
      epochRequests.slice(0, CEILING).every((d) => !d.endsWith('wrap-up')) &&
      isCeilingAbort(epoch.lastTurnEnd as Line);
  }
  if (report.b) {
    v.bAllRowsActive = inactive(b).length === 0;
    const g6 = b.g6 as Line;
    v.g6SwitchOffNoCut =
      g6.toolCalls === 30 &&
      g6.attempts === 0 &&
      reasonOf(((g6.turnEnds ?? []) as Line[]).at(-1)).kind === 'completed';
    const g6b = b.g6b as Line;
    v.g6SwitchOffNoCeiling =
      g6b.toolResults === 6 &&
      !((g6b.userSources ?? []) as string[]).includes('aiclient-loop-guard') &&
      reasonOf(((g6b.turnEnds ?? []) as Line[]).at(-1)).kind === 'completed';
  }
  if (report.c) {
    v.cAllRowsActive = inactive(c).length === 0;
    const e1 = c.e1b as Line;
    v.e1bNormalModeNotRetried =
      e1.requests === 1 &&
      e1.retries === 0 &&
      errorCodeOf(e1.turnEnd as Line) === 'tool_call_repetition';
    const e5 = c.e5b as Line;
    const results = (e5.toolResults ?? []) as Line[];
    v.e5bGuardRefusesBeforePermissionRow =
      results.length === 4 &&
      results.slice(0, 3).every((r) => String(r.text).includes('permission gate')) &&
      String(results[3]?.text).includes(REFUSAL) &&
      isCeilingAbort(((e5.turnEnds ?? []) as Line[]).at(-1));
  }
  return v;
}

async function main(): Promise<number> {
  const available = availableMb();
  if (available < MIN_AVAILABLE_MB) {
    log(`only ${Math.round(available)} MB available; not starting`);
    return 2;
  }
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const gatewayRoot = join(scratchRoot, 'gateway');
  mkdirSync(gatewayRoot, { recursive: true });
  const gateway = await startGateway(gatewayRoot);
  const report: Line = {
    node: nodeBin,
    ceiling: CEILING,
    availableMb: Math.round(available),
    ceilingInstruction: CEILING_TEXT,
  };
  try {
    for (const [label, run] of [
      ['a', hostA],
      ['b', hostB],
      ['c', hostC],
    ] as const) {
      if (only && only !== label) continue;
      try {
        report[label] = await run(gateway.port, gatewayRoot);
      } catch (error) {
        report[label] = { error: error instanceof Error ? error.stack : String(error) };
      }
    }
  } finally {
    gateway.child.kill('SIGTERM');
  }
  report.verdict = verdictOf(report);
  const failed = Object.entries(report.verdict as Record<string, boolean>)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  report.failed = failed;
  const json = `${JSON.stringify(report, null, 2)}\n`.split(scratchRoot).join('<scratch>');
  if (outFile) writeFileSync(outFile, json);
  process.stdout.write(json);
  log(failed.length === 0 ? 'all checks passed' : `failed: ${failed.join(', ')}`);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
  else log(`kept ${scratchRoot}`);
  return failed.length === 0 && !['a', 'b', 'c'].some((k) => (report[k] as Line)?.error) ? 0 : 1;
}

process.exitCode = await main();
