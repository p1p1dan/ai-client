/**
 * P0-2 driver: goal mode, todo, jobs and one community plugin on the DSH host,
 * with every model request answered by the local fake gateway (dsh-p0-2 plan).
 *
 *   node goal-probe.ts [--trace] [--keep] [--out file.json]
 *
 * Scenarios, each in its own session:
 *   ENV             bash prints .env canaries (which .env files reach tools)
 *   APPROVAL        write outside the workspace -> approval/request -> allowed once
 *   GOAL-COMPLETE   create_goal -> round 1 (todo, bash) -> round 2 (verify, complete)
 *   GOAL-BLOCKED    rounds 1-2 try `blocked` and are refused; round 3 blocks
 *   GOAL-ROUNDLIMIT two rounds without progress; the driver blocks at the cap
 *   GOAL-PAUSE      `/goal <objective>` -> round 1 runs `sleep 8` -> `/goal pause`
 *                   mid-tool -> paused; `/goal resume` -> round 2 completes
 *   JOBS            bash run_in_background -> job_list -> job_output
 *   OFFICE          plugin-manager installs dsh-office-tools, host restarts,
 *                   word_create + word_read
 *
 * Child processes are captured three ways as in P0-1: /proc tree sampling,
 * the probe-hooks spawn log, and (with --trace) `strace -f`. No real provider
 * is reachable: the host's only model route points at the fake gateway, the
 * probe hooks block every non-loopback connect, and the only other network
 * user is pnpm talking to registry.npmjs.org during the plugin install.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  baseEnv,
  captureStderr,
  exitOf,
  launch,
  parseStrace,
  psSnapshot,
  readHookLog,
  round,
  type Sandbox,
  type SeenProcess,
  sandbox,
  sleep,
  stopWithin,
  summarizeHooks,
  treeSampler,
  waitMessage,
  waitQuiet,
} from './lib/kit.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const hostEntry = join(here, 'host.ts');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const pnpmCli = join(here, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
const gatewayEntry = join(
  repoRoot,
  'docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/fake-gateway.mjs'
);
const bundledNode = join(repoRoot, 'out-node-runtime', 'node');

const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const nodeBin = option('node', existsSync(bundledNode) ? bundledNode : process.execPath);
const trace = argv.includes('--trace');
const keep = argv.includes('--keep');
const outFile = option('out', '');
const plugin = option('plugin', 'dsh-office-tools@1.0.4');
const scratchRoot = join('/var/tmp', `aiclient-dsh-p0-2-${Date.now()}`);
const log = (message: string) => process.stderr.write(`[goal-probe] ${message}\n`);

const TERMINAL = new Set(['complete', 'blocked', 'paused']);

// ---- processes -----------------------------------------------------------

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
  return { port, child, logFile };
}

interface Host {
  label: string;
  child: ChildProcess;
  hostPid: number;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
  sampler: { stop: () => SeenProcess[] };
  traceFile?: string;
  readyMs: number;
  census: unknown;
}

let requestSeq = 0;

async function call(
  host: Host,
  type: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 60_000
): Promise<Record<string, unknown>> {
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

async function startHost(
  label: string,
  box: Sandbox,
  hostCwd: string,
  gateway: Gateway,
  eventLog: string,
  t0: number
): Promise<Host> {
  const env = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AICLIENT_DSH_GATEWAY_URL: `http://127.0.0.1:${gateway.port}`,
    AICLIENT_PROBE_EVENT_LOG: eventLog,
    AICLIENT_DSH_PNPM_CLI: pnpmCli,
  };
  const traceFile = trace ? join(box.root, `strace-${label}.log`) : undefined;
  const started = performance.now();
  const child = launch(
    [nodeBin, '--expose-internals', '--import', hooksEntry, hostEntry],
    env,
    hostCwd,
    traceFile
  );
  const stderr = captureStderr(child);
  const exited = exitOf(child);
  const sampler = treeSampler(child.pid as number, t0);
  const ready = await waitMessage(child, (m) => m.type === 'ready', 180_000, `${label} ready`);
  return {
    label,
    child,
    hostPid: ready.pid as number,
    stderr,
    exited,
    sampler,
    traceFile,
    readyMs: round(performance.now() - started, 0),
    census: ready.census,
  };
}

async function stopHost(host: Host) {
  const counts: Record<string, unknown> = await call(host, 'dispatch-counts').catch((error) => ({
    error: String(error),
  }));
  host.child.send({ type: 'shutdown' });
  const graceful = await stopWithin(host.exited, 30_000);
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
  const exit = await host.exited;
  await sleep(500);
  const children = host.sampler.stop();
  return {
    graceful,
    exit,
    counts: counts.counts ?? counts,
    children,
    leftover: children.filter((row) => existsSync(`/proc/${row.pid}`)).map((row) => row.cmd),
    stderrTail: host.stderr().slice(-4000),
  };
}

// ---- scenario helpers ----------------------------------------------------

interface GoalPoint {
  tMs: number;
  phase?: string;
  roundsStarted?: number;
  revision?: number;
  blockedReason?: unknown;
  activation?: unknown;
}

async function goalOf(host: Host, sessionId: string) {
  const answer = await call(host, 'goal', { sessionId });
  return answer.goal as Record<string, unknown> | null;
}

/** Poll the goal until `done` holds; keep every distinct observation. */
async function followGoal(
  host: Host,
  sessionId: string,
  done: (goal: Record<string, unknown> | null) => boolean,
  timeoutMs: number,
  t0: number
) {
  const points: GoalPoint[] = [];
  const deadline = performance.now() + timeoutMs;
  let goal: Record<string, unknown> | null = null;
  while (performance.now() < deadline) {
    goal = await goalOf(host, sessionId);
    const point = {
      tMs: round(performance.now() - t0, 0),
      phase: goal?.phase as string | undefined,
      roundsStarted: goal?.roundsStarted as number | undefined,
      revision: goal?.revision as number | undefined,
      blockedReason: goal?.blockedReason,
      activation: goal?.activation,
    };
    const last = points.at(-1);
    if (
      !last ||
      last.phase !== point.phase ||
      last.roundsStarted !== point.roundsStarted ||
      last.revision !== point.revision ||
      JSON.stringify(last.activation) !== JSON.stringify(point.activation)
    ) {
      points.push(point);
    }
    if (done(goal)) return { reached: true, goal, points };
    await sleep(300);
  }
  return { reached: false, goal, points };
}

