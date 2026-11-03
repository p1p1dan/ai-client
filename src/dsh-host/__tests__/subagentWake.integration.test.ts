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
 * Decision 207 §8 item 5, §14 F on a real host: since DSH 0.2.1 a continuable
 * subagent is told to `send_message` its result to its parent before it
 * finishes, so one child can wake an idle parent twice — its message, then its
 * settlement notice. Driven by the fake gateway's `P1-WAKE2` / `P1-WAKE2CHILD`.
 *
 *   AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run \
 *     src/dsh-host/__tests__/subagentWake.integration.test.ts
 *
 * Opt-in: one real host (200-350 MB); run it alone. Every model request goes
 * to the fake gateway.
 *
 * - [207-WAKE-1] After the user's turn: a wake turn headed `agent-message`
 *   (the child's message), then the lane settles `completed`, then a wake turn
 *   headed `subagent` (the settlement) — exactly two, in that order.
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

describe.skipIf(!enabled)('decision 207 §8: a subagent wakes its idle parent twice', () => {
  let root = '';
  let gateway: FakeGateway | undefined;
  let host: ExperimentHost | undefined;
  let session: ExperimentSession | undefined;

  beforeAll(async () => {
    root = mkdtempSync(
      join(process.platform === 'win32' ? tmpdir() : '/var/tmp', 'aiclient-dsh-wake2-')
    );
    gateway = await startFakeGateway(NODE, join(HOST_DIR, 'tools', 'fake-gateway.mjs'), root);
    const box = sandbox(root, 'wake2');
    host = startExperimentHost({
      label: 'wake2',
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
      key: 'wake2-fake-key',
    });
    const ready = await readyOrFatal(host);
    if (ready?.type !== 'ready') {
      throw new Error(`host did not start: ${JSON.stringify(ready)}\n${host.stderr()}`);
    }
    session = await openSession(host, { logicalSessionId: 'wake2-chat', cwd: box.workspace });
  }, 120_000);

  afterAll(async () => {
    if (host) await stopExperimentHost(host);
    if (gateway) await stopFakeGateway(gateway);
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('[207-WAKE-1] the message wakes it first, the settlement second, each its own turn', async () => {
    if (!host || !session) throw new Error('no host');
    const { client } = host;
    const ch = session.ch;
    const requestId = 'wake2-user';
    const from = client.events(ch).length;
    await client.request(ch, 'worker.send', {
      logicalSessionId: session.logicalSessionId,
      requestId,
      attemptId: `${requestId}-attempt`,
      text: 'P1-WAKE2: delegate a continuable subagent.',
    });
    const since = () => client.events(ch).slice(from);
    const idleOf = (id: string) => (event: Message) =>
      event.type === 'session.status' &&
      payloadOf(event).status === 'idle' &&
      event.requestId === id;
    /** The turns DSH started by itself, in the order they went idle. */
    const wakeTurns = () => [
      ...new Set(
        since()
          .filter(
            (event) =>
              event.type === 'session.status' &&
              payloadOf(event).status === 'idle' &&
              String(event.requestId ?? '').startsWith('dsh-turn-')
          )
          .map((event) => String(event.requestId))
      ),
    ];

    expect(
      await eventually(() => since().some(idleOf(requestId)), 60_000),
      "the user's turn went idle"
    ).toBe(true);
    expect(
      await eventually(() => wakeTurns().length >= 2, 60_000),
      `two wake turns went idle: ${wakeTurns().join(',')}`
    ).toBe(true);
    // No third one behind them.
    await sleep(5_000);
    const turns = wakeTurns();
    expect(turns).toHaveLength(2);
    const [first, second] = turns as [string, string];

    const events = since();
    const at = (predicate: (event: Message) => boolean) => events.findIndex(predicate);
    const headOf = (id: string) =>
      events.find(
        (event) =>
          event.type === 'message.started' &&
          event.requestId === id &&
          payloadOf(event).role === 'user'
      );
    const firstHead = headOf(first);
    const secondHead = headOf(second);
    const firstOrigin = payloadOf(firstHead ?? {}).origin as Message | undefined;
    const secondOrigin = payloadOf(secondHead ?? {}).origin as Message | undefined;
    expect(firstOrigin?.kind).toBe('agent-message');
    expect(String(firstOrigin?.childSessionId ?? '')).not.toBe('');
    expect(secondOrigin?.kind).toBe('subagent');

    // The first head quotes what the child sent.
    const firstHeadId = payloadOf(firstHead ?? {}).messageId;
    const firstHeadText = events
      .filter(
        (event) => event.type === 'message.delta' && payloadOf(event).messageId === firstHeadId
      )
      .map((event) => String(payloadOf(event).text ?? ''))
      .join('');
    expect(firstHeadText).toContain('wake2 interim finding');

    // Each wake is answered by what woke it.
    expect(replyText(events.filter((event) => event.requestId === first))).toContain(
      'heard the interim report'
    );
    expect(replyText(events.filter((event) => event.requestId === second))).toContain(
      'heard the settlement'
    );

    // The order: user turn idle → first wake idle → lane completed → second wake opens.
    const userIdle = at(idleOf(requestId));
    const firstIdle = at(idleOf(first));
    const laneCompleted = at(
      (event) =>
        event.type === 'subagent.activity' &&
        payloadOf(event).kind === 'status' &&
        payloadOf(event).status === 'completed'
    );
    const secondOpens = events.indexOf(secondHead as Message);
    expect(userIdle).toBeGreaterThanOrEqual(0);
    expect(firstIdle, 'first wake after the user turn').toBeGreaterThan(userIdle);
    expect(laneCompleted, 'lane settles after the first wake').toBeGreaterThan(firstIdle);
    expect(secondOpens, 'second wake after the lane settled').toBeGreaterThan(laneCompleted);

    // Neither arrived as a notice inside another turn.
    const notices = events.filter(
      (event) =>
        event.type === 'custom.message' &&
        /wake2 interim finding|Background subagent/.test(String(payloadOf(event).content ?? ''))
    );
    expect(notices).toEqual([]);
  }, 180_000);
});
