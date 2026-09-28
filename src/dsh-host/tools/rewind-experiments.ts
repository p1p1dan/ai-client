/**
 * dsh-rebase P1-4b pre-work experiments (plan P1-4 §8, decision 027), against
 * a real DSH host and the local fake gateway. One host, one scratch DSH_HOME:
 *
 *   (cd src/dsh-host && ../../out-node-runtime/node tools/rewind-experiments.ts [--keep])
 *
 *   E1  a seeded child: session A answers two prompts; the child is cut after
 *       the first turn with the bridge's seed (`bridge/forkSeed.ts`), created
 *       with `seed` + `inheritedEventCount` + `isSeeded`, flushed, disposed —
 *       and resumed right away in the same host. Is it on disk after the flush,
 *       does the resume take the lock at once, does the child answer a turn,
 *       and does the model see the first prompt but not the second?
 *       Also: resuming a child whose handle is still held is refused.
 *   E1b the bridge's seed against DSH's own `buildForkSeed` at every boundary
 *       of A's log (the copy in forkSeed.ts must not drift).
 *   E2  a wake that lands while `runMaintenance` holds the agent: without a
 *       cancel it replays when the task ends (a turn starts on the old
 *       agent); with `cancel({kind:'disposed'}, {keepInbox:true})` at the end
 *       of the task it does not. And the agent still disposes.
 *
 * The experiment row is not in the repo's probe bundle: a scratch copy of
 * tools/probe-bundle gets tools/lib/rewind-experiment-row.mjs and one row.
 * Refuses to start below 900 MB available. Signals only ever go to a
 * ChildProcess this script spawned.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DshLogEvent } from '../../shared/dshHistory/types.ts';
import { buildDshForkSeed, planDshCut } from '../bridge/forkSeed.ts';
import { isRecord, type Message } from './lib/hostClient.ts';
import { baseEnv, captureStderr, exitOf, sandbox, sleep } from './lib/kit.ts';
import { installProbeBundle, probeBundleSource } from './lib/probe-bundle.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const hostEntry = join(hostDir, 'host.ts');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const rowSource = join(here, 'lib', 'rewind-experiment-row.mjs');
const dshSessionModule = join(
  hostDir,
  'node_modules',
  '@deepseek-ai',
  'dsh-session',
  'lib',
  'index.js'
);
const MIN_AVAILABLE_MB = 900;
const keep = process.argv.includes('--keep');

function availableMb(): number {
  try {
    const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
    return match ? Number(match[1]) / 1024 : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** tools/probe-bundle plus the experiment row, in a scratch directory. */
function experimentBundle(root: string): string {
  const dir = join(root, 'probe-bundle');
  cpSync(probeBundleSource, dir, { recursive: true });
  copyFileSync(rowSource, join(dir, 'lib', 'rewind-experiment.js'));
  const manifestFile = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    exports: Record<string, string>;
  };
  manifest.exports['./rewind-experiment'] = './lib/rewind-experiment.js';
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  // The patch file ends inside its `insert:` list.
  appendFileSync(
    join(dir, 'cordis.patch.yml'),
    "\n    - id: aiclient-rewind-experiment\n      name: '@aiclient/dsh-probe/rewind-experiment'\n"
  );
  return dir;
}

async function startGateway(root: string, nodeBin: string) {
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
  child.stderr?.resume();
  return { child, port };
}

class Experiment {
  private seq = 0;
  private readonly replies: Message[] = [];
  private readonly waiters = new Set<() => void>();
  readonly controls: Message[] = [];
  private readonly child: ChildProcess;
  constructor(child: ChildProcess) {
    this.child = child;
    child.on('message', (message: unknown) => {
      if (!isRecord(message)) return;
      if (typeof message.rx4bReply === 'string') this.replies.push(message);
      else this.controls.push(message);
      for (const wake of [...this.waiters]) wake();
    });
  }

  async until<T>(find: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
    const found = find();
    if (found !== undefined) return found;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        done(undefined);
      }, timeoutMs);
      const wake = () => {
        const value = find();
        if (value === undefined) return;
        clearTimeout(timer);
        this.waiters.delete(wake);
        done(value);
      };
      this.waiters.add(wake);
    });
  }

  async op(op: string, payload: Message = {}, timeoutMs = 120_000): Promise<Message> {
    const requestId = `rx4b-${++this.seq}`;
    this.child.send({ rx4b: op, requestId, ...payload });
    const reply = await this.until(
      () => this.replies.find((item) => item.requestId === requestId),
      timeoutMs
    );
    if (!reply) throw new Error(`${op} timed out`);
    if (reply.error) throw new Error(`${op}: ${String(reply.error)}`);
    return reply;
  }
}

