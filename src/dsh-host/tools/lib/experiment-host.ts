/**
 * A host driven for one experiment (dsh-rebase P1-10b: E1, E3), the way
 * Main's DshHostSupervisor drives one: Node IPC, the model plan first
 * (`configure`, one route to the local fake gateway), then `ready` or
 * `fatal`, one bridge session, one turn, `shutdown`. Signals only ever go to
 * the ChildProcess spawned here.
 *
 * Decision 173 (issue #9, tools/request-prefix-probe.ts) adds what a probe
 * with several sessions and turns needs: the gateway's request capture, the
 * host's whole stderr by line, and the bridge calls Main makes on a session
 * (open or reopen, send, interject, compact, answer a plan review).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DshModelPlan } from '../../../shared/dshModelPlan/types.ts';
import { BYPASS_PERMISSIONS, HostClient, type Message, type ServedPlan } from './hostClient.ts';
import { captureStderr, exitOf } from './kit.ts';

export interface ExperimentHost {
  label: string;
  child: ChildProcess;
  client: HostClient;
  /** Main's side of the plan and the keys: every credential request this host sent. */
  served: ServedPlan;
  /** The last 20,000 characters of stderr. */
  stderr: () => string;
  /** Every stderr line so far, a trailing partial one included. */
  stderrLines: () => string[];
  exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface FakeGateway {
  child: ChildProcess;
  port: number;
  log: string;
  /** Where each request was written (`--capture`), when asked for. */
  capture?: string;
}

/**
 * The local fake gateway (plan dsh-p0-2), logging every request to
 * `<root>/gateway.jsonl`. With `capture` it also writes each POST, body and
 * all, to `<capture>/<seq>.json` before replying (decision 173): keep that
 * directory in a scratch root, it holds request content.
 */
export async function startFakeGateway(
  nodeBin: string,
  gatewayEntry: string,
  root: string,
  options: { capture?: string } = {}
): Promise<FakeGateway> {
  const log = join(root, 'gateway.jsonl');
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
      log,
      '--model-id',
      'fake-1',
      ...(options.capture ? ['--capture', options.capture] : []),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const port = await new Promise<number>((done, fail) => {
    let text = '';
    const timer = setTimeout(() => fail(new Error('fake gateway did not start')), 15_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      text += chunk;
      const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    });
  });
  child.stderr?.resume();
  return { child, port, log, ...(options.capture ? { capture: options.capture } : {}) };
}

/**
 * Whether `exited` settles within `ms`. Unlike kit's `stopWithin`, the timer
 * is cleared once it does, so a finished driver does not wait it out.
 */
