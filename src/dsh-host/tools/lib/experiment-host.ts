/**
 * A host driven for one experiment (dsh-rebase P1-10b: E1, E3), the way
 * Main's DshHostSupervisor drives one: Node IPC, the model plan first
 * (`configure`, one route to the local fake gateway), then `ready` or
 * `fatal`, one bridge session, one turn, `shutdown`. Signals only ever go to
 * the ChildProcess spawned here.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DshModelPlan } from '../../../shared/dshModelPlan/types.ts';
import { BYPASS_PERMISSIONS, HostClient, type Message } from './hostClient.ts';
import { captureStderr, exitOf, stopWithin } from './kit.ts';

export interface ExperimentHost {
  label: string;
  child: ChildProcess;
  client: HostClient;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

/** The local fake gateway (plan dsh-p0-2), logging every request to `<root>/gateway.jsonl`. */
export async function startFakeGateway(
  nodeBin: string,
  gatewayEntry: string,
  root: string
): Promise<{ child: ChildProcess; port: number; log: string }> {
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
  return { child, port, log };
}

/** The gateway's request log, one record per model request. */
export function gatewayRequests(log: string): Message[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Message);
}

export function startExperimentHost(options: {
  label: string;
  nodeBin: string;
  entry: string;
  cwd: string;
  env: Record<string, string>;
  plan: DshModelPlan;
  key: string;
}): ExperimentHost {
  const child = spawn(options.nodeBin, ['--expose-internals', options.entry], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const client = new HostClient(child, { requestPrefix: options.label });
  const host = {
    label: options.label,
    child,
    client,
    stderr: captureStderr(child),
    exited: exitOf(child),
  };
  client.configure(options.plan, options.key);
  return host;
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
  if (!(await stopWithin(host.exited, 15_000))) host.child.kill('SIGKILL');
  return { stopped, exit: await host.exited };
}
