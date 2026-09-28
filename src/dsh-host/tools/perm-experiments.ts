/**
 * dsh-rebase P1-6b pre-work experiments (P1-6 plan §1 item 12, §8): the DSH
 * facts the permission plugin relies on, measured on a real host with every
 * model request answered by the local fake gateway (plan dsh-p0-2, P1-PERM-*).
 *
 *   node tools/perm-experiments.ts [--keep] [--out file.json]   (from src/dsh-host)
 *
 * Host A (default composition, tool presentation `both` so `run_code` exists,
 * the test-only row `aiclient-perm-experiment` on):
 *   E1  a global prepend `tools/pre-execute` listener sees subagent,
 *       workflow-child and PTC sub-calls; `exec.agent`'s header names the
 *       parent session, so a child call can be routed to its root.
 *   E2  a listener that returns allow without `next()` in front of ours is
 *       caught by the synchronous guard.
 *   E3  does a non-prepend `tools/post-execute` listener run downstream of
 *       tool-fs-search (the plan's assumption: replacing the value then
 *       suppresses the spill file)? Host C re-runs the search turn with the
 *       listener prepended and returning the filtered value without `next()`.
 *   E5  a pre-execute listener parked like a pending card: cancelling the
 *       agent aborts `exec.signal`, and `cancel` becomes ABORTED_BEFORE_DISPATCH.
 * Host B (the `permission` row off through $DSH_HOME/cordis.patch.yml):
 *   E4  the host boots with every row active or disabled and still runs a
 *       subagent turn and a bash call.
 * Host D (the real `aiclient-permissions` row switched on, a gate attached
 *   per root session through `ctx.aiclientPermissions`, cards answered
 *   allow-once): the row loads, parses bash with the packaged wasm, names
 *   the delegate on a subagent's card and filters search results unspilled.
 *
 *   --host-entry <file>  run another host entry, e.g. out-dsh-host/host.js
 *   --only plugin        run host D alone
 *
 * Never a real provider: the only model route is the fake gateway, and the
 * probe hooks block every non-loopback connect.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const hostEntryPath = option('host-entry', '') ? resolve(option('host-entry', '')) : hostEntry;
const only = option('only', '');
const outFile = option('out', '');
const scratchRoot = join('/var/tmp', `aiclient-dsh-perm-exp-${Date.now()}`);
const log = (message: string) => process.stderr.write(`[perm-exp] ${message}\n`);

type Line = Record<string, unknown>;

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
  return { port, child };
}

interface Host {
  label: string;
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
  ready: Record<string, unknown>;
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

async function startHost(
  label: string,
  box: Sandbox,
  port: number,
  homePatch: string,
  extraEnv: Record<string, string> = {}
) {
  writeFileSync(join(box.dshHome, 'cordis.patch.yml'), homePatch);
  installProbeBundle(box.dshHome);
  const env = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AICLIENT_DSH_GATEWAY_URL: `http://127.0.0.1:${port}`,
    AICLIENT_DSH_GATEWAY_KEY: 'p1-6b-fake-key',
    AICLIENT_PROBE_EVENT_LOG: join(box.root, 'events.jsonl'),
    AICLIENT_PERM_EXPERIMENT: '1',
    AICLIENT_PERM_EXPERIMENT_LOG: join(box.root, 'experiment.jsonl'),
    ...extraEnv,
  };
  const launchDir = join(box.root, 'launch');
  mkdirSync(launchDir, { recursive: true });
  const child = launch(
    [nodeBin, '--expose-internals', '--import', hooksEntry, hostEntryPath],
    env,
    launchDir
  );
  const stderr = captureStderr(child);
  const exited = exitOf(child);
  const ready = await waitMessage(child, (m) => m.type === 'ready', 180_000, `${label} ready`);
  return { label, child, stderr, exited, ready } satisfies Host;
}

async function stopHost(host: Host) {
  host.child.send({ type: 'shutdown' });
  const graceful = await stopWithin(host.exited, 30_000);
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
  return { graceful, exit: await host.exited };
}

function readLines(file: string): Line[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

async function runTurn(host: Host, cwd: string, text: string, timeoutMs = 60_000) {
  const created = await call(host, 'create-session', { cwd });
  const sessionId = created.sessionId as string;
  const started = performance.now();
  await call(host, 'prompt', { sessionId, text });
  const idle = await call(host, 'wait-idle', { sessionId, timeoutMs }, timeoutMs + 5_000);
  return { sessionId, idle: idle.idle, ms: Math.round(performance.now() - started) };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(full);
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

// ---- experiments -----------------------------------------------------------------

function seedWorkspace(workspace: string): void {
  mkdirSync(join(workspace, 'data'), { recursive: true });
  for (let i = 0; i < 150; i += 1) {
    const body = i % 50 === 0 ? `PERM-SECRET marker ${i}\n` : `plain ${i}\n`;
    writeFileSync(join(workspace, 'data', `f-${String(i).padStart(3, '0')}.txt`), body);
  }
  writeFileSync(join(workspace, '.env'), 'PERM-SECRET=dotenv\n');
  writeFileSync(join(workspace, 'server.key'), 'PERM-SECRET private key\n');
}

const ALL_TURNS = [
  ['sub', 'P1-PERM-SUB'],
  ['workflow', 'P1-PERM-WF'],
  ['ptc', 'P1-PERM-PTC'],
  ['guard', 'P1-PERM-GUARD'],
  ['search', 'P1-PERM-SEARCH'],
  ['hold', 'P1-PERM-HOLD'],
] as const;

/** Host A runs every turn with the plan's post-execute placement; host C re-runs the search one short-circuited. */
async function hostA(port: number, label: 'a' | 'c', post: 'downstream' | 'short-circuit') {
  const box = sandbox(scratchRoot, label);
  seedWorkspace(box.workspace);
  const host = await startHost(
    label.toUpperCase(),
    box,
    port,
    // run_code exists only when the registry presents PTC.
    '- id: tools\n  config:\n    mode: both\n',
    { AICLIENT_PERM_EXPERIMENT_POST: post }
  );
  log(`host ${label} ready (${String(host.ready.pid)})`);
  const turns: Record<string, unknown> = {};
  const toolNames = await call(host, 'tools');
  for (const [name, text] of ALL_TURNS.filter(([name]) => label === 'a' || name === 'search')) {
    log(`turn ${name}`);
    try {
      turns[name] = await runTurn(host, box.workspace, text, 90_000);
    } catch (error) {
      turns[name] = { error: String(error) };
    }
  }
  await sleep(500);
  const stopped = await stopHost(host);
  const lines = readLines(join(box.root, 'experiment.jsonl'));
  const spill = listFiles(box.tmp).filter((file) => file.includes('dsh-spill-'));
  return {
    box: box.root,
    ready: { census: host.ready.census },
    toolNames: toolNames.names,
    turns,
    stopped,
    lines,
    spill,
    stderrTail: host.stderr().slice(-3000),
  };
}