async function exitsWithin(exited: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((done) => {
    timer = setTimeout(() => done(false), ms);
  });
  try {
    return await Promise.race([exited.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** SIGTERM (the gateway saves its counter and exits), SIGKILL if it lingers. */
export async function stopFakeGateway(gateway: { child: ChildProcess }): Promise<void> {
  const { child } = gateway;
  const exited = exitOf(child);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  if (!(await exitsWithin(exited, 5_000))) child.kill('SIGKILL');
  await exited;
}

/** The gateway's request log, one record per model request. */
export function gatewayRequests(log: string): Message[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Message);
}

/** Every stderr line of `child`, kept whole; call after `captureStderr`, which sets the encoding. */
function collectStderrLines(child: ChildProcess): () => string[] {
  const lines: string[] = [];
  let partial = '';
  child.stderr?.on('data', (chunk: string | Buffer) => {
    const parts = `${partial}${String(chunk)}`.split('\n');
    partial = parts.pop() ?? '';
    for (const line of parts) lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
  });
  return () => (partial ? [...lines, partial] : [...lines]);
}

/** `nodeArgs` go before the entry (e.g. `--import` of the probe hooks). */
export function startExperimentHost(options: {
  label: string;
  nodeBin: string;
  nodeArgs?: string[];
  entry: string;
  cwd: string;
  env: Record<string, string>;
  plan: DshModelPlan;
  key: string;
}): ExperimentHost {
  const child = spawn(
    options.nodeBin,
    ['--expose-internals', ...(options.nodeArgs ?? []), options.entry],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }
  );
  const client = new HostClient(child, { requestPrefix: options.label });
  const stderr = captureStderr(child);
  return {
    label: options.label,
    child,
    client,
    stderr,
    stderrLines: collectStderrLines(child),
    exited: exitOf(child),
    served: client.configure(options.plan, options.key),
  };
}

/** `ready` or `fatal`, whichever the host sends first; undefined if neither came in time. */
export async function readyOrFatal(
  host: ExperimentHost,
  timeoutMs = 180_000
): Promise<Message | undefined> {
  return host.client.control((m) => m.type === 'ready' || m.type === 'fatal', timeoutMs);
}

/** One bridge session in `cwd`, bypass posture (no card to answer), and one turn to its end. */
export async function oneTurn(
  host: ExperimentHost,
  input: { sessionId: string; cwd: string; text: string; timeoutMs?: number }
): Promise<{ bootstrapped: boolean; idle: boolean; reply: string; tools: Message[] }> {
  const ch = host.client.openChannel();
  const boot = await host.client.call(ch, 'worker.bootstrap', {
    logicalSessionId: input.sessionId,
    cwd: input.cwd,
    permissions: BYPASS_PERMISSIONS,
  });
  if (!boot.ok) return { bootstrapped: false, idle: false, reply: '', tools: [] };
  const requestId = `${host.label}-turn`;
  await host.client.request(ch, 'worker.send', {
    logicalSessionId: input.sessionId,
    requestId,
    attemptId: `${requestId}-attempt`,
    text: input.text,
  });
  const idle = await host.client.until(
    ch,
    (events) =>
      events.some(
        (event) =>
          event.type === 'session.status' &&
          (event.payload as Message | undefined)?.status === 'idle' &&
          event.requestId === requestId
      ),
    input.timeoutMs ?? 120_000
  );
  const events = host.client.events(ch);
  const payload = (event: Message) => (event.payload ?? {}) as Message;
  const assistant = new Set(
    events
      .filter((event) => event.type === 'message.started' && payload(event).role === 'assistant')
      .map((event) => payload(event).messageId)
  );
  const reply = events
    .filter((event) => event.type === 'message.delta' && assistant.has(payload(event).messageId))
    .map((event) => String(payload(event).text ?? ''))
    .join('');
  const names = new Map(
    events
      .filter((event) => event.type === 'tool.started')
      .map((event) => [payload(event).toolCallId, payload(event).name ?? payload(event).toolName])
  );
  const tools = events
    .filter((event) => event.type === 'tool.completed')
    .map((event) => ({ name: names.get(payload(event).toolCallId), ok: payload(event).ok }));
  return { bootstrapped: true, idle, reply: reply.slice(0, 300), tools };
}

/** `shutdown`, `stopped`, a clean exit; SIGKILL on the child only if it lingers. */
export async function stopExperimentHost(
  host: ExperimentHost
): Promise<{ stopped: boolean; exit: { code: number | null; signal: string | null } }> {
  let stopped = false;
  if (host.child.connected) {
    host.client.send({ type: 'shutdown' });
    stopped = (await host.client.control((m) => m.type === 'stopped', 15_000)) !== undefined;
  }
  if (!(await exitsWithin(host.exited, 15_000))) host.child.kill('SIGKILL');
  return { stopped, exit: await host.exited };
}

// ---- sessions, as Main's WorkerSlot drives them (decision 173) ----------------

/** A bridge session on a channel of its own. */
export interface ExperimentSession {
  ch: string;
  logicalSessionId: string;
  /** DSH's session id, the bootstrap's `piSessionId` (`aiclient-<logical id>`). */
  dshSessionId: string;
  /** The stub another host reopens the session from. */
  stubFile: string;
  cwd: string;
  boot: Message;
}

function payloadOf(event: Message): Message {
  return (event.payload ?? {}) as Message;
}

/** An RPC's answer without its request id: `{ok, result}` or `{ok: false, code, retryable}`. */
export function rpcAnswer(response: Message): Message {
  if (response.ok) return { ok: true, result: response.result };
  const error = (response.error ?? {}) as Message;
  return { ok: false, code: error.code, retryable: error.retryable };
}

/**
 * `worker.bootstrap` on a fresh channel: a new session, or with `sessionFile`
 * the stub of one another host made. Bypass posture unless `permissions`
 * says otherwise. Throws when the bridge refuses.
 */
export async function openSession(
  host: ExperimentHost,
  input: { logicalSessionId: string; cwd: string; permissions?: Message; sessionFile?: string }
): Promise<ExperimentSession> {
  const ch = host.client.openChannel();
  const boot = await host.client.request(
    ch,
    'worker.bootstrap',
    {
      logicalSessionId: input.logicalSessionId,
      cwd: input.cwd,
      ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
      permissions: input.permissions ?? BYPASS_PERMISSIONS,
    },
    120_000
  );
  return {
    ch,
    logicalSessionId: input.logicalSessionId,
    dshSessionId: String(boot.piSessionId),
    stubFile: String(boot.sessionFile),
    cwd: input.cwd,
    boot,
  };
}

/** Whether the channel has seen `requestId` go idle since event `from`. */
function wentIdle(events: readonly Message[], from: number, requestId: string): boolean {
  return events
    .slice(from)
    .some(
      (event) =>
        event.type === 'session.status' &&
        payloadOf(event).status === 'idle' &&
        event.requestId === requestId
    );
}

/** Waits until turn `requestId` (one nobody sent too, e.g. a goal round) went idle since `from`. */
export function waitIdle(
  host: ExperimentHost,
  session: ExperimentSession,
  requestId: string,
  from: number,
  timeoutMs = 120_000
): Promise<boolean> {
  return host.client.until(session.ch, (events) => wentIdle(events, from, requestId), timeoutMs);
}

/** The assistant's text in `events`, every message of it. */
export function replyText(events: readonly Message[]): string {
  const assistant = new Set(
    events
      .filter((event) => event.type === 'message.started' && payloadOf(event).role === 'assistant')
      .map((event) => payloadOf(event).messageId)
  );
  return events
    .filter((event) => event.type === 'message.delta' && assistant.has(payloadOf(event).messageId))
    .map((event) => String(payloadOf(event).text ?? ''))
    .join('');
}

export interface ExperimentTurn {
  requestId: string;
  idle: boolean;
  /** The channel's events from the send on. */
  events: Message[];
  reply: string;
}

/**
 * One `worker.send` and its turn to `idle`. `during` runs once the send is
 * accepted, given the index of the turn's first event on the channel: it may
 * wait for a step, interject or answer cards; the turn's wait starts after it.
 */
export async function sendTurn(
  host: ExperimentHost,
  session: ExperimentSession,
  input: {
    requestId: string;
    text: string;
    during?: (from: number) => Promise<void>;
    timeoutMs?: number;
  }
): Promise<ExperimentTurn> {
  const { client } = host;
  const from = client.events(session.ch).length;
  await client.request(session.ch, 'worker.send', {
    logicalSessionId: session.logicalSessionId,
    requestId: input.requestId,
    attemptId: `${input.requestId}-attempt`,
    text: input.text,
  });
  await input.during?.(from);
  const idle = await waitIdle(host, session, input.requestId, from, input.timeoutMs);
  const events = client.events(session.ch).slice(from);
  return { requestId: input.requestId, idle, events, reply: replyText(events) };
}

/** Waits until `count` distinct tool calls started on the channel since `from`. */
export function waitToolStarts(
  host: ExperimentHost,
  session: ExperimentSession,
  from: number,
  count: number,
  timeoutMs = 60_000
): Promise<boolean> {
  const started = (events: readonly Message[]) =>
    new Set(
      events
        .slice(from)
        .filter((event) => event.type === 'tool.started')
        .map((event) => payloadOf(event).toolCallId)
    ).size;
  return host.client.until(session.ch, (events) => started(events) >= count, timeoutMs);
}

/** Ctrl+Enter while a turn runs (`worker.interject`), answered as `rpcAnswer` gives it. */
export async function interject(
  host: ExperimentHost,
  session: ExperimentSession,
  attemptId: string,
  text: string
): Promise<Message> {
  return rpcAnswer(
    await host.client.call(session.ch, 'worker.interject', {
      logicalSessionId: session.logicalSessionId,
      attemptId,
      text,
    })
  );
}

/** `/compact` on an idle session (`worker.compact`, DSH's own), answered as `rpcAnswer` gives it. */
export async function compactSession(
  host: ExperimentHost,
  session: ExperimentSession,
  timeoutMs = 120_000
): Promise<Message> {
  return rpcAnswer(
    await host.client.call(
      session.ch,
      'worker.compact',
      { logicalSessionId: session.logicalSessionId },
      timeoutMs
    )
  );
}

/**
 * A `during` for `sendTurn` answering the turn's plan review cards in order
 * with `replies` (`worker.question.respond`, as the review card sends them,
 * e.g. `{answers: {'plan-review': 'goal:auto'}}`). `beforeAnswer` runs just
 * before each answer goes out; the answers land in `answered`. Throws when a
 * card never comes up.
 */
export function answeringReviews(
  host: ExperimentHost,
  session: ExperimentSession,
  replies: readonly Message[],
  answered: Message[],
  beforeAnswer?: (index: number) => void
): (from: number) => Promise<void> {
  return async (from) => {
    const { client } = host;
    const isReview = (event: Message) =>
      event.type === 'question.requested' && payloadOf(event).review !== undefined;
    for (const [index, reply] of replies.entries()) {
      const up = await client.until(
        session.ch,
        (events) => events.slice(from).filter(isReview).length > index,
        60_000
      );
      if (!up) throw new Error(`${session.logicalSessionId}: review ${index + 1} never came up`);
      const card = payloadOf(client.events(session.ch).slice(from).filter(isReview)[index]);
      beforeAnswer?.(index);
      answered.push(
        rpcAnswer(
          await client.call(session.ch, 'worker.question.respond', {
            logicalSessionId: session.logicalSessionId,
            questionId: card.questionId,
            ...reply,
          })
        )
      );
    }
  };
}