function userMessageId(events: DshLogEvent[], marker: string): string {
  const found = events.find(
    (event) =>
      event.type === 'user/message' &&
      isRecord(event.data) &&
      (event.data.source as Message | undefined)?.kind === 'user' &&
      JSON.stringify(event.data.content).includes(marker)
  );
  if (!found || !isRecord(found.data)) throw new Error(`no prompt carrying ${marker}`);
  return String(found.data.id);
}

function lastAssistantText(events: DshLogEvent[]): string {
  const last = [...events].reverse().find((event) => event.type === 'assistant/message');
  const content = ((last?.data as Message | undefined)?.message as Message | undefined)?.content;
  return Array.isArray(content)
    ? content
        .filter((block) => isRecord(block) && block.type === 'text')
        .map((block) => String((block as Message).text))
        .join('')
    : '';
}

async function main(): Promise<number> {
  const available = availableMb();
  if (available < MIN_AVAILABLE_MB) {
    process.stderr.write(
      `[rx4b] only ${Math.round(available)} MB available (< ${MIN_AVAILABLE_MB}); not starting a host\n`
    );
    return 2;
  }
  const bundledNode = join(repoRoot, 'out-node-runtime', 'node');
  const nodeBin = existsSync(bundledNode) ? bundledNode : process.execPath;
  const scratchRoot = join('/var/tmp', `aiclient-dsh-p1-4b-exp-${randomBytes(6).toString('hex')}`);
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const box = sandbox(scratchRoot, 'run');
  const hostCwd = join(box.root, 'host-cwd');
  mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
  installProbeBundle(box.dshHome, experimentBundle(scratchRoot));
  const gateway = await startGateway(box.root, nodeBin);
  const env = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AICLIENT_DSH_PROBE_ROW: '0',
    AICLIENT_DSH_GATEWAY_URL: `http://127.0.0.1:${gateway.port}`,
    AICLIENT_DSH_GATEWAY_KEY: 'p1-4b-fake-key',
  };
  const child = spawn(nodeBin, ['--expose-internals', '--import', hooksEntry, hostEntry], {
    cwd: hostCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const stderr = captureStderr(child);
  const exited = exitOf(child);
  const x = new Experiment(child);
  const report: Message = {};
  let failed = false;
  try {
    const ready = await x.until(
      () => x.controls.find((message) => message.type === 'ready' || message.type === 'fatal'),
      180_000
    );
    if (ready?.type !== 'ready') throw new Error(`no ready: ${stderr().slice(-800)}`);
    const cwd = box.workspace;

    // ---- E1: seeded child, flush, dispose, resume at once -------------------------
    const A = 'aiclient-x4b-a';
    report.createA = await x.op('create', { sessionId: A, cwd });
    report.promptA1 = await x.op('prompt', { sessionId: A, text: 'alpha KEEP-A1, no scenario.' });
    report.promptA2 = await x.op('prompt', { sessionId: A, text: 'beta DROP-A2, no scenario.' });
    const eventsA = (await x.op('observe', { sessionId: A })).events as DshLogEvent[];
    const plan = planDshCut(eventsA, userMessageId(eventsA, 'DROP-A2'), 'rewind');
    if (!plan || plan.boundary === null) throw new Error(`no cut: ${JSON.stringify(plan)}`);
    const seed = buildDshForkSeed(eventsA, plan.boundary);
    report.cut = {
      boundary: plan.boundary,
      boundaryType: eventsA[plan.boundary]?.type,
      editorText: plan.editorText,
      seedTail: seed.slice(plan.boundary).map((event) => `${event.seq} ${event.type}`),
    };
    const R2 = `${A}.r2`;
    report.createChild = await x.op('create', {
      sessionId: R2,
      cwd,
      seed,
      inheritedEventCount: plan.boundary + 1,
      parentSession: A,
      isSeeded: true,
    });
    report.disposeChild = await x.op('dispose', { sessionId: R2 });
    report.statAfterDispose = (await x.op('stat', { sessionId: R2 })).stat;
    report.resumeChildAtOnce = await x.op('resume', { sessionId: R2 });
    report.recall = await x.op('prompt', {
      sessionId: R2,
      text: 'P0-RECALL {"markers":["KEEP-A1","DROP-A2"]} which markers do you see?',
    });
    const childEvents = (await x.op('observe', { sessionId: R2 })).events as DshLogEvent[];
    report.recallReply = lastAssistantText(childEvents);
    report.childEventTypesAfterCut = childEvents
      .slice(plan.boundary + 1)
      .map((event) => event.type)
      .slice(0, 12);
    // The lock: a child whose handle is still held cannot be resumed again.
    const R3 = `${A}.r3`;
    await x.op('create', {
      sessionId: R3,
      cwd,
      seed,
      inheritedEventCount: plan.boundary + 1,
      parentSession: A,
      isSeeded: true,
    });
    report.resumeWhileHeld = await x.op('resume', { sessionId: R3 });
    await x.op('dispose', { sessionId: R3 });
    report.disposeA = await x.op('dispose', { sessionId: A });
    report.resumeAAfterDispose = await x.op('resume', { sessionId: A });

    // ---- E1b: the seed copy against DSH's buildForkSeed ------------------------------
    // A tool turn too, so some cuts leave a step with unanswered calls open.
    const D = 'aiclient-x4b-d';
    await x.op('create', { sessionId: D, cwd });
    await x.op('prompt', { sessionId: D, text: 'P0-TOOL: list the workspace.' });
    const eventsD = (await x.op('observe', { sessionId: D })).events as DshLogEvent[];
    await x.op('dispose', { sessionId: D });
    let same = 0;
    let boundaries = 0;
    const differing: string[] = [];
    for (const [label, events] of [
      ['A', eventsA],
      ['D', eventsD],
    ] as const) {
      for (let boundary = 0; boundary < events.length; boundary += 1) {
        boundaries += 1;
        const theirs = (
          await x.op('dsh-fork-seed', { modulePath: dshSessionModule, events, boundary })
        ).seed;
        const ours = buildDshForkSeed(events, boundary);
        if (JSON.stringify(theirs) === JSON.stringify(ours)) same += 1;
        else differing.push(`${label}@${boundary}`);
      }
    }
    report.seedCopy = { boundaries, same, differing };

    // ---- E2: a wake latched behind maintenance ---------------------------------------
    const B = 'aiclient-x4b-b';
    await x.op('create', { sessionId: B, cwd });
    report.maintenancePlain = await x.op('maintenance-wake', {
      sessionId: B,
      text: 'gamma arrives during maintenance, no scenario.',
      cancelDisposed: false,
      settleMs: 1500,
    });
    const C = 'aiclient-x4b-c';
    await x.op('create', { sessionId: C, cwd });
    report.maintenanceDisposedCancel = await x.op('maintenance-wake', {
      sessionId: C,
      text: 'delta arrives during maintenance, no scenario.',
      cancelDisposed: true,
      settleMs: 1500,
    });
    report.disposeCancelled = await x.op('dispose', { sessionId: C });
    await x.op('dispose', { sessionId: B });

    const verdict = {
      E1_onDiskAfterFlush: typeof (report.createChild as Message).statAfterFlush === 'object',
      E1_resumeAtOnce: (report.resumeChildAtOnce as Message).ok === true,
      E1_recall: report.recallReply,
      E1_heldRefused: (report.resumeWhileHeld as Message).ok === false,
      E1b_seedCopyMatches: differing.length === 0,
      E2_plainReplays: Number((report.maintenancePlain as Message).turnsStartedAfter) > 0,
      E2_disposedCancelHolds:
        Number((report.maintenanceDisposedCancel as Message).turnsStartedAfter) === 0,
    };
    report.verdict = verdict;
    failed =
      !verdict.E1_resumeAtOnce ||
      !String(verdict.E1_recall).includes('present=KEEP-A1 missing=DROP-A2') ||
      !verdict.E1b_seedCopyMatches;
  } catch (error) {
    failed = true;
    report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    report.stderrTail = stderr().slice(-2000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.send({ type: 'shutdown' });
      await Promise.race([exited, sleep(20_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await exited;
    gateway.child.kill('SIGTERM');
    if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
    else report.scratch = scratchRoot;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return failed ? 1 : 0;
}

process.exitCode = await main();
