import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ExperimentHost,
  type ExperimentSession,
  type FakeGateway,
  openSession,
  readyOrFatal,
  replyText,
  startExperimentHost,
  startFakeGateway,
  stopExperimentHost,
  stopFakeGateway,
} from '../tools/lib/experiment-host.ts';
import { fakeGatewayPlan, type Message } from '../tools/lib/hostClient.ts';
import { baseEnv, sandbox } from '../tools/lib/kit.ts';

/**
 * dsh-rebase decisions 201 and 203 on a real host: the scope of `worker.stop`
 * with a background subagent running, driven by the local fake gateway's
 * `P1-SUBSTOP` script (the parent delegates in the background, then sleeps in
 * the foreground; the child sleeps six seconds and writes a marker file).
 *
 *   AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run \
 *     src/dsh-host/__tests__/stopScope.integration.test.ts
 *
 * Opt-in: one real host (200-350 MB); run it alone. Every model request goes
 * to the fake gateway.
 *
 * - [201-I-1] `scope: 'turn'` mid-turn: the parent turn stops, the child is not
 *   interrupted, its command runs to the end, its lane settles `completed`, and
 *   its settlement notice wakes the parent into a turn that answers.
 * - [201-I-2] A Stop without a scope (`all`): the child is interrupted, its
 *   command never finishes, and its lane does not settle `completed`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = resolve(HERE, '..');
const REPO = resolve(HOST_DIR, '..', '..');
const BUNDLED_NODE = join(
  REPO,
  'out-node-runtime',
  process.platform === 'win32' ? 'node.exe' : 'node'
);
const NODE = existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath;
const enabled =
  process.env.AICLIENT_DSH_INTEGRATION === '1' &&
  (process.platform === 'linux' || process.platform === 'win32') &&
  existsSync(join(HOST_DIR, 'node_modules', '@deepseek-ai', 'dsh-app-boot'));

const payloadOf = (event: Message): Message => (event.payload ?? {}) as Message;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** What a Windows host needs from the launch environment (the capture scripts pass the same). */
function platformEnv(): Record<string, string> {
  if (process.platform !== 'win32') return {};
  const names = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'SystemDrive'];
  return Object.fromEntries(
    names.flatMap((name) => (process.env[name] ? [[name, process.env[name] as string]] : []))
  );
}

/** Polls `check` until it holds or `timeoutMs` passes. */
async function eventually(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(250);
  }
  return check();
}