async function hostB(port: number) {
  const box = sandbox(scratchRoot, 'b');
  const host = await startHost('B', box, port, '- id: permission\n  disabled: true\n');
  log(`host B ready (${String(host.ready.pid)})`);
  const turns: Record<string, unknown> = {};
  for (const [name, text] of [
    ['sub', 'P1-PERM-SUB'],
    ['tool', 'P0-TOOL'],
  ] as const) {
    log(`turn B ${name}`);
    try {
      turns[name] = await runTurn(host, box.workspace, text, 90_000);
    } catch (error) {
      turns[name] = { error: String(error) };
    }
  }
  const toolNames = await call(host, 'tools');
  // The presets row registers `/permission`; with the row off the command must be gone.
  const probe = await call(host, 'create-session', { cwd: box.workspace });
  const permissionCommand = await call(host, 'command', {
    sessionId: probe.sessionId,
    line: '/permission',
  }).catch((error: unknown) => ({ error: String(error).slice(0, 300) }));
  const stopped = await stopHost(host);
  const lines = readLines(join(box.root, 'experiment.jsonl'));
  return {
    box: box.root,
    permissionCommand,
    ready: { census: host.ready.census, composition: host.ready.composition },
    toolNames: toolNames.names,
    turns,
    stopped,
    results: lines.filter((line) => line.kind === 'result'),
    stderrTail: host.stderr().slice(-3000),
  };
}

