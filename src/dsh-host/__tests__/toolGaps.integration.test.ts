import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type FakeGateway,
  openSession,
  readyOrFatal,
  sendTurn,
  startExperimentHost,
  startFakeGateway,
  stopExperimentHost,
  stopFakeGateway,
} from '../tools/lib/experiment-host.ts';
import { fakeGatewayPlan, type Message } from '../tools/lib/hostClient.ts';
import { baseEnv, sandbox } from '../tools/lib/kit.ts';
import {
  type CapturedRequest,
  isAnthropicMessagesCapture,
  lastCapturedSeq,
  loadCapturedRequests,
} from '../tools/lib/prefixChain.ts';

/**
 * dsh-rebase decision 190 on a real host: the product composition's grep and
 * web_fetch, each with its switch on and off, driven by the local fake
 * gateway's `P1-TOOLGAPS` script through the permission row as Main uses it.
 *
 *   AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run \
 *     src/dsh-host/__tests__/toolGaps.integration.test.ts
 *
 * Opt-in: two real hosts one after the other (200-350 MB each); run it alone.
 * Runs on Linux and Windows, with out-node-runtime/node when it is there and
 * this Node otherwise. Every model request goes to the fake gateway; the
 * fetch never leaves the machine, because its card is answered `deny`.
 *
 * One session in `ask` (Main's default), one turn: grep in content mode with
 * `-C 1`, a case-folded file list whose `.env` hit the permission row drops,
 * then `web_fetch`.
 *
 * - [190-I-1] As shipped: our grep's output, the filter at work, and a
 *   web_fetch card naming the host; the model is offered both tools.
 * - [190-I-2] With AICLIENT_RUNTIME_RICH_GREP=0 and AICLIENT_RUNTIME_WEB_FETCH=0:
 *   DSH's three-argument grep (its own output, no hidden files, no case
 *   folding) and no web_fetch at all, as before decision 190.
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

const URL_FETCHED = 'https://example.com/tool-gaps';
const payloadOf = (event: Message): Message => (event.payload ?? {}) as Message;
const p = (rel: string) => rel.split('/').join(process.platform === 'win32' ? '\\' : '/');

/** What a Windows host needs from the launch environment (the capture scripts pass the same). */
function platformEnv(): Record<string, string> {
  if (process.platform !== 'win32') return {};
  const names = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'SystemDrive'];
  return Object.fromEntries(
    names.flatMap((name) => (process.env[name] ? [[name, process.env[name] as string]] : []))
  );
}

interface Flow {
  /** `tool.completed` payloads of the turn, in order. */
  results: Message[];
  /** `permission.requested` payloads of the turn, each answered `deny`. */
  cards: Message[];
  requests: CapturedRequest[];
  stderr: string[];
  /** The rows whose `disabled` is a `!!js` expression, as `ready` reports them. */
  disabledByExpression: string[];
}