describe.skipIf(!enabled)('decisions 201/203 stop scope on a real host', () => {
  let root = '';
  let gateway: FakeGateway | undefined;
  let host: ExperimentHost | undefined;
  let session: ExperimentSession | undefined;
  let workspace = '';

  beforeAll(async () => {
    root = mkdtempSync(
      join(process.platform === 'win32' ? tmpdir() : '/var/tmp', 'aiclient-dsh-stopscope-')
    );
    gateway = await startFakeGateway(NODE, join(HOST_DIR, 'tools', 'fake-gateway.mjs'), root);
    const box = sandbox(root, 'stop-scope');
    workspace = box.workspace;
    host = startExperimentHost({
      label: 'stop-scope',
      nodeBin: NODE,
      entry: join(HOST_DIR, 'host.ts'),
      cwd: box.workspace,
      env: {
        ...baseEnv(box),
        ...platformEnv(),
        USERPROFILE: box.home,
        TEMP: box.tmp,
        TMP: box.tmp,
        DSH_HOME: box.dshHome,
        DSH_TELEMETRY_DISABLED: '1',
        AICLIENT_DSH_PROBE_BUNDLE: '0',
      },
      plan: fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${gateway.port}` }),
      key: 'stop-scope-fake-key',
    });
    const ready = await readyOrFatal(host);
    if (ready?.type !== 'ready') {
      throw new Error(`host did not start: ${JSON.stringify(ready)}\n${host.stderr()}`);
    }
    session = await openSession(host, {
      logicalSessionId: 'stop-scope-chat',
      cwd: box.workspace,
    });
  }, 120_000);

  afterAll(async () => {
    if (host) await stopExperimentHost(host);
    if (gateway) await stopFakeGateway(gateway);
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  /**
   * Sends `P1-SUBSTOP tag=<tag>`, waits until the parent sleeps in the
   * foreground and the child's command started, then stops with `scope`.
   * Returns the channel index the turn began at and the delegation's call id.
   */
  async function stopMidTurn(
    tag: string,
    scope: 'turn' | undefined
  ): Promise<{ from: number; delegation: string; requestId: string }> {
    if (!host || !session) throw new Error('no host');
    const { client } = host;
    const requestId = `stop-scope-${tag}`;
    const from = client.events(session.ch).length;
    await client.request(session.ch, 'worker.send', {
      logicalSessionId: session.logicalSessionId,
      requestId,
      attemptId: `${requestId}-attempt`,
      text: `P1-SUBSTOP tag=${tag}: delegate in the background, then sleep.`,
    });
    const since = () => client.events(session?.ch ?? '').slice(from);
    const parentTools = () =>
      since().filter((event) => event.type === 'tool.started' && event.requestId === requestId);
    const childBash = () =>
      since().some(
        (event) =>
          event.type === 'subagent.activity' &&
          payloadOf(event).kind === 'tool.started' &&
          payloadOf(event).name === 'bash'
      );
    const ready = await client.until(
      session.ch,
      () => parentTools().some((event) => payloadOf(event).name === 'bash') && childBash(),
      60_000
    );
    expect(ready, 'parent sleeper and child command both started').toBe(true);
    const delegation = String(
      payloadOf(parentTools().find((event) => payloadOf(event).name === 'subagent') ?? {})
        .toolCallId ?? ''
    );
    expect(delegation).not.toBe('');
    await sleep(500);
    await client.request(session.ch, 'worker.stop', {
      logicalSessionId: session.logicalSessionId,
      reason: 'user',
      ...(scope ? { scope } : {}),
    });
    const stopped = await client.until(
      session.ch,
      (events) =>
        events
          .slice(from)
          .some(
            (event) =>
              event.requestId === requestId &&
              (event.type === 'session.stopped' ||
                (event.type === 'session.status' && payloadOf(event).status === 'idle'))
          ),
      30_000
    );
    expect(stopped, 'the parent turn stopped').toBe(true);
    return { from, delegation, requestId };
  }

  /** The lane's terminal statuses for delegation `delegation` since `from`. */
  function laneStatuses(from: number, delegation: string): string[] {
    if (!host || !session) return [];
    return host.client
      .events(session.ch)
      .slice(from)
      .filter(
        (event) =>
          event.type === 'subagent.activity' &&
          payloadOf(event).parentToolCallId === delegation &&
          payloadOf(event).kind === 'status'
      )
      .map((event) => String(payloadOf(event).status));
  }

  it('[201-I-1] a turn-scoped stop leaves the background subagent running', async () => {
    if (!host || !session) throw new Error('no host');
    const { client } = host;
    const { from, delegation, requestId } = await stopMidTurn('turn', 'turn');
    const marker = join(workspace, 'substop-turn.txt');
    // The child sleeps six seconds from its start; give it room.
    expect(await eventually(() => existsSync(marker), 30_000), 'child command finished').toBe(true);
    expect(
      await eventually(() => laneStatuses(from, delegation).includes('completed'), 30_000),
      `lane settled completed: ${laneStatuses(from, delegation).join(',')}`
    ).toBe(true);
    // The settlement wakes the parent into a turn nobody sent, which answers.
    const wake = () =>
      client
        .events(session?.ch ?? '')
        .slice(from)
        .filter(
          (event) =>
            event.type === 'session.status' &&
            payloadOf(event).status === 'idle' &&
            String(event.requestId ?? '').startsWith('dsh-turn-')
        )
        .map((event) => String(event.requestId));
    expect(await eventually(() => wake().length > 0, 60_000), 'wake turn went idle').toBe(true);
    const wakeId = wake()[0];
    const wakeEvents = client
      .events(session.ch)
      .slice(from)
      .filter((event) => event.requestId === wakeId);
    expect(replyText(wakeEvents)).toContain('The stop-scope subagent reported back.');
    // The stopped turn never ran to its own end.
    const stoppedReply = replyText(
      client
        .events(session.ch)
        .slice(from)
        .filter((event) => event.requestId === requestId)
    );
    expect(stoppedReply).not.toContain('The parent turn ran to its end.');
  }, 180_000);

  it('[201-I-2] a stop without a scope interrupts the background subagent', async () => {
    if (!host || !session) throw new Error('no host');
    const { from, delegation } = await stopMidTurn('all', undefined);
    const marker = join(workspace, 'substop-all.txt');
    // Well past the child's six-second command.
    await sleep(12_000);
    expect(existsSync(marker), 'child command was cut short').toBe(false);
    const statuses = laneStatuses(from, delegation);
    expect(statuses.length, `lane settled: ${statuses.join(',')}`).toBeGreaterThan(0);
    expect(statuses).not.toContain('completed');
  }, 180_000);
});