async function hostD(port: number) {
  const box = sandbox(scratchRoot, 'd');
  seedWorkspace(box.workspace);
  const host = await startHost('D', box, port, '- id: aiclient-permissions\n  disabled: false\n', {
    AICLIENT_PERM_EXPERIMENT_MODE: 'plugin',
    AICLIENT_PERM_GATE_MODULE: pathToFileURL(
      join(repoRoot, 'src', 'shared', 'permissions', 'gate.ts')
    ).href,
  });
  log(`host D ready (${String(host.ready.pid)})`);
  const turns: Record<string, unknown> = {};
  for (const [name, text] of [
    ['tool', 'P0-TOOL'],
    ['sub', 'P1-PERM-SUB'],
    ['search', 'P1-PERM-SEARCH'],
  ] as const) {
    log(`turn D ${name}`);
    try {
      turns[name] = await runTurn(host, box.workspace, text, 90_000);
    } catch (error) {
      turns[name] = { error: String(error) };
    }
  }
  const stopped = await stopHost(host);
  const lines = readLines(join(box.root, 'experiment.jsonl'));
  const spill = listFiles(box.tmp).filter((file) => file.includes('dsh-spill-'));
  return {
    box: box.root,
    ready: { census: host.ready.census, composition: host.ready.composition },
    turns,
    stopped,
    lines,
    spill,
    stderrTail: host.stderr().slice(-3000),
  };
}

function pluginVerdict(d: Awaited<ReturnType<typeof hostD>>) {
  const results = d.lines.filter((line) => line.kind === 'result');
  const cards = d.lines.filter((line) => line.kind === 'card');
  const search = results.filter((line) => line.name === 'glob' || line.name === 'grep');
  return {
    inactiveRows: (d.ready.census as { inactive?: unknown[] } | undefined)?.inactive ?? null,
    gatesAttached: d.lines.filter((line) => line.kind === 'attached').length,
    serviceMissing: d.lines.some((line) => line.kind === 'no-service'),
    cards: cards.map((line) => ({
      tool: line.tool,
      command: line.command,
      delegation: line.delegation ?? null,
    })),
    failedResults: results
      .filter((line) => line.isError)
      .map((line) => ({ name: line.name, error: line.error })),
    searchClean:
      search.length === 2 && !search.some((line) => line.mentionsSecret || line.metaMentionsSecret),
    noSearchSpill: !d.spill.some((file) => /glob-results|grep-results/.test(file)),
    turnsIdle: Object.values(d.turns).every((turn) => (turn as { idle?: unknown }).idle === true),
  };
}

// ---- verdicts --------------------------------------------------------------------

type HostAReport = Awaited<ReturnType<typeof hostA>>;

function searchVerdict(run: HostAReport) {
  const results = run.lines.filter((line) => line.kind === 'result');
  const searchResults = results.filter((line) => line.name === 'glob' || line.name === 'grep');
  return {
    order: run.lines.find((line) => line.kind === 'post-order')?.hooks ?? null,
    filtered: run.lines.filter((line) => line.kind === 'post-search'),
    resultsMentionSecret: searchResults.some((line) => line.mentionsSecret),
    metaMentionsSecret: searchResults.some((line) => line.metaMentionsSecret),
    spillFiles: run.spill,
    noSearchSpill: !run.spill.some((file) => /glob-results|grep-results/.test(file)),
  };
}