async function waitIdle(host: Host, sessionId: string, timeoutMs = 90_000) {
  await sleep(400);
  return call(host, 'wait-idle', { sessionId, timeoutMs }, timeoutMs + 5_000);
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function gatewayDecisions(file: string, prefix: string) {
  return readJsonl(file)
    .filter((line) => String(line.decision ?? '').startsWith(prefix))
    .map((line) => `${line.seq} ${line.decision}${line.tool ? ` -> ${line.tool}` : ' -> text'}`);
}

async function waitForDecision(file: string, decision: string, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (readJsonl(file).some((line) => line.decision === decision)) return true;
    await sleep(200);
  }
  return false;
}

/** Compact per-event lines for the evidence transcript excerpts. */
function transcript(events: Array<Record<string, unknown>>, sessionId: string) {
  return events
    .filter((e) => e.kind === 'session' && e.sessionId === sessionId)
    .map((e) => {
      const data = e.data as Record<string, unknown> | string;
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      return `#${e.seq} ${e.type}${e.surfaceOp ? ` [${e.surfaceOp}]` : ''} ${text.slice(0, 240)}`;
    });
}

// ---- main ----------------------------------------------------------------

async function main() {
  await waitQuiet();
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  log(`scratch ${scratchRoot}; node ${nodeBin}; trace ${trace}`);
  const t0 = performance.now();
  const box = sandbox(scratchRoot, 'run');
  const hostCwd = join(box.root, 'host-cwd');
  mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
  const eventLog = join(box.root, 'events.jsonl');

  // .env canaries in the three places a DSH launch or tool might read them.
  // The gateway key lives only in the host cwd's .env, so every request that
  // authenticates proves that file feeds the credential chain; the workspace
  // .env carries a different key value that must never reach the gateway.
  writeFileSync(
    join(hostCwd, '.env'),
    'P0_HOSTCWD_CANARY=from-host-cwd-dotenv\nAICLIENT_DSH_GATEWAY_KEY=p0-key-from-host-cwd-dotenv\n'
  );
  writeFileSync(
    join(box.workspace, '.env'),
    'P0_WS_CANARY=from-workspace-dotenv\nAICLIENT_DSH_GATEWAY_KEY=p0-key-from-workspace-dotenv\n'
  );
  writeFileSync(join(box.dshHome, '.env'), 'P0_DSHHOME_CANARY=from-dsh-home-dotenv\n');

  const gateway = await startGateway(box.root);
  log(`fake gateway on ${gateway.port}`);
  const report: Record<string, unknown> = {
    probe: 'P0-2 goal, todo, jobs, community plugin',
    startedAt: new Date().toISOString(),
    node: nodeBin,
    trace,
    plugin,
    gatewayPort: gateway.port,
  };
  const scenarios: Record<string, Record<string, unknown>> = {};
  const hosts: Array<Record<string, unknown>> = [];

  let host = await startHost('host-1', box, hostCwd, gateway, eventLog, t0);
  log(`host-1 ready in ${host.readyMs} ms`);
  report.toolsBeforeInstall = (await call(host, 'tools')).names;

  const session = async (label: string) => {
    const answer = await call(host, 'create-session', {
      sessionId: `p0-2-${label.toLowerCase()}`,
      cwd: box.workspace,
    });
    return answer.sessionId as string;
  };

  // ENV
  {
    const id = await session('ENV');
    await call(host, 'prompt', { sessionId: id, text: 'P0-ENV: print the env canaries.' });
    const idle = await waitIdle(host, id);
    scenarios.ENV = { sessionId: id, idle };
  }

  // APPROVAL: a write outside the workspace under workspace-write asks the
  // answerer chain; the probe's stand-in answerer allows it once.
  {
    const outside = join(box.root, 'outside');
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    const target = join(outside, 'approved.txt');
    const id = await session('APPROVAL');
    await call(host, 'prompt', {
      sessionId: id,
      text: `P0-APPROVAL: write a file outside the workspace, path=${target}`,
    });
    const idle = await waitIdle(host, id);
    scenarios.APPROVAL = {
      sessionId: id,
      written: existsSync(target) ? readFileSync(target, 'utf8') : null,
      idle,
    };
  }

  // Human-created goals that must reach a terminal phase on their own.
  const goalScenario = async (label: string, text: string, expect: string) => {
    const id = await session(label);
    await call(host, 'prompt', { sessionId: id, text });
    const followed = await followGoal(
      host,
      id,
      (goal) => TERMINAL.has(String(goal?.phase)),
      150_000,
      t0
    );
    const idle = await waitIdle(host, id);
    // Settle: a terminal goal must not start further rounds.
    const roundsAtTerminal = followed.goal?.roundsStarted;
    await sleep(3000);
    const after = await goalOf(host, id);
    scenarios[label] = {
      sessionId: id,
      expect,
      reached: followed.reached,
      final: followed.goal,
      timeline: followed.points,
      noFurtherRounds: after?.roundsStarted === roundsAtTerminal,
      idle,
    };
    log(`${label}: ${String(followed.goal?.phase)} after ${String(roundsAtTerminal)} rounds`);
  };

  await goalScenario(
    'GOAL-COMPLETE',
    'P0-GOAL-COMPLETE: make progress.txt in the workspace and verify it; keep going until done.',
    'complete'
  );
  await goalScenario(
    'GOAL-BLOCKED',
    'P0-GOAL-BLOCKED: load /nonexistent/p0-config.json and apply it; keep trying until done.',
    'blocked'
  );
  await goalScenario(
    'GOAL-ROUNDLIMIT',
    'P0-GOAL-ROUNDLIMIT: keep polishing; this is a long-running objective.',
    'blocked (round-limit)'
  );

  // GOAL-PAUSE: slash-command create, host-side pause while a tool runs, resume.
  {
    const id = await session('GOAL-PAUSE');
    const created = await call(host, 'command', {
      sessionId: id,
      line: '/goal P0-GOAL-PAUSE: run the slow check, then finish',
    });
    const bashIssued = await waitForDecision(gateway.logFile, 'GOAL-PAUSE r1 s0', 60_000);
    await sleep(1500);
    const treeWhileRunning = psSnapshot(host.child.pid as number);
    const pausedCommand = await call(host, 'command', { sessionId: id, line: '/goal pause' });
    const paused = await followGoal(host, id, (goal) => goal?.phase === 'paused', 30_000, t0);
    const idleAfterPause = await waitIdle(host, id, 30_000);
    await sleep(1000);
    const treeAfterPause = psSnapshot(host.child.pid as number);
    const requestsBefore = readJsonl(gateway.logFile).length;
    await sleep(4000);
    const quiet = {
      roundsStarted: (await goalOf(host, id))?.roundsStarted,
      newGatewayRequests: readJsonl(gateway.logFile).length - requestsBefore,
    };
    const resumedCommand = await call(host, 'command', { sessionId: id, line: '/goal resume' });
    const resumed = await followGoal(host, id, (goal) => goal?.phase === 'complete', 90_000, t0);
    const idle = await waitIdle(host, id);
    scenarios['GOAL-PAUSE'] = {
      sessionId: id,
      created: created.result,
      bashIssued,
      treeWhileRunning,
      pausedCommand: pausedCommand.result,
      paused: { reached: paused.reached, final: paused.goal, timeline: paused.points },
      idleAfterPause,
      treeAfterPause,
      quietWhilePaused: quiet,
      resumedCommand: resumedCommand.result,
      resumed: { reached: resumed.reached, final: resumed.goal, timeline: resumed.points },
      idle,
    };
    log(`GOAL-PAUSE: paused=${paused.reached} resumed-complete=${resumed.reached}`);
  }

  // JOBS
  {
    const id = await session('JOBS');
    await call(host, 'prompt', { sessionId: id, text: 'P0-JOBS: run a background ticker.' });
    await sleep(1200);
    const treeWhileRunning = psSnapshot(host.child.pid as number);
    const idle = await waitIdle(host, id);
    scenarios.JOBS = { sessionId: id, treeWhileRunning, idle };
  }

  // OFFICE: install through the plugin manager, restart, use the tools.
  {
    const install = await call(
      host,
      'install-bundle',
      { spec: plugin, registry: 'https://registry.npmjs.org/' },
      600_000
    );
    hosts.push({
      label: host.label,
      readyMs: host.readyMs,
      census: host.census,
      ...(await stopHost(host)),
    });
    host = await startHost('host-2', box, hostCwd, gateway, eventLog, t0);
    log(`host-2 ready in ${host.readyMs} ms`);
    const tools = (await call(host, 'tools')).names as string[];
    const id = await session('OFFICE');
    await call(host, 'prompt', { sessionId: id, text: 'P0-OFFICE: create the report document.' });
    const idle = await waitIdle(host, id);
    const docx = join(box.workspace, 'p0-report.docx');
    scenarios.OFFICE = {
      sessionId: id,
      install: install.result,
      officeToolsAfterRestart: tools.filter((name) => /^(word|excel|ppt)_/.test(name)),
      docx: existsSync(docx) ? { bytes: statSync(docx).size } : null,
      idle,
    };
  }
  hosts.push({
    label: host.label,
    readyMs: host.readyMs,
    census: host.census,
    ...(await stopHost(host)),
  });
  gateway.child.kill('SIGTERM');

  // ---- collect ----------------------------------------------------------
  const events = readJsonl(eventLog);
  const sessionTypes: Record<string, number> = {};
  const surfaceOps: Record<string, string[]> = {};
  for (const event of events.filter((e) => e.kind === 'session')) {
    const type = String(event.type);
    sessionTypes[type] = (sessionTypes[type] ?? 0) + 1;
    if (event.surfaceOp) {
      surfaceOps[type] = [...new Set([...(surfaceOps[type] ?? []), String(event.surfaceOp)])];
    }
  }
  const dispatch: Record<string, Record<string, number>> = {};
  for (const h of hosts) {
    for (const [name, modes] of Object.entries(
      (h.counts ?? {}) as Record<string, Record<string, number>>
    )) {
      dispatch[name] ??= {};
      for (const [mode, count] of Object.entries(modes)) {
        dispatch[name][mode] = (dispatch[name][mode] ?? 0) + count;
      }
    }
  }
  for (const [label, scenario] of Object.entries(scenarios)) {
    scenario.transcript = transcript(events, String(scenario.sessionId));
    scenario.gateway = gatewayDecisions(gateway.logFile, label === 'ENV' ? 'ENV' : label);
  }
  const gatewayLines = readJsonl(gateway.logFile);
  const hookRecords = readHookLog(box.hookLog);
  report.scenarios = scenarios;
  report.hosts = hosts.map((h) => ({ ...h, counts: undefined }));
  report.events = {
    sessionEventTypes: sessionTypes,
    surfaceOps,
    cordisDispatch: dispatch,
    approvals: events.filter((e) => e.kind === 'approval'),
    timeline: events.filter((e) => e.kind === 'cordis').slice(0, 400),
  };
  report.gateway = {
    requests: gatewayLines.length,
    authValues: [...new Set(gatewayLines.map((line) => String(line.auth)))],
    paths: [...new Set(gatewayLines.map((line) => String(line.path)))],
    toolsOffered: [...new Set(gatewayLines.map((line) => line.tools))],
  };
  report.hooks = summarizeHooks(hookRecords);
  if (trace) {
    report.strace = hosts.map((h, index) => {
      const file = join(box.root, `strace-host-${index + 1}.log`);
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const dotenv = [
        ...new Set(
          [...text.matchAll(/openat\(AT_FDCWD, "([^"]*\.env)", [^)]*\) = (-?\d+[^\n]*)/g)].map(
            (m) =>
              `${m[1].replace(box.root, '<run>')} => ${m[2].startsWith('-1') ? m[2] : 'opened'}`
          )
        ),
      ];
      return {
        host: h.label,
        dotenvOpens: dotenv,
        ...parseStrace(file, box, [here], repoRoot),
      };
    });
  }
  report.finishedAt = new Date().toISOString();
  const json = `${JSON.stringify(report, null, 2)}\n`.split(scratchRoot).join('<scratch>');
  if (outFile) writeFileSync(outFile, json);
  process.stdout.write(json);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
  else log(`kept ${scratchRoot}`);
}

await main();
