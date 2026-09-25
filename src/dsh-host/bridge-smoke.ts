/**
 * P0-3 headless bridge smoke: the DSH host in bridge mode, driven exactly as
 * Main's WorkerSlot drives a worker (Node IPC, worker RPC), with no Electron.
 *
 *   node bridge-smoke.ts [--keep] [--out file.json]
 *
 * Turns (every model reply comes from the local fake gateway, plan dsh-p0-2):
 *   STREAM         paced text in 20 deltas
 *   TOOL           one bash call, then text
 *   APPROVE-ALLOW  write outside the workspace -> sandbox denial -> escalation
 *                  -> permission.requested -> worker.permission.respond allow
 *   APPROVE-DENY   the same, answered deny
 * then worker.dispose. Prints the RuntimeEvent sequence per turn and a verdict.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
const scratchRoot = join('/var/tmp', `aiclient-dsh-p0-3-smoke-${Date.now()}`);
const GENERATION = 1;
const SESSION = 'bridge-smoke';

type Message = Record<string, unknown>;

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

  request(type: string, payload: Message, timeoutMs = 60_000): Promise<Message> {
    const requestId = `smoke-${++this.seq}`;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`${type} timed out`)), timeoutMs);
      const onMessage = (message: unknown) => {
        const record = message as Message;
        if (record?.kind !== 'response' || record.requestId !== requestId) return;
        clearTimeout(timer);
        this.child.off('message', onMessage);
        if (record.ok) done(record.result as Message);
        else fail(new Error(`${type}: ${JSON.stringify(record.error)}`));
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
    AICLIENT_DSH_GATEWAY_KEY: 'p0-3-fake-key',
  };
  const t0 = performance.now();
  // Host cwd is app-private (P0-2: the launch directory's .env reaches tools).
  const child = spawn(nodeBin, ['--expose-internals', hostEntry], {
    cwd: box.dshHome,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const stderr = captureStderr(child);
  const exited = exitOf(child);
  const client = new WorkerClient(child);
  const report: Record<string, unknown> = { node: nodeBin, scratch: '<scratch>' };
  const turns: Record<string, unknown> = {};
  try {
    // Sent immediately, as Main does: the host must buffer it until the bridge row is up.
    const boot = await client.request('worker.bootstrap', {
      logicalSessionId: SESSION,
      cwd: box.workspace,
    });
    report.bootstrapMs = Math.round(performance.now() - t0);
    report.bootstrap = boot;
    report.commands = await client.request('worker.commands', { logicalSessionId: SESSION });

    const runTurn = async (label: string, text: string, onPermission?: 'allow' | 'deny') => {
      const requestId = `turn-${label}`;
      const from = client.events.length;
      await client.request('worker.send', {
        logicalSessionId: SESSION,
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
            logicalSessionId: SESSION,
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
      turns[label] = {
        idle,
        sequence: summarize(events),
        assistantDeltas: deltas.length - 1,
        permission: events.find((e) => e.type === 'permission.requested')?.payload,
        tools: events.filter((e) => e.type === 'tool.completed').map((e) => payloadOf(e)),
      };
    };

    await runTurn('STREAM', 'P0-STREAM: stream a paragraph back to me.');
    await runTurn('TOOL', 'P0-TOOL: list the workspace.');
    const allowTarget = join(outside, 'allowed.txt');
    await runTurn('APPROVE-ALLOW', `P0-APPROVAL: write outside, path=${allowTarget}`, 'allow');
    const denyTarget = join(outside, 'denied.txt');
    await runTurn('APPROVE-DENY', `P0-APPROVAL: write outside, path=${denyTarget}`, 'deny');
    report.files = { allowed: existsSync(allowTarget), denied: existsSync(denyTarget) };
    report.history = await client.request('worker.history', { logicalSessionId: SESSION });
    report.dispose = await client.request('worker.dispose', { reason: 'app-shutdown' });
    report.graceful = await stopWithin(exited, 15_000);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    report.exit = await exited;
    gateway.child.kill('SIGTERM');
  }
  report.turns = turns;
  const stream = turns.STREAM as { assistantDeltas?: number } | undefined;
  const tool = turns.TOOL as { tools?: Message[] } | undefined;
  const allow = turns['APPROVE-ALLOW'] as { permission?: Message; tools?: Message[] } | undefined;
  const deny = turns['APPROVE-DENY'] as { permission?: Message; tools?: Message[] } | undefined;
  const files = report.files as { allowed?: boolean; denied?: boolean } | undefined;
  report.verdict = {
    streamedInManyDeltas: (stream?.assistantDeltas ?? 0) >= 10,
    toolRowSettled: tool?.tools?.some((t) => t.ok === true) ?? false,
    approvalCardShown: Boolean(allow?.permission) && Boolean(deny?.permission),
    allowWrote: files?.allowed === true,
    denyDidNotWrite: files?.denied === false,
    exitedCleanly: (report.exit as { code?: number } | undefined)?.code === 0,
  };
  report.stderrTail = stderr().slice(-2500);
  const json = `${JSON.stringify(report, null, 2)}\n`.split(scratchRoot).join('<scratch>');
  if (outFile) writeFileSync(outFile, json);
  process.stdout.write(json);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
}

await main();