function verdicts(a: HostAReport, c: HostAReport, b: Awaited<ReturnType<typeof hostB>>) {
  const pre = a.lines.filter((line) => line.kind === 'pre');
  const results = a.lines.filter((line) => line.kind === 'result');
  const created = a.lines.filter((line) => line.kind === 'session-created');
  const headerOf = (line: Line) => (line.header ?? {}) as Record<string, unknown>;
  const childBash = pre.filter(
    (line) => line.name === 'bash' && String(line.command).includes('perm-child-call')
  );
  const rootIds = new Set(
    created.filter((line) => !headerOf(line).parentSession).map((line) => headerOf(line).id)
  );
  const parentOf = new Map(
    created.map((line) => [headerOf(line).id, headerOf(line).parentSession] as const)
  );
  const rootOf = (id: unknown): unknown => {
    let cursor = id;
    for (let depth = 0; depth < 8 && parentOf.get(cursor); depth += 1)
      cursor = parentOf.get(cursor);
    return cursor;
  };
  const ptcSub = pre.filter(
    (line) => line.name === 'bash' && String(line.command).includes('perm-ptc-sub')
  );
  const createdBeforeCall = childBash.every((call) =>
    created.some(
      (line) =>
        headerOf(line).id === call.agentId && Number(line.tMs) <= Number(call.tMs ?? Infinity)
    )
  );
  const guardResult = results.find(
    (line) => line.name === 'bash' && String(line.text).includes('permission gate did not run')
  );
  const shortCircuit = a.lines.find((line) => line.kind === 'short-circuit');
  const holdAborted = a.lines.find((line) => line.kind === 'hold-aborted');
  const holdResult = results.find(
    (line) => line.name === 'bash' && line.callId === holdAborted?.callId
  );
  const bResults = b.results;
  const census = (b.ready.census ?? {}) as { inactive?: unknown[] };
  return {
    E1: {
      subagentChildCallSeen: childBash.some((line) => headerOf(line).origin === 'subagent'),
      workflowChildCallSeen: childBash.length >= 2,
      childCallsRouteToARootSession: childBash.every((line) => rootIds.has(rootOf(line.agentId))),
      childSessionAnnouncedBeforeItsFirstCall: createdBeforeCall,
      ptcSubCallSeen: ptcSub.length > 0,
      ptcSubCallNested: ptcSub.every((line) => line.nested === true),
      ptcSubCallAgentIsCaller: ptcSub.every((line) => rootIds.has(line.agentId)),
      childCalls: childBash.map((line) => ({
        agentId: line.agentId,
        parentSession: headerOf(line).parentSession,
        origin: headerOf(line).origin,
        depth: headerOf(line).delegationDepth,
        root: rootOf(line.agentId),
      })),
      ptcCalls: ptcSub.map((line) => ({ agentId: line.agentId, nested: line.nested })),
    },
    E2: {
      shortCircuitHappened: Boolean(shortCircuit),
      guardDenied: Boolean(guardResult),
      result: guardResult?.error ?? null,
    },
    E3: { downstream: searchVerdict(a), shortCircuit: searchVerdict(c) },
    E4: {
      booted: Boolean(b.ready.census),
      inactiveRows: census.inactive ?? null,
      subTurnIdle: (b.turns.sub as { idle?: unknown } | undefined)?.idle === true,
      childBashOk: bResults.some(
        (line) =>
          line.name === 'bash' && String(line.text).includes('perm-child-call') && !line.isError
      ),
      bashOk: bResults.some(
        (line) => line.name === 'bash' && String(line.text).includes('bridge tool row ok')
      ),
      permissionCommand: b.permissionCommand,
    },
    E5: {
      aborted: Boolean(holdAborted),
      waitedMs: holdAborted?.waitedMs ?? null,
      resultCode:
        (holdResult?.error as { info?: { code?: string } } | undefined)?.info?.code ?? null,
      result: holdResult?.error ?? null,
      turn: a.turns.hold ?? null,
    },
  };
}

async function main() {
  // 0700: spill-local refuses a root below a group-writable ancestor.
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  log(`scratch ${scratchRoot}`);
  const gateway = await startGateway(scratchRoot);
  let report: Record<string, unknown> = {};
  try {
    if (only === 'plugin') {
      const d = await hostD(gateway.port);
      report = { verdicts: { plugin: pluginVerdict(d) }, d };
    } else {
      const a = await hostA(gateway.port, 'a', 'downstream');
      const c = await hostA(gateway.port, 'c', 'short-circuit');
      const b = await hostB(gateway.port);
      const d = await hostD(gateway.port);
      report = { verdicts: { ...verdicts(a, c, b), plugin: pluginVerdict(d) }, a, c, b, d };
    }
  } finally {
    gateway.child.kill('SIGTERM');
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outFile) writeFileSync(outFile, text);
  process.stdout.write(`${JSON.stringify((report as { verdicts?: unknown }).verdicts, null, 2)}\n`);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
}

await main();