describe.skipIf(!enabled)('decision 190 on a real host', () => {
  let root = '';
  let capture = '';
  let gateway: FakeGateway | undefined;

  beforeAll(async () => {
    root = mkdtempSync(
      join(process.platform === 'win32' ? tmpdir() : '/var/tmp', 'aiclient-dsh-gaps-')
    );
    capture = join(root, 'capture');
    mkdirSync(capture, { recursive: true, mode: 0o700 });
    gateway = await startFakeGateway(NODE, join(HOST_DIR, 'tools', 'fake-gateway.mjs'), root, {
      capture,
    });
  }, 60_000);

  afterAll(async () => {
    if (gateway) await stopFakeGateway(gateway);
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  /**
   * One host and one turn. `decision` answers every card: `deny` wherever the
   * fetch is real, since an allowed one would reach the internet.
   */
  async function flow(
    label: string,
    env: Record<string, string> = {},
    decision: 'deny' | 'allow' = 'deny'
  ): Promise<Flow> {
    if (!gateway) throw new Error('no gateway');
    const box = sandbox(root, label);
    mkdirSync(join(box.workspace, 'src'), { recursive: true });
    writeFileSync(join(box.workspace, 'src', 'a.ts'), 'one\nGAP-MARK two\nthree\n');
    writeFileSync(join(box.workspace, 'notes.md'), 'a Gap-Secret note\n');
    writeFileSync(join(box.workspace, '.env'), 'GAP-SECRET=1\n');
    const from = lastCapturedSeq(capture);
    const host = startExperimentHost({
      label,
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
        ...env,
      },
      plan: fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${gateway.port}` }),
      key: `${label}-fake-key`,
    });
    const cards: Message[] = [];
    let results: Message[] = [];
    let disabledByExpression: string[] | undefined;
    try {
      const ready = await readyOrFatal(host);
      if (ready?.type !== 'ready') {
        throw new Error(`host did not start: ${JSON.stringify(ready)}\n${host.stderr()}`);
      }
      // Every row the composition turns on came up (the packaged smoke's own check).
      expect((ready.census as { inactive?: unknown } | undefined)?.inactive).toEqual([]);
      disabledByExpression = (ready.composition as { disabledByExpression?: string[] })
        .disabledByExpression;
      const session = await openSession(host, {
        logicalSessionId: `${label}-chat`,
        cwd: box.workspace,
        permissions: { mode: 'agent', gear: 'ask' },
      });
      const requestId = `${label}-1`;
      const turn = await sendTurn(host, session, {
        requestId,
        text: 'P1-TOOLGAPS: exercise the tool gaps.',
        during: async (start) => {
          const { client } = host;
          const idle = (events: Message[]) =>
            events
              .slice(start)
              .some(
                (event) =>
                  event.type === 'session.status' &&
                  payloadOf(event).status === 'idle' &&
                  event.requestId === requestId
              );
          const waiting = (events: Message[]) =>
            events
              .slice(start)
              .filter(
                (event) =>
                  event.type === 'permission.requested' &&
                  !cards.some((card) => card.permissionId === payloadOf(event).permissionId)
              );
          for (;;) {
            const woke = await client.until(
              session.ch,
              (events) => idle(events) || waiting(events).length > 0,
              120_000
            );
            for (const card of waiting(client.events(session.ch))) {
              const payload = payloadOf(card);
              cards.push(payload);
              await client.request(session.ch, 'worker.permission.respond', {
                logicalSessionId: session.logicalSessionId,
                permissionId: payload.permissionId,
                decision,
              });
            }
            if (!woke || idle(client.events(session.ch))) return;
          }
        },
      });
      expect(turn.idle).toBe(true);
      expect(turn.reply).toContain('P1-TOOLGAPS finished.');
      results = turn.events
        .filter((event) => event.type === 'tool.completed')
        .map((event) => payloadOf(event));
    } finally {
      await stopExperimentHost(host);
    }
    const requests = loadCapturedRequests(capture)
      .requests.filter((request) => request.seq > from && isAnthropicMessagesCapture(request))
      .sort((a, b) => a.seq - b.seq);
    return {
      results,
      cards,
      requests,
      stderr: host.stderrLines(),
      disabledByExpression: disabledByExpression ?? [],
    };
  }

  /** The tools the model was offered in the turn's first request. */
  function offered(requests: readonly CapturedRequest[]): Map<string, string[]> {
    const body = JSON.parse(String(requests[0]?.body)) as {
      tools: Array<{ name: string; input_schema?: { properties?: Record<string, unknown> } }>;
    };
    return new Map(
      body.tools.map((tool) => [tool.name, Object.keys(tool.input_schema?.properties ?? {})])
    );
  }

  it('[190-I-1] as shipped: our grep, the filter at work, a web_fetch card for the host', async () => {
    const { results, cards, requests, stderr, disabledByExpression } = await flow('gaps-on');
    expect(stderr).toContain('[dsh-host] tool switches: web_fetch on, grep rich');
    // The three web rows carry the switch as their `disabled` expression.
    expect(disabledByExpression).toEqual(
      expect.arrayContaining(['web', 'web-fetch-http', 'tool-web'])
    );
    const tools = offered(requests);
    expect(tools.get('web_fetch')).toEqual(['url']);
    expect(tools.get('grep')).toEqual([
      'pattern',
      'path',
      'glob',
      'type',
      'output_mode',
      '-A',
      '-B',
      '-C',
      '-n',
      '-i',
      'multiline',
      'head_limit',
      'offset',
    ]);
    expect(tools.has('web_search')).toBe(false);

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      ok: true,
      output: [
        'Found 1 matching line in 1 file',
        '',
        `${p('src/a.ts')}-1-one`,
        `${p('src/a.ts')}:2:GAP-MARK two`,
        `${p('src/a.ts')}-3-three`,
      ].join('\n'),
    });
    // `.env` matched too (hidden files are searched); the permission row dropped it.
    expect(results[1]).toMatchObject({ ok: true, output: 'Found 1 file\n\nnotes.md' });
    // One card, for the fetch only; denied, so nothing left the machine.
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      toolName: 'web_fetch',
      action: 'fetch_url',
      kind: 'tool',
      input: { content: URL_FETCHED, contentLabel: 'URL' },
      sessionGrantScope: { kind: 'host', value: 'example.com' },
      decisions: ['allow', 'allow_session', 'deny'],
    });
    expect(results[2]?.ok).toBe(false);
  }, 240_000);

  it('[190-I-2] both switches off: DSH’s own grep and no web_fetch, as before', async () => {
    // Allowed: with the switch off there is no fetch tool to reach the internet with.
    const { results, cards, requests, stderr } = await flow(
      'gaps-off',
      { AICLIENT_RUNTIME_RICH_GREP: '0', AICLIENT_RUNTIME_WEB_FETCH: '0' },
      'allow'
    );
    expect(stderr).toContain(
      '[dsh-host] tool switches: web_fetch off (AICLIENT_RUNTIME_WEB_FETCH=0), grep dsh (AICLIENT_RUNTIME_RICH_GREP=0)'
    );
    const tools = offered(requests);
    expect(tools.has('web_fetch')).toBe(false);
    expect(tools.get('grep')).toEqual(['pattern', 'path', 'include']);

    expect(results).toHaveLength(3);
    // DSH's grep: its own shape; the extra arguments mean nothing to it.
    expect(results[0]).toMatchObject({
      ok: true,
      output: `Found 1 match\n\n${p('src/a.ts')}\nLine 2: GAP-MARK two`,
    });
    // No case folding and no hidden files.
    expect(results[1]).toMatchObject({ ok: true, output: 'No matches found' });
    // The model was not offered web_fetch, yet a call to it still meets the
    // gate first (the permission row judges a call by its name before DSH
    // resolves the tool); allowed, DSH then has no such tool.
    expect(cards.map((card) => card.toolName)).toEqual(['web_fetch']);
    expect(results[2]).toMatchObject({ ok: false });
    expect(String(results[2]?.error)).toMatch(/unknown tool "web_fetch"/);
  }, 240_000);
});
