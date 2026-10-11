import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_CONTENT_BLOCKS_ENV } from '../../shared/types/requestScope.ts';
import {
  compactSession,
  type FakeGateway,
  openSession,
  readyOrFatal,
  sendTurn,
  startExperimentHost,
  startFakeGateway,
  stopExperimentHost,
  stopFakeGateway,
} from '../tools/lib/experiment-host.ts';
import { fakeGatewayPlan } from '../tools/lib/hostClient.ts';
import { baseEnv, sandbox } from '../tools/lib/kit.ts';
import {
  buildPrefixChains,
  type CapturedRequest,
  isAnthropicMessagesCapture,
  lastCapturedSeq,
  loadCapturedRequests,
  requestPurposeOf,
} from '../tools/lib/prefixChain.ts';

/**
 * dsh-rebase decision 182 (DA-3) on a real host: every user message of every
 * anthropic-messages request goes out as a text-block array, so a turn's
 * input keeps one form from its first step to the next.
 *
 *   AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run \
 *     src/dsh-host/__tests__/userContentBlocks.integration.test.ts
 *
 * Opt-in: two real hosts one after the other (200-350 MB each) and the local
 * fake gateway (plan dsh-p0-2, every request captured); run it alone on the
 * dev box. Needs out-node-runtime/node and `npm ci` in src/dsh-host. Every
 * model request goes to the fake gateway; signals only ever go to children
 * this file spawned.
 *
 * One session on the default route (`fake-1`, anthropic-messages): a tool
 * turn (two steps), a text turn, then `/compact`.
 *
 * - [182-I-1] As shipped: no captured request has a string user content, the
 *   second step of the tool turn repeats the first byte for byte (cache marks
 *   aside) up to its end, and the host logs no prefix divergence.
 * - [182-I-2] With AICLIENT_RUNTIME_USER_CONTENT_BLOCKS=0: pi-ai's own bodies,
 *   where the input goes from a marked block to a string, and the prefix
 *   watch names it (`at=message-form`): the monitor the fix is checked by.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = resolve(HERE, '..');
const REPO = resolve(HOST_DIR, '..', '..');
const NODE = join(REPO, 'out-node-runtime', 'node');
const enabled =
  process.env.AICLIENT_DSH_INTEGRATION === '1' &&
  process.platform === 'linux' &&
  existsSync(NODE) &&
  existsSync(join(HOST_DIR, 'node_modules', '@deepseek-ai', 'dsh-app-boot'));

/** pi-ai's cache mark, at any depth, as JSON text writes it after another key. */
const MARK_JSON = /,"cache_control":\{[^{}]*\}/g;

type Body = { messages: Array<{ role?: unknown; content?: unknown }> };

interface Flow {
  /** The flow's anthropic-messages requests, in order. */
  requests: CapturedRequest[];
  stderr: string[];
}

function bodyOf(request: CapturedRequest): Body {
  return JSON.parse(request.body) as Body;
}

/** Where every user message whose content is a string sits, as `<seq>:<index>`. */
function stringUserContents(requests: readonly CapturedRequest[]): string[] {
  return requests.flatMap((request) =>
    bodyOf(request).messages.flatMap((message, index) =>
      message.role === 'user' && typeof message.content === 'string'
        ? [`${request.seq}:${index}`]
        : []
    )
  );
}

