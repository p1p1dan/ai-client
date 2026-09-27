import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-3a — the shared DSH host for real (P1-3 plan §6, the P0-6
 * scenarios): the real DshHostSupervisor, WorkerManager and createPiWorkerSlot
 * over a real host process and the local fake gateway. Opt-in and slow:
 *
 *   AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run \
 *     src/main/services/agent-host/__tests__/dshSharedHost.integration.test.ts
 *
 * Needs out-node-runtime/node and `npm ci` in src/dsh-host. Run it alone on the
 * dev box (one host is 200-350 MB), with no Electron open.
 *
 * Only this repo's own children are ever signalled, through their ChildProcess
 * (`node:child_process` is wrapped to remember them): never a pid, never a group.
 * The per-session budget and batch recovery of P1-3c are not asserted here;
 * this proves the existing per-session restart path recovers on a shared host.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../..');
const NODE = join(REPO, 'out-node-runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const GATEWAY = join(REPO, 'src', 'dsh-host', 'tools', 'fake-gateway.mjs');
const enabled =
  process.env.AICLIENT_DSH_INTEGRATION === '1' &&
  process.platform === 'linux' &&
  existsSync(NODE) &&
  existsSync(join(REPO, 'src', 'dsh-host', 'node_modules', '@deepseek-ai', 'dsh-app-boot'));

const shared = vi.hoisted(() => ({
  stateRoot: '',
  children: [] as ChildProcess[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      shared.children.push(child);
      return child;
    },
  };
});
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => REPO },
  powerMonitor: { on: () => undefined, removeListener: () => undefined },
}));
vi.mock('../../appStatePaths', () => ({ getAppStateRoot: () => shared.stateRoot }));

const { dshHostSupervisor } = await import('../DshHostSupervisor');
const { WorkerManager } = await import('../WorkerManager');
const { spawn } = await import('node:child_process');

type Event = RuntimeEvent & { payload?: Record<string, unknown> };

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const isHost = (child: ChildProcess) => child.spawnargs.some((arg) => arg.endsWith('host.ts'));

/** Processes whose command line carries `needle` (Linux). */
function processesWith(needle: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ');
      if (cmd.includes(needle)) found.push(`${entry} ${cmd.slice(0, 120)}`);
    } catch {
      // Gone between readdir and read.
    }
  }
  return found;
}

