/**
 * dsh-rebase P1-4c1 pre-work experiment (rescope §8 item 1; decisions 093,
 * 094), against a real DSH host (source checkout) and the local fake gateway:
 *
 *   out-node-runtime/node src/dsh-host/tools/steer-experiments.ts [--keep] [--out report.json]
 *
 * Every session is the product bridge's own, opened on a channel with
 * worker.bootstrap and driven with worker.send, as Main drives it. The steering
 * itself goes through a test-only row (tools/lib/steer-experiment-row.mjs) that
 * reaches the bridge's agent with `ctx.agents.get` and calls DSH's own
 * `agent.steer` / `agent.cancel`, since the bridge does not steer yet.
 *
 *   E1  steer while a tool call waits at our approval card (ask posture):
 *       claimed at the next step boundary, the turn goes on
 *   E2s steer inside the `step/end` listener of the turn's last step (DSH
 *       refuses a re-entrant append there: a steer may never come from inside a
 *       `session/event` listener)
 *   E2a steer one microtask after that `step/end`: the last step has just ended
 *       and the turn is at its stop boundary
 *   E2b steer one macrotask after it (what an RPC arriving "just after" can at
 *       best do): the turn has closed
 *   E3  steer while `agent/turn-stopping` is awaited (a listener holds it)
 *   E4  steer while a tool runs, Stop with `cancel({kind:'user'},{keepInbox:true})`,
 *       then a followup: the pending steer goes out with the new turn
 *   E4c the same Stop without keepInbox (the bridge's stop before decision 094)
 *   E5  Stop with keepInbox, then steer at once, before the stop converged
 *
 * Refuses to start below 900 MB available. Signals only ever go to a
 * ChildProcess this script spawned. Every model request goes to the fake
 * gateway; the probe hooks drop any non-loopback connect.
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
import { fakeGatewayPlan, HostClient, isRecord, type Message } from './lib/hostClient.ts';
import { baseEnv, captureStderr, exitOf, sandbox, sleep } from './lib/kit.ts';
import { installProbeBundle, probeBundleSource } from './lib/probe-bundle.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const hostEntry = join(hostDir, 'host.ts');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const rowSource = join(here, 'lib', 'steer-experiment-row.mjs');
const MIN_AVAILABLE_MB = 900;
const keep = process.argv.includes('--keep');
const outIndex = process.argv.indexOf('--out');
const outFile = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;

const BYPASS = { mode: 'agent', gear: 'bypass' } as const;
const ASK = { mode: 'agent', gear: 'ask' } as const;

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
  copyFileSync(rowSource, join(dir, 'lib', 'steer-experiment.js'));
  const manifestFile = join(dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    exports: Record<string, string>;
  };
  manifest.exports['./steer-experiment'] = './lib/steer-experiment.js';
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  // The patch file ends inside its `insert:` list.
  appendFileSync(
    join(dir, 'cordis.patch.yml'),
    "\n    - id: aiclient-steer-experiment\n      name: '@aiclient/dsh-probe/steer-experiment'\n"
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

/** The experiment row's ops and events over the host's IPC channel. */
class Row {
  private seq = 0;
  private readonly replies: Message[] = [];
  readonly events: Message[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly child: ChildProcess;
  constructor(child: ChildProcess) {
    this.child = child;
    child.on('message', (message: unknown) => {
      if (!isRecord(message)) return;
      if (typeof message.rx41Reply === 'string') this.replies.push(message);
      else if (typeof message.rx41Event === 'string') this.events.push(message);
      else return;
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
    const requestId = `rx41-${++this.seq}`;
    this.child.send({ rx41: op, requestId, ...payload });
    const reply = await this.until(
      () => this.replies.find((item) => item.requestId === requestId),
      timeoutMs
    );
    if (!reply) throw new Error(`${op} timed out`);
    if (reply.error) throw new Error(`${op}: ${String(reply.error)}`);
    const { rx41Reply: _op, requestId: _id, ...rest } = reply;
    return rest;
  }
}

// ---- reading the log -----------------------------------------------------------

type LogEvent = { type: string; seq: number; data?: Message };

function textOf(content: unknown): string {
  return Array.isArray(content)
    ? content
        .filter((block) => isRecord(block) && block.type === 'text')
        .map((block) => String((block as Message).text))
        .join('')
    : '';
}

/** The log as one line per event that matters here; bodies the bridge does not own are elided. */
function timeline(events: readonly LogEvent[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    const data = event.data ?? {};
    switch (event.type) {
      case 'turn/start':
        lines.push(`${event.seq} turn/start t${String(data.turn)}`);
        break;
      case 'step/start':
      case 'step/end':
        lines.push(`${event.seq} ${event.type} t${String(data.turn)} s${String(data.step)}`);
        break;
      case 'user/message': {
        const kind = String((data.source as Message | undefined)?.kind ?? '?');
        const shown = kind === 'user' ? ` "${textOf(data.content).slice(0, 80)}"` : '';
        lines.push(`${event.seq} user/message [${kind}] ${String(data.id)}${shown}`);
        break;
      }
      case 'assistant/message': {
        const message = data.message as Message | undefined;
        const text = textOf(message?.content);
        const calls = Array.isArray(message?.content)
          ? (message.content as Message[]).filter((block) => block.type === 'tool-call').length
          : 0;
        lines.push(
          `${event.seq} assistant/message t${String(data.turn)} s${String(data.step)}${
            text ? ` "${text.slice(0, 80)}"` : ''
          }${calls ? ` (+${calls} call)` : ''}`
        );
        break;
      }
      case 'tool/call':
        lines.push(`${event.seq} tool/call ${String(data.name)}`);
        break;
      case 'tool/result': {
        const message = data.message as Message | undefined;
        lines.push(
          `${event.seq} tool/result${message?.isError === true ? ' (error)' : ''} "${textOf(
            message?.content
          )
            .trim()
            .slice(0, 60)}"`
        );
        break;
      }
      case 'agent/inbox/spliced': {
        const inserted = Array.isArray(data.inserted)
          ? (data.inserted as Message[]).map((message) => String(message.id))
          : [];
        lines.push(
          `${event.seq} inbox/spliced ${String(data.target)} +[${inserted.join(',')}]${
            data.removedCount ? ` -${String(data.removedCount)}` : ''
          }${data.outcome ? ` (${String(data.outcome)})` : ''}`
        );
        break;
      }
      case 'turn/end': {
        const reason = data.reason as Message | undefined;
        const cause = reason?.reason as Message | undefined;
        lines.push(
          `${event.seq} turn/end t${String(data.turn)} ${String(reason?.kind)}${
            cause?.kind ? `(${String(cause.kind)})` : ''
          }`
        );
        break;
      }
      default:
        break;
    }
  }
  return lines;
}

/** Where a user/message with `id` landed: its turn and step (from the enclosing step/start). */
function claimedAt(events: readonly LogEvent[], id: string): { turn: number; step: number } | null {
  let turn = 0;
  let step = 0;
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      turn = Number(data.turn);
      step = 0;
    } else if (event.type === 'step/start') {
      step = Number(data.step);
    } else if (event.type === 'user/message' && data.id === id) {
      return { turn, step };
    }
  }
  return null;
}

/** The user/message ids of `turn`'s first step, in order. */
function firstBatch(events: readonly LogEvent[], turn: number): string[] {
  let current = 0;
  let step = 0;
  const ids: string[] = [];
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      current = Number(data.turn);
      step = 0;
    } else if (event.type === 'step/start') step = Number(data.step);
    else if (
      event.type === 'user/message' &&
      current === turn &&
      step === 1 &&
      (data.source as Message | undefined)?.kind === 'user'
    ) {
      ids.push(String(data.id));
    }
  }
  return ids;
}