describe.skipIf(!enabled)('decision 182 on a real host', () => {
  let root = '';
  let capture = '';
  let gateway: FakeGateway | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join('/var/tmp', 'aiclient-dsh-ucb-'));
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

  /** One host: a tool turn, a text turn and `/compact` in one session; then the host stops. */
  async function flow(label: string, env: Record<string, string> = {}): Promise<Flow> {
    if (!gateway) throw new Error('no gateway');
    const baseUrl = `http://127.0.0.1:${gateway.port}`;
    const box = sandbox(root, label);
    const from = lastCapturedSeq(capture);
    const host = startExperimentHost({
      label,
      nodeBin: NODE,
      entry: join(HOST_DIR, 'host.ts'),
      cwd: box.workspace,
      env: {
        ...baseEnv(box),
        DSH_HOME: box.dshHome,
        DSH_TELEMETRY_DISABLED: '1',
        AICLIENT_DSH_PROBE_BUNDLE: '0',
        ...env,
      },
      plan: fakeGatewayPlan({ baseUrl }),
      key: `${label}-fake-key`,
    });
    try {
      const ready = await readyOrFatal(host);
      if (ready?.type !== 'ready') {
        throw new Error(`host did not start: ${JSON.stringify(ready)}\n${host.stderr()}`);
      }
      const session = await openSession(host, {
        logicalSessionId: `${label}-chat`,
        cwd: box.workspace,
      });
      const tool = await sendTurn(host, session, {
        requestId: `${label}-1`,
        text: 'P0-TOOL: list the workspace.',
      });
      expect(tool.idle).toBe(true);
      const stream = await sendTurn(host, session, {
        requestId: `${label}-2`,
        text: 'P0-STREAM: stream a paragraph back to me.',
      });
      expect(stream.idle).toBe(true);
      const compacted = await compactSession(host, session);
      expect(compacted.ok, JSON.stringify(compacted)).toBe(true);
    } finally {
      await stopExperimentHost(host);
    }
    const requests = loadCapturedRequests(capture)
      .requests.filter((request) => request.seq > from && isAnthropicMessagesCapture(request))
      .sort((a, b) => a.seq - b.seq);
    return { requests, stderr: host.stderrLines() };
  }

  it('[182-I-1] sends every user message as blocks, and a step repeats the one before it', async () => {
    const { requests, stderr } = await flow('ucb-on');
    expect(stderr).toContain(
      '[dsh-host] request tap: session metadata on, prefix watch on, user content blocks on'
    );
    const purposes = requests.map((request) => requestPurposeOf(bodyOf(request)));
    // Two steps of the tool turn, one of the text turn, the summary.
    expect(purposes).toEqual(['agent', 'agent', 'agent', 'compaction']);
    expect(stringUserContents(requests)).toEqual([]);

    // The tool turn's second step: its first step's bytes up to their end, marks aside.
    const [first, second] = requests.map((request) => request.body.replace(MARK_JSON, ''));
    const messages = JSON.stringify(JSON.parse(String(first)).messages);
    const shared = String(first).slice(0, String(first).indexOf(messages) + messages.length - 1);
    expect(String(second).startsWith(`${shared},`)).toBe(true);

    // On the host's own rules every lane only grows, and the host said nothing.
    const chains = buildPrefixChains(requests, { byPurpose: true });
    expect(chains.requests.map((request) => request.verdict?.kind)).toEqual([
      'first',
      'append',
      'append',
      'first',
    ]);
    expect(stderr.filter((line) => line.includes('prefix-watch:'))).toEqual([]);
  }, 300_000);

  it('[182-I-2] with the switch off, pi-ai turns the input into a string, and the watch says so', async () => {
    const { requests, stderr } = await flow('ucb-off', { [USER_CONTENT_BLOCKS_ENV]: '0' });
    expect(stderr).toContain(
      '[dsh-host] request tap: session metadata on, prefix watch on, user content blocks off'
    );
    expect(stringUserContents(requests).length).toBeGreaterThan(0);
    const chains = buildPrefixChains(requests, { byPurpose: true });
    const [, second] = chains.requests;
    expect(second?.verdict).toMatchObject({
      kind: 'diverged',
      at: 'message-form',
      role: 'user',
      form: 'string',
    });
    expect(
      stderr.some((line) =>
        /\[dsh-host\] prefix-watch: .* req=2 verdict=diverged at=message-form index=\d+\/\d+ role=user form=string$/.test(
          line
        )
      )
    ).toBe(true);
  }, 300_000);
});