describe.skipIf(!enabled)('shared DSH host, real process (P1-3a)', () => {
  const events: Event[] = [];
  const saved: Record<string, string | undefined> = {};
  let gateway: ChildProcess | undefined;
  let workspace = '';
  let manager: InstanceType<typeof WorkerManager>;
  let attempt = 0;
  const tokens: Record<string, string> = {};
  const hostLines: string[] = [];

  const hostChildren = () => shared.children.filter(isHost);
  const liveHosts = () => hostChildren().filter(alive);
  const forSession = (id: string, from = 0) => events.slice(from).filter((e) => e.sessionId === id);

  async function turn(sessionId: string, text: string, owner: number) {
    const from = events.length;
    attempt += 1;
    const requestId = await manager.send({
      sessionId,
      attemptId: `attempt-${attempt}`,
      text,
      ownerWebContentsId: owner,
    });
    const settled = await until(
      () =>
        forSession(sessionId, from).some(
          (e) =>
            e.requestId === requestId && e.type === 'session.status' && e.payload?.status === 'idle'
        ),
      120_000
    );
    const turnEvents = forSession(sessionId, from);
    const assistant = new Set(
      turnEvents
        .filter((e) => e.type === 'message.started' && e.payload?.role === 'assistant')
        .map((e) => e.payload?.messageId)
    );
    return {
      settled,
      completed: turnEvents.some((e) => e.type === 'session.completed'),
      reply: turnEvents
        .filter((e) => e.type === 'message.delta' && assistant.has(e.payload?.messageId))
        .map((e) => String(e.payload?.text))
        .join(''),
    };
  }

  /** Every session reported resumed and idle after `from`; returns when, or -1. */
  async function recovered(ids: string[], from: number, timeoutMs: number): Promise<number> {
    const started = Date.now();
    const ok = await until(
      () =>
        ids.every((id) => {
          const list = forSession(id, from);
          const resumed = list.findIndex((e) => e.type === 'session.resumed');
          return (
            resumed >= 0 &&
            list
              .slice(resumed)
              .some((e) => e.type === 'session.status' && e.payload?.status === 'idle')
          );
        }),
      timeoutMs
    );
    return ok ? Date.now() - started : -1;
  }

  beforeAll(async () => {
    shared.stateRoot = mkdtempSync(join('/var/tmp', 'aiclient-p1-3a-it-'));
    workspace = join(shared.stateRoot, 'workspace');
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    for (const name of [
      'AICLIENT_DSH_HOME',
      'AICLIENT_DSH_NODE',
      'AICLIENT_DSH_GATEWAY_URL',
      'AICLIENT_DSH_GATEWAY_KEY',
    ]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    gateway = spawn(
      process.execPath,
      [
        GATEWAY,
        '--port',
        '0',
        '--plan',
        'dsh-p0-2',
        '--reset',
        '--state',
        join(shared.stateRoot, 'gateway.state.json'),
        '--log',
        join(shared.stateRoot, 'gateway.jsonl'),
        '--model-id',
        'fake-1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const port = await new Promise<number>((done, fail) => {
      let text = '';
      gateway?.stdout?.setEncoding('utf8');
      gateway?.stdout?.on('data', (chunk: string) => {
        text += chunk;
        const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) done(Number(match[1]));
      });
      setTimeout(() => fail(new Error('fake gateway did not start')), 15_000);
    });
    gateway.stderr?.resume();
    // Main's dev route (DshHostProcess adds these back unpackaged, decision 022).
    process.env.AICLIENT_DSH_GATEWAY_URL = `http://127.0.0.1:${port}`;
    process.env.AICLIENT_DSH_GATEWAY_KEY = 'p1-3a-fake-key';
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      hostLines.push(args.map(String).join(' '));
    });
    manager = new WorkerManager({
      onEvent: (event) => events.push(event as Event),
      capacity: 6,
      idleTimeoutMs: 0,
      idleSweepIntervalMs: 0,
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await manager?.disposeAll('app-shutdown');
      await dshHostSupervisor.shutdown('app-quit');
    } finally {
      // Backstop: this suite's own children only, SIGCONT-free (SIGKILL ends a stopped one too).
      for (const child of shared.children) if (alive(child)) child.kill('SIGKILL');
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      vi.restoreAllMocks();
      rmSync(shared.stateRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('serves several sessions from one host process', async () => {
    for (const [index, id] of ['s1', 's2', 's3'].entries()) {
      tokens[id] = `P13A${id.toUpperCase()}${Date.now() % 100_000}`;
      await manager.createSession({
        sessionId: id,
        workspacePath: workspace,
        ownerWebContentsId: index + 1,
      });
    }
    const results = await Promise.all(
      ['s1', 's2', 's3'].map((id, index) =>
        turn(id, `P0-CRASH {"token":"${tokens[id]}"} 列一下目录。`, index + 1)
      )
    );
    for (const result of results) expect(result).toMatchObject({ settled: true, completed: true });
    expect(hostChildren()).toHaveLength(1);
    expect(dshHostSupervisor.status()).toMatchObject({
      state: 'ready',
      generation: 1,
      channels: 3,
      pid: hostChildren()[0].pid,
    });
    expect(manager.getSlotSnapshots().map((slot) => [slot.logicalSessionId, slot.state])).toEqual([
      ['s1', 'ready'],
      ['s2', 'ready'],
      ['s3', 'ready'],
    ]);
  }, 180_000);

  it('recovers every session after the host is SIGKILLed, a tool call in flight', async () => {
    const sleeper = `P13ASLEEP${Date.now() % 100_000}`;
    const from = events.length;
    attempt += 1;
    const inFlight = await manager.send({
      sessionId: 's3',
      attemptId: `attempt-${attempt}`,
      text: `P0-SLEEPTOOL {"token":"${sleeper}","seconds":20} 跑一个慢命令。`,
      ownerWebContentsId: 3,
    });
    expect(
      await until(() => forSession('s3', from).some((e) => e.type === 'tool.started'), 60_000)
    ).toBe(true);
    expect(await until(() => processesWith(`sleep-tool ${sleeper}`).length > 0, 15_000)).toBe(true);
    const [host] = liveHosts();
    const killedAt = events.length;
    host.kill('SIGKILL');
    const tookMs = await recovered(['s1', 's2', 's3'], killedAt, 60_000);
    console.log(`[p1-3a] SIGKILL: all three sessions resumed and idle ${tookMs} ms after the kill`);
    expect(tookMs).toBeGreaterThanOrEqual(0);
    for (const id of ['s1', 's2', 's3']) {
      const types = forSession(id, killedAt).map((e) =>
        e.type === 'session.status' ? `status:${String(e.payload?.status)}` : e.type
      );
      const disconnected = types.indexOf('status:disconnected');
      expect(disconnected, id).toBeGreaterThanOrEqual(0);
      expect(types.indexOf('session.resumed'), id).toBeGreaterThan(disconnected);
      expect(types.includes('session.failed'), id).toBe(id === 's3');
    }
    // The turn cut short is reported as failed, under its own request id.
    expect(
      forSession('s3', killedAt).some(
        (e) => e.type === 'session.failed' && e.requestId === inFlight
      )
    ).toBe(true);
    expect(
      manager.getSlotSnapshots().map((slot) => [slot.logicalSessionId, slot.state, slot.generation])
    ).toEqual([
      ['s1', 'ready', 2],
      ['s2', 'ready', 2],
      ['s3', 'ready', 2],
    ]);
    expect(manager.getStatus().state).toBe('ready');
    // One restart, one live host, no tool left running from the dead one.
    expect(hostChildren()).toHaveLength(2);
    expect(liveHosts()).toHaveLength(1);
    expect(dshHostSupervisor.status()).toMatchObject({
      state: 'ready',
      generation: 2,
      channels: 3,
      lastExit: { reason: 'crashed', signal: 'SIGKILL', generation: 1 },
    });
    expect(await until(() => processesWith(`sleep-tool ${sleeper}`).length === 0, 2_000)).toBe(
      true
    );

    // Each session runs again, with its earlier turn in the model's context.
    const recalls = await Promise.all(
      ['s1', 's2', 's3'].map((id, index) =>
        turn(
          id,
          `P0-RECALL ${JSON.stringify({ markers: [`crash-probe ${tokens[id]}`, `P0-CRASH ${tokens[id]} finished`] })}`,
          index + 1
        )
      )
    );
    for (const recall of recalls) {
      expect(recall).toMatchObject({ settled: true, completed: true });
      expect(recall.reply).toContain('missing=-');
    }
  }, 240_000);

  it('kills a SIGSTOPped host on its heartbeat and recovers every session', async () => {
    const [host] = liveHosts();
    const stoppedAt = events.length;
    const started = Date.now();
    host.kill('SIGSTOP');
    expect(await until(() => dshHostSupervisor.status().lastExit?.reason === 'hung', 40_000)).toBe(
      true
    );
    const detectedMs = Date.now() - started;
    const tookMs = await recovered(['s1', 's2', 's3'], stoppedAt, 60_000);
    console.log(
      `[p1-3a] SIGSTOP: judged hung and killed after ${detectedMs} ms; every session idle ${tookMs} ms later`
    );
    expect(detectedMs).toBeLessThan(30_000);
    expect(tookMs).toBeGreaterThanOrEqual(0);
    expect(host.signalCode).toBe('SIGKILL');
    expect(manager.getSlotSnapshots().map((slot) => [slot.state, slot.generation])).toEqual([
      ['ready', 3],
      ['ready', 3],
      ['ready', 3],
    ]);
    expect(liveHosts()).toHaveLength(1);
    expect(dshHostSupervisor.status()).toMatchObject({ state: 'ready', generation: 3 });
    const after = await turn('s1', 'P0-STREAM: stream a paragraph back to me.', 1);
    expect(after).toMatchObject({ settled: true, completed: true });
  }, 180_000);

  it('closing a session right after its turn leaves the host and the others alone', async () => {
    await manager.createSession({
      sessionId: 's4',
      workspacePath: workspace,
      ownerWebContentsId: 4,
    });
    const done = await turn('s4', 'P0-TOOL: list the workspace.', 4);
    expect(done).toMatchObject({ settled: true, completed: true });
    const linesBefore = hostLines.length;
    await manager.closeSession('s4');
    await sleep(1_500);
    const warnings = hostLines.slice(linesBefore).filter((line) => /closed handle/.test(line));
    console.log(
      `[p1-3a] dispose right after a turn: ${warnings.length} projection-cache warning(s)`
    );
    for (const line of warnings) console.log(`[p1-3a]   ${line.slice(0, 300)}`);
    expect(dshHostSupervisor.status()).toMatchObject({
      state: 'ready',
      generation: 3,
      channels: 3,
    });
    const other = await turn('s2', 'P0-STREAM: stream a paragraph back to me.', 2);
    expect(other).toMatchObject({ settled: true, completed: true });
  }, 180_000);
});