function turnEnds(events: readonly LogEvent[]): string[] {
  return events
    .filter((event) => event.type === 'turn/end')
    .map((event) => String((event.data?.reason as Message | undefined)?.kind));
}

function turnStarts(events: readonly LogEvent[]): number {
  return events.filter((event) => event.type === 'turn/start').length;
}

function lastReply(events: readonly LogEvent[]): string {
  const last = [...events].reverse().find((event) => event.type === 'assistant/message');
  return textOf((last?.data?.message as Message | undefined)?.content);
}

// ---- main -------------------------------------------------------------------------

async function main(): Promise<number> {
  const available = availableMb();
  if (available < MIN_AVAILABLE_MB) {
    process.stderr.write(
      `[rx41] only ${Math.round(available)} MB available (< ${MIN_AVAILABLE_MB}); not starting a host\n`
    );
    return 2;
  }
  const bundledNode = join(repoRoot, 'out-node-runtime', 'node');
  const nodeBin = existsSync(bundledNode) ? bundledNode : process.execPath;
  const scratchRoot = join('/var/tmp', `aiclient-dsh-p1-4c1-exp-${randomBytes(6).toString('hex')}`);
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
    // The probe bundle's auto-approving row would answer the bridge's approvals.
    AICLIENT_DSH_PROBE_ROW: '0',
  };
  const child = spawn(nodeBin, ['--expose-internals', '--import', hooksEntry, hostEntry], {
    cwd: hostCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const client = new HostClient(child, { requestPrefix: 'rx41' });
  client.configure(fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${gateway.port}` }), 'p1-4c1-key');
  const stderr = captureStderr(child);
  const exited = exitOf(child);
  const row = new Row(child);
  const report: Message = {};
  const verdict: Record<string, boolean> = {};
  let failed = false;

  const open = async (name: string, permissions: Message) => {
    const ch = client.openChannel();
    const logicalSessionId = `x41-${name}`;
    const boot = await client.request(ch, 'worker.bootstrap', {
      logicalSessionId,
      cwd: box.workspace,
      permissions,
    });
    return { ch, logicalSessionId, dsh: String(boot.piSessionId) };
  };
  type Open = Awaited<ReturnType<typeof open>>;
  const send = (s: Open, label: string, text: string) =>
    client.request(s.ch, 'worker.send', {
      logicalSessionId: s.logicalSessionId,
      requestId: `turn-${label}`,
      attemptId: `attempt-${label}`,
      text,
    });
  const settle = async (s: Open, ends: number) => {
    const turns = await row.op('turns', { sessionId: s.dsh, ends, timeoutMs: 90_000 });
    if (turns.timedOut)
      throw new Error(`${s.logicalSessionId}: never settled ${JSON.stringify(turns)}`);
    return turns;
  };
  const observe = async (s: Open) =>
    (await row.op('observe', { sessionId: s.dsh })).events as LogEvent[];
  const close = (s: Open) =>
    client.request(s.ch, 'worker.dispose', { reason: 'slot-dispose' }).catch(() => undefined);
  const waitTool = async (s: Open, from: number) => {
    const found = await client.until(
      s.ch,
      (events) => events.slice(from).some((event) => event.type === 'tool.updated'),
      60_000
    );
    if (!found) throw new Error(`${s.logicalSessionId}: the tool call never started`);
  };

  try {
    const ready = await client.control(
      (message) => message.type === 'ready' || message.type === 'fatal',
      180_000
    );
    if (ready?.type !== 'ready') throw new Error(`no ready: ${stderr().slice(-800)}`);

    // ---- E1: steer while a call waits at the approval card -----------------------------
    {
      const s = await open('e1', ASK);
      const from = client.events(s.ch).length;
      await send(s, 'E1', 'P1-STEER: two tool steps. (E1)');
      const up = await client.until(
        s.ch,
        (events) => events.slice(from).some((event) => event.type === 'permission.requested'),
        60_000
      );
      if (!up) throw new Error('E1: no card came up');
      const steered = await row.op('steer', {
        sessionId: s.dsh,
        text: 'STEER-NOTE-E1 also say hi.',
      });
      await sleep(500);
      const beforeAnswer = await observe(s);
      const claimedBeforeAnswer = claimedAt(beforeAnswer, String(steered.id)) !== null;
      // Answer every card of the turn with allow, until the turn settles.
      const answered = new Set<unknown>();
      for (;;) {
        const pending = client
          .events(s.ch)
          .slice(from)
          .filter(
            (event) =>
              event.type === 'permission.requested' &&
              !answered.has((event.payload as Message).permissionId)
          );
        for (const card of pending) {
          const permissionId = (card.payload as Message).permissionId;
          answered.add(permissionId);
          await client.request(s.ch, 'worker.permission.respond', {
            logicalSessionId: s.logicalSessionId,
            permissionId,
            decision: 'allow',
          });
        }
        const turns = await row.op('turns', { sessionId: s.dsh, ends: 1, timeoutMs: 300 });
        if (!turns.timedOut) break;
      }
      const events = await observe(s);
      const at = claimedAt(events, String(steered.id));
      report.E1 = {
        steered,
        claimedBeforeCardAnswered: claimedBeforeAnswer,
        cardsAnswered: answered.size,
        claimedAt: at,
        turnStarts: turnStarts(events),
        turnEnds: turnEnds(events),
        reply: lastReply(events),
        timeline: timeline(events),
      };
      verdict.E1_parkedWhileCardUp =
        !claimedBeforeAnswer &&
        ((steered.inboxAfter as Message).nextStep as string[]).includes(String(steered.id));
      verdict.E1_claimedAtNextStepSameTurn = at?.turn === 1 && at.step === 2;
      verdict.E1_turnContinued =
        turnStarts(events) === 1 && turnEnds(events).join() === 'completed';
      verdict.E1_modelSawIt = lastReply(events).includes('STEER-NOTE-E1');
      await close(s);
    }

    // ---- E2a / E2b: steer right as the last step ends --------------------------------------
    for (const [tag, mode] of [
      ['E2S', 'sync'],
      ['E2A', 'microtask'],
      ['E2B', 'immediate'],
    ] as const) {
      const s = await open(tag.toLowerCase(), BYPASS);
      await row.op('arm-step-end', {
        sessionId: s.dsh,
        text: `STEER-NOTE-${tag} one more thing.`,
        mode,
      });
      await send(s, tag, `P1-STEER-ONE: one answer. (${tag})`);
      await sleep(300);
      const first = await settle(s, 1);
      // A steer that landed after the turn closed opens a turn of its own.
      await sleep(1_000);
      const turns = await row.op('turns', {
        sessionId: s.dsh,
        ends: first.starts,
        timeoutMs: 60_000,
      });
      const steerRecord = (await row.op('step-end-steer', { sessionId: s.dsh })).steer as Message;
      const events = await observe(s);
      const at = claimedAt(events, String(steerRecord?.id));
      report[tag] = {
        steer: steerRecord,
        claimedAt: at,
        turns,
        turnStarts: turnStarts(events),
        turnEnds: turnEnds(events),
        reply: lastReply(events),
        timeline: timeline(events),
      };
      if (mode === 'sync') {
        verdict.E2S_refusedAsReentrantAppend = /reenter/.test(String(steerRecord?.error));
      } else {
        verdict[`${tag}_delivered`] =
          at !== null && lastReply(events).includes(`STEER-NOTE-${tag}`);
      }
      if (mode === 'microtask') {
        verdict.E2A_sameTurnNextStep = at?.turn === 1 && at.step === 2 && turnStarts(events) === 1;
      }
      await close(s);
    }

    // ---- E3: steer while agent/turn-stopping is awaited ------------------------------------
    {
      const s = await open('e3', BYPASS);
      await row.op('hold-turn-stopping', { sessionId: s.dsh, maxMs: 15_000 });
      await send(s, 'E3', 'P1-STEER-ONE: one answer. (E3)');
      const entered = await row.until(
        () =>
          row.events.find(
            (event) => event.rx41Event === 'turn-stopping' && event.sessionId === s.dsh
          ),
        60_000
      );
      if (!entered) throw new Error('E3: turn-stopping never ran');
      const steered = await row.op('steer', {
        sessionId: s.dsh,
        text: 'STEER-NOTE-E3 one more thing.',
      });
      await row.op('release-turn-stopping', { sessionId: s.dsh });
      const turns = await settle(s, 1);
      const events = await observe(s);
      const at = claimedAt(events, String(steered.id));
      report.E3 = {
        entered,
        steered,
        left: row.events.find(
          (event) => event.rx41Event === 'turn-stopping-left' && event.sessionId === s.dsh
        ),
        claimedAt: at,
        turns,
        turnStarts: turnStarts(events),
        turnEnds: turnEnds(events),
        reply: lastReply(events),
        timeline: timeline(events),
      };
      verdict.E3_claimedAtNextStepSameTurn = at?.turn === 1 && at.step === 2;
      verdict.E3_turnContinued =
        turnStarts(events) === 1 && turnEnds(events).join() === 'completed';
      verdict.E3_modelSawIt = lastReply(events).includes('STEER-NOTE-E3');
      await close(s);
    }

    // ---- E4 / E4c: Stop with and without keepInbox, then a followup ------------------------
    for (const [tag, keepInbox] of [
      ['E4', true],
      ['E4C', false],
    ] as const) {
      const s = await open(tag.toLowerCase(), BYPASS);
      const from = client.events(s.ch).length;
      await send(
        s,
        tag,
        `P0-SLEEPTOOL {"token":"${tag.toLowerCase()}","seconds":30} run a long command.`
      );
      await waitTool(s, from);
      await sleep(1_500);
      const steered = await row.op('steer', {
        sessionId: s.dsh,
        text: `STEER-NOTE-${tag} after this.`,
      });
      const cancelled = await row.op('cancel', { sessionId: s.dsh, keepInbox });
      await settle(s, 1);
      // Nothing may start by itself after the Stop.
      await sleep(2_000);
      const afterStop = await row.op('inbox', { sessionId: s.dsh });
      const stoppedEvents = await observe(s);
      const startsAfterStop = turnStarts(stoppedEvents);
      await send(s, `${tag}-NEXT`, `P1-STEER-ONE: after the stop. (${tag})`);
      await sleep(300);
      await settle(s, 2);
      const events = await observe(s);
      const followupId = firstBatch(events, 2).find((id) => id !== steered.id);
      report[tag] = {
        keepInbox,
        steered,
        cancelled,
        afterStop,
        turnStartsAfterStop: startsAfterStop,
        secondTurnFirstBatch: firstBatch(events, 2),
        claimedAt: claimedAt(events, String(steered.id)),
        turnEnds: turnEnds(events),
        reply: lastReply(events),
        timeline: timeline(events),
      };
      if (keepInbox) {
        verdict.E4_keptAfterStop =
          ((afterStop.nextStep as string[]) ?? []).includes(String(steered.id)) &&
          afterStop.status === 'idle';
        verdict.E4_noTurnOpenedByStop = startsAfterStop === 1;
        verdict.E4_goesOutWithNextTurn =
          firstBatch(events, 2)[0] === steered.id && followupId !== undefined;
        verdict.E4_modelSawIt = lastReply(events).includes('STEER-NOTE-E4');
      } else {
        verdict.E4C_lostWithoutKeepInbox =
          ((afterStop.nextStep as string[]) ?? []).length === 0 &&
          claimedAt(events, String(steered.id)) === null;
      }
      await close(s);
    }

    // ---- E5: Stop with keepInbox, then steer before it converged ----------------------------
    {
      const s = await open('e5', BYPASS);
      const from = client.events(s.ch).length;
      await send(s, 'E5', 'P0-SLEEPTOOL {"token":"e5","seconds":30} run a long command.');
      await waitTool(s, from);
      await sleep(1_500);
      const cancelled = await row.op('cancel', {
        sessionId: s.dsh,
        keepInbox: true,
        thenSteer: 'P1-STEER-ONE STEER-NOTE-E5 steered while stopping.',
      });
      await settle(s, 1);
      await sleep(1_500);
      const turns = await row.op('turns', { sessionId: s.dsh, ends: 2, timeoutMs: 30_000 });
      const events = await observe(s);
      const steeredId = String((cancelled.steered as Message | undefined)?.id);
      report.E5 = {
        cancelled,
        turns,
        claimedAt: claimedAt(events, steeredId),
        turnStarts: turnStarts(events),
        turnEnds: turnEnds(events),
        reply: lastReply(events),
        timeline: timeline(events),
      };
      verdict.E5_notLost = claimedAt(events, steeredId) !== null;
      await close(s);
    }

    report.verdict = verdict;
    failed = Object.values(verdict).some((value) => !value);
  } catch (error) {
    failed = true;
    report.verdict = verdict;
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
    else report.scratch = '<kept>';
  }
  // Scratch paths never leave this process: the report is evidence for a public repo.
  const text = `${JSON.stringify(report, null, 2).split(scratchRoot).join('<scratch>')}\n`;
  if (outFile) writeFileSync(outFile, text);
  process.stdout.write(text);
  return failed ? 1 : 0;
}

process.exitCode = await main();
